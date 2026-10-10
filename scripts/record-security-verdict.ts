#!/usr/bin/env bun
/**
 * Record the security review's verdict in workflow-state.json (#129).
 *
 * Before this, a finished ship run's artefact could not answer "did security
 * run, and what did it say?". `agents.rook` was never written, so a run where
 * rook reported a reproduced guard bypass and a run where rook never spawned
 * produced byte-identical state files.
 *
 * WHY A SCRIPT. `workflows/ship.js` runs in a sandbox with no module loading
 * (#69), so it cannot call writeWorkflowState itself, and gates/SCHEMA-GUIDE.md
 * forbids writing the file with Write or `cat >` — Zod validates at write time
 * and an invalid value must fail here rather than as an opaque gate failure
 * later.
 *
 * WHY THE FINDINGS COME FROM A FILE. The verdict and the spawned flag are
 * workflow-computed and arrive as argv. Rook's failure *strings* are text an
 * agent wrote, and interpolating agent text into a shell command is the exact
 * surface three consecutive security reviews of this area each found a new
 * hole in. So rook writes its findings to a JSON file with its own tools and
 * this script reads them off disk. Nothing agent-authored passes through a
 * shell.
 *
 * The workflow's verdict wins. The findings file supplies detail only; it can
 * never turn a FAIL into a PASS, and its absence cannot either.
 *
 * THE THIRD OUTCOME (#171). The remediate → re-review loop is capped, and
 * spending the cap is neither a pass nor a finding: the run ends holding code
 * nobody reviewed. `--verdict EXHAUSTED --rounds <n>` records that as itself —
 * its own verdict member, its own named refusal, and deliberately no findings
 * list, because a findings list is how "the review found something" is written
 * down. `securityReviewIsClean` below is the reader side, and it says no.
 *
 * Usage:
 *   bun scripts/record-security-verdict.ts --state <workflow-state.json> \
 *     --verdict PASS|FAIL|SKIP|EXHAUSTED --spawned true|false \
 *     [--rounds <n>] [--findings <file>] [--scope <file>]
 */

import { readFileSync } from "fs";
import { writeWorkflowState } from "../gates/orchestrator";
import { SECURITY_REREVIEW_EXHAUSTED } from "../gates/schema";

export { SECURITY_REREVIEW_EXHAUSTED };

const OPTIONS = new Set(["state", "verdict", "spawned", "findings", "scope", "rounds"]);

