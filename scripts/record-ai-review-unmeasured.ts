#!/usr/bin/env bun
/**
 * Record WHICH kind of unmeasured each UNMEASURED review round was (#1486).
 *
 * ```
 * bun scripts/record-ai-review-unmeasured.ts --repo owner/name --limit 45
 * bun scripts/record-ai-review-unmeasured.ts --repo owner/name --pr 1486 --write
 * ```
 *
 * Reads each pull request's AI-review ledger comment, and for every round it
 * holds that recorded `findings: null`, fetches that round's FULL job log and
 * asks `classifyUnmeasuredRound` which state it was in. Prints the split.
 * With `--write`, splices the readings back into the ledger comment.
 *
 * ## Why this is a script and not a step in the workflow
 *
 * The obvious place is the persist step, which writes the round. It cannot
 * reach the evidence: a later step cannot read an earlier step's stdout
 * (`AI_REVIEW_APP_INSTALL_CAUSE`, #803), the Actions log endpoint does not
 * serve a job that is still running, and `test/ai-review-payload-reading.test.ts`
 * AC-6 forbids the action's skip prose anywhere in the generated script. So
 * the reading is only available from outside the run, after it ends.
 *
 * **And the logs expire.** That is the whole urgency of #1486: each day a
 * round goes unclassified, another population becomes permanently
 * unmeasurable. Run this on the recent window regularly, not once.
 *
 * ## It is a recorder, and it refuses rather than guesses
 *
 *  - the FULL log, never `--log-failed`. The skip line is emitted by a step
 *    that SUCCEEDS, so `--log-failed` returns 0 bytes on a declined run —
 *    measured on run 40047304108. Never the clock either: #1485 has
 *    no-payload runs at 4m11s–5m35s and a real review at 2m16s.
 *  - a log it could not fetch is recorded as `log_unreadable` by name. It is
 *    not "no skip line found", which is the conflation the issue exists to
 *    fix, one level down.
 *  - a ledger `readLedger` refuses is SKIPPED, never rewritten. Replacing a
 *    ledger holding seven rounds with one holding this pass is the worst
 *    thing this can do and is invisible afterwards.
 *  - the spliced body is read back through the real `readLedger` and the
 *    rounds compared before anything is sent. `replaceLedgerJsonBlock` finds
 *    the fence itself and is therefore a second reader of those bytes; this
 *    read-back is what closes it.
 *  - a round that already carries a reading is left alone and costs no
 *    fetch, so a later expiry can never overwrite a reading taken while the
 *    log still existed.
 */

import { spawnSync } from "node:child_process";

import {
  AI_REVIEW_JOB_LOG_READ,
  AI_REVIEW_JOB_LOG_UNREADABLE,
  AI_REVIEW_UNMEASURED_NOT_RECORDED,
  annotateUnmeasuredRounds,
  readRecordedUnmeasuredState,
  replaceLedgerJsonBlock,
  type JobLogReading,
} from "../lib/ai-review-unmeasured.ts";
import {
  AI_REVIEW_LEDGER_COMMENT_MARKER,
  AI_REVIEW_LEDGER_READ,
  AI_REVIEW_LEDGER_ROUNDS_KEY,
  readLedger,
} from "../lib/ai-review-rounds.ts";

/** One exported exit code, so there is a single refusal path to mutate. */
export const RECORD_UNMEASURED_FAILED = 1;

interface Args {
  repo: string;
  prs: number[];
  limit: number;
  write: boolean;
}

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const out: Args = { repo: "", prs: [], limit: 45, write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") out.write = true;
    else if (a === "--repo") out.repo = argv[++i] ?? "";
    else if (a === "--pr") {
      const n = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isSafeInteger(n) || n < 1) return { error: `--pr needs a number, got ${argv[i]}` };
      out.prs.push(n);
    } else if (a === "--limit") {
      const n = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isSafeInteger(n) || n < 1) return { error: `--limit needs a number` };
      out.limit = n;
    } else return { error: `unknown argument ${a}` };
  }
  if (!out.repo) return { error: "--repo owner/name is required" };
  return out;
}

function gh(args: string[], maxBuffer = 256 * 1024 * 1024) {
  return spawnSync("gh", args, { encoding: "utf8", maxBuffer });
}

/** The pull requests to walk: the ones named, else the most recent `limit`. */
function resolvePullRequests(args: Args): number[] | { error: string } {
  if (args.prs.length > 0) return args.prs;
  const r = gh([
    "pr", "list", "--repo", args.repo, "--state", "all",
    "--limit", String(args.limit), "--json", "number", "-q", ".[].number",
  ]);
  if (r.status !== 0) return { error: `gh pr list failed: ${(r.stderr ?? "").trim()}` };
  return (r.stdout ?? "").split("\n").map(s => s.trim()).filter(Boolean).map(Number);
}