/** The verdicts this script will write. EXHAUSTED is #171's; see above. */
const VERDICTS = new Set(["PASS", "FAIL", "SKIP", "EXHAUSTED"]);

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([A-Za-z][A-Za-z-]*)$/.exec(argv[i]);
    if (!m || !OPTIONS.has(m[1])) {
      throw new Error(`unexpected argument "${String(argv[i]).slice(0, 80)}"`);
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${m[1]} needs a value`);
    }
    out[m[1]] = value;
  }
  return out;
}

/** Read a JSON file, returning null on anything that is not readable JSON. */
function readJson(path: string | undefined): unknown {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * The failure list to persist.
 *
 * A FAIL always ends up with at least one entry: SCHEMA-GUIDE.md calls a FAIL
 * with an empty list "a verdict nobody can act on". When the findings file is
 * missing or unusable, that fact IS the finding worth recording.
 */
export function failureList(verdict: string, findings: unknown): string[] {
  // An exhausted cycle has no findings by construction: whatever the last
  // review said, the record is about attempts running out, and attaching a
  // list here would make it read as a review that found something (#171).
  if (verdict === "EXHAUSTED") return [];
  const raw = Array.isArray(findings)
    ? findings
    : Array.isArray((findings as { failures?: unknown } | null)?.failures)
      ? (findings as { failures: unknown[] }).failures
      : [];
  const detail = raw.map(f => String(f).trim()).filter(Boolean);
  if (verdict !== "FAIL") return detail;
  return detail.length > 0
    ? detail
    : ["the security review failed and wrote no findings file — see the rook transcript"];
}

/**
 * Is this recorded review the clean one?
 *
 * The reader side of the record, kept beside the writer so the two cannot
 * drift. It is the same question `workflows/ship.js` asks before opening a PR
 * (`securityVerdict.verdict !== 'PASS'` blocks the run), asked of the artefact
 * instead of a live variable.
 *
 * FAILS CLOSED. Anything that is not an object carrying exactly the clean
 * shape is not clean: a missing record, a record that never parsed, a PASS
 * with findings attached, and — the point of #171 — an EXHAUSTED record, which
 * means the cap ran out with code nobody reviewed.
 */
export function securityReviewIsClean(record: unknown): boolean {
  if (typeof record !== "object" || record === null || Array.isArray(record)) return false;
  const r = record as Record<string, unknown>;
  if (r.verdict !== "PASS") return false;
  if (r.refusal !== undefined) return false;
  if (Array.isArray(r.failures) && r.failures.some(f => String(f).trim() !== "")) return false;
  return true;
}

export function buildRookRecord(
  verdict: string,
  spawned: boolean,
  findings: unknown,
  scope: unknown,
  rounds?: number,
): Record<string, unknown> {
  const record: Record<string, unknown> = { spawned, verdict };
  const failures = failureList(verdict, findings);
  if (failures.length > 0) record.failures = failures;

  // The refusal is derived from the verdict, never passed in: a caller that
  // could supply one independently could record the refusal honestly while
  // parking the verdict at PASS, which is the fail-open this whole record
  // exists to close.
  if (verdict === "EXHAUSTED") {
    record.refusal = SECURITY_REREVIEW_EXHAUSTED;
    if (rounds !== undefined) record.rounds = rounds;
  }

  // What was actually reviewed, so the artefact answers the question the
  // production failure turned on: a PASS over zero files is distinguishable
  // from a PASS over the change.
  const s = scope as { sha?: unknown; files?: unknown } | null;
  if (s && typeof s.sha === "string") record.testedSha = s.sha;
  if (s && Array.isArray(s.files)) record.testedPaths = s.files.map(f => String(f));

  return record;
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.state) throw new Error("--state is required");
    if (!VERDICTS.has(String(args.verdict))) {
      throw new Error(
        `--verdict must be one of ${[...VERDICTS].join(", ")} (got "${String(args.verdict)}")`,
      );
    }
    if (args.spawned !== "true" && args.spawned !== "false") {
      throw new Error(`--spawned must be true or false (got "${String(args.spawned)}")`);
    }

    // The round count is the whole content of "we ran out of attempts": without
    // it the record says the cap was spent but not how large the cap was, which
    // is a bound nobody can check. Refused here rather than defaulted.
    let rounds: number | undefined;
    if (args.rounds !== undefined) {
      rounds = Number(args.rounds);
      if (!Number.isInteger(rounds) || rounds < 1) {
        throw new Error(`--rounds must be a whole number of at least 1 (got "${args.rounds}")`);
      }
    }
    if (args.verdict === "EXHAUSTED" && rounds === undefined) {
      throw new Error("--rounds is required with --verdict EXHAUSTED");
    }

    const state = JSON.parse(readFileSync(args.state, "utf-8"));
    state.agents = state.agents || {};
    state.agents.rook = buildRookRecord(
      args.verdict,
      args.spawned === "true",
      readJson(args.findings),
      readJson(args.scope),
      rounds,
    );
    state.changelog = state.changelog || [];
    state.changelog.push({
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      event: "security-verdict",
      detail:
        `rook ${args.verdict} (spawned=${args.spawned})` +
        (rounds === undefined ? "" : ` after ${rounds} re-review round(s)`),
      phase: "VERIFY",
      actor: "rook",
    });

    writeWorkflowState(args.state, state);
    console.log(JSON.stringify({ ok: true, rook: state.agents.rook }));
  } catch (e) {
    console.error(`record-security-verdict: ${e instanceof Error ? e.message : String(e)}`);
    console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    process.exit(1);
  }
}