/** The ledger comment on a pull request: its id and its body, or null. */
function ledgerComment(repo: string, pr: number): { id: number; body: string } | null {
  const r = gh([
    "api", "--paginate", `repos/${repo}/issues/${pr}/comments`,
    "-q", ".[] | select(.body != null) | {id, body} | @json",
  ]);
  if (r.status !== 0) return null;
  // `@json` through `gh -q` prints the object's JSON text RAW, one per line,
  // so ONE parse. The first draft parsed twice, every line threw, the throw
  // was swallowed, and six pull requests that all have a ledger reported
  // "no ledger comment" — the fail-open shape this repository's own rules
  // open with. A line that will not parse is now counted and named.
  let unparseable = 0;
  for (const line of (r.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    let c: { id: number; body: string };
    try {
      c = JSON.parse(line) as { id: number; body: string };
    } catch {
      unparseable++;
      continue;
    }
    if (typeof c.body === "string" && c.body.includes(AI_REVIEW_LEDGER_COMMENT_MARKER)) return c;
  }
  if (unparseable > 0) {
    console.error(
      `#${pr}: ${unparseable} comment line(s) could not be parsed — a ledger may have ` +
        "been among them, so this pull request's reading is incomplete",
    );
  }
  return null;
}

/**
 * The FULL log for the run a round recorded.
 *
 * `--log`, with the attempt the round recorded. Every failure is an
 * UNREADABLE reading carrying its reason, never an empty string: an empty log
 * is a perfectly good log of a run that was declined.
 */
function fetchJobLog(repo: string, run: unknown, attempt: unknown): JobLogReading {
  if (typeof run !== "string" || !/^[0-9]+$/.test(run)) {
    return {
      status: AI_REVIEW_JOB_LOG_UNREADABLE,
      reason: `the round recorded ${JSON.stringify(run)} as its run id, which is not one`,
    };
  }
  const args = ["run", "view", run, "--repo", repo, "--log"];
  if (typeof attempt === "string" && /^[0-9]+$/.test(attempt)) args.push("--attempt", attempt);
  const r = gh(args);
  if (r.status !== 0) {
    return {
      status: AI_REVIEW_JOB_LOG_UNREADABLE,
      reason: `gh run view ${run} --log exited ${r.status}: ${(r.stderr ?? "").trim().slice(0, 300)}`,
    };
  }
  if (typeof r.stdout !== "string") {
    return { status: AI_REVIEW_JOB_LOG_UNREADABLE, reason: `gh run view ${run} wrote nothing` };
  }
  return { status: AI_REVIEW_JOB_LOG_READ, text: r.stdout };
}

export function main(argv: readonly string[]): number {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`record-ai-review-unmeasured: ${parsed.error}`);
    return RECORD_UNMEASURED_FAILED;
  }
  const prs = resolvePullRequests(parsed);
  if ("error" in prs) {
    console.error(`record-ai-review-unmeasured: ${prs.error}`);
    return RECORD_UNMEASURED_FAILED;
  }

  const totals: Record<string, number> = {};
  let skipped = 0;

  for (const pr of prs) {
    const comment = ledgerComment(parsed.repo, pr);
    if (comment === null) {
      console.log(`#${pr}: no ledger comment`);
      continue;
    }
    const reading = readLedger(comment.body);
    if (reading.status !== AI_REVIEW_LEDGER_READ) {
      // REFUSED, and named. Writing here is the destructive case.
      console.log(`#${pr}: ledger SKIPPED (${reading.status})`);
      skipped++;
      continue;
    }

    const doc = JSON.parse(
      comment.body.slice(
        comment.body.indexOf("\n", comment.body.indexOf("```json")) + 1,
        comment.body.indexOf("\n```", comment.body.indexOf("```json")),
      ),
    ) as unknown;
    const rawRounds = Array.isArray(doc)
      ? doc
      : ((doc as Record<string, unknown>)[AI_REVIEW_LEDGER_ROUNDS_KEY] as unknown[]);

    const out = annotateUnmeasuredRounds(rawRounds, round =>
      fetchJobLog(parsed.repo, round.run, round.attempt),
    );
    for (const [state, n] of Object.entries(out.counts)) totals[state] = (totals[state] ?? 0) + n;

    const already = rawRounds.filter(
      r => readRecordedUnmeasuredState(r) !== AI_REVIEW_UNMEASURED_NOT_RECORDED,
    ).length;
    const split = Object.entries(out.counts).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
    console.log(
      `#${pr}: ${rawRounds.length} round(s), ${out.recorded} newly classified, ` +
        `${already} already recorded — ${split}`,
    );

    if (!parsed.write || out.recorded === 0) continue;

    const nextDoc = Array.isArray(doc) ? out.rounds : { ...(doc as object), rounds: out.rounds };
    const nextBody = replaceLedgerJsonBlock(comment.body, nextDoc);
    if (nextBody === null) {
      console.error(`#${pr}: REFUSED to write — the fenced block could not be located`);
      skipped++;
      continue;
    }
    // READ BACK BEFORE SENDING. `replaceLedgerJsonBlock` locates the fence
    // itself; this is the real reader agreeing that what it produced is a
    // ledger with the same rounds in it.
    const verify = readLedger(nextBody);
    if (
      verify.status !== AI_REVIEW_LEDGER_READ ||
      verify.rounds.length !== reading.rounds.length ||
      verify.rounds.some((r, i) => r.measured !== reading.rounds[i].measured)
    ) {
      console.error(`#${pr}: REFUSED to write — the rewritten body does not read back`);
      skipped++;
      continue;
    }

    const patch = spawnSync(
      "gh",
      ["api", "--method", "PATCH", `repos/${parsed.repo}/issues/comments/${comment.id}`,
        "-f", `body=${nextBody}`],
      { encoding: "utf8" },
    );
    if (patch.status !== 0) {
      console.error(`#${pr}: PATCH failed: ${(patch.stderr ?? "").trim()}`);
      skipped++;
    }
  }

  const summary = Object.entries(totals).sort().map(([k, v]) => `${k} ${v}`).join(", ");
  console.log(`\nTOTAL: ${summary || "nothing unmeasured"}${skipped ? ` (${skipped} refused)` : ""}`);
  return skipped > 0 ? RECORD_UNMEASURED_FAILED : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
