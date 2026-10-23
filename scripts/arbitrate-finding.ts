#!/usr/bin/env bun
/**
 * Decide what happens to a finding: post it, file it, or drop it (#1187).
 *
 * ## The default is a PR comment
 *
 * Exit **0** — post it as an inline comment that must be answered.
 * Exit **3** — file it as an issue. Only reachable with `--out-of-scope`.
 * Exit **4** — post it, but on ANOTHER open pull request. See below.
 * Exit **1** — drop it; the refusal and its reason are on stdout.
 * Exit **2** — usage.
 *
 * ## Exit 4: the tracker is not the only other place a finding can go (#1343)
 *
 * About 45% of filings measured while working #1261 named a file an open pull
 * request was already changing, and a tracker row about a file somebody is
 * editing is a race it usually loses. The same shape arrives from the review
 * side, because `ai-review` reads the MERGE REF and attributes a defect that
 * lives on `main` to whichever pull request is standing closest — on
 * 2026-10-23 that blocked #1393 with a `high` naming `lib/ai-review-rounds.ts`
 * and #1354 with a `critical` naming `lib/bash-write-guard.ts`, neither file
 * in the diff it was blocking. Both were re-routed by a person reading diffs.
 *
 * `lib/finding-pr-routing.ts` is that lookup, and the reading is printed on
 * every run. It only CHANGES the exit when exactly one other open pull request
 * holds the cited file: several holders, no holder, or a corpus that could not
 * be read all leave the arbiter's own disposition alone and say so on stdout.
 * A router that guessed between two candidates would be worse than the hand
 * routing it replaces.
 *
 * **Exit 1 is also what UNMEASURED produces.** A finding the arbiter could
 * not evaluate is not a finding that passes; that is #1187's doctrine and the
 * one behaviour here that must not be softened into a warning.
 *
 * ## Why this is a CLI and not a hook
 *
 * `hooks/VerifyPhaseLock.hook.ts` is already the place a `gh issue create`
 * passes through, and it is the wrong place for this. The checks need the
 * tracker and the repository: the dedupe reads every open issue, and branch
 * scope runs `git grep` against `origin/main`. Putting a network round-trip
 * and a tree-wide grep inside a PreToolUse hook buys a multi-second pause on
 * an unrelated Bash call and a check that fails open the moment the network
 * does — which is the failure `.claude/rules/config-access.md` names.
 *
 * #1187 records that the filing boundary has no sandbox around it: it runs in
 * the orchestrating session, not inside `ai-review.yml`'s `--disallowedTools`.
 * So this is a command the caller runs, and its exit status is the answer.
 *
 *     bun scripts/arbitrate-finding.ts --title "…" --body-file /tmp/body.md \
 *       --repo owner/name --votes /tmp/votes.json
 *
 * `--votes` is a JSON array of `{ verifier, real, reason, category?,
 * severity? }`. **It is not optional**: a finding nobody voted on has not
 * cleared a quorum, it has not had one, and those are different states.
 */

import { execFileSync } from "child_process";
import { readFileSync } from "fs";

import {
  arbitrate,
  symptomKeys,
  UNFILED_ID,
  verdictSummary,
  type Finding,
  type Verdict,
} from "../lib/finding-arbiter";
import { parseVotes, renderComment, type VerifierVote } from "../lib/finding-jury";
import { filingBatch, ledgerPath, recordAdjudication, type FilingLedgerRow } from "../lib/issue-filing-gate";
import {
  citedPathsFromKeys,
  normalisePath,
  routePaths,
  routingSummary,
  type OpenPrCorpus,
  type OpenPullRequest,
  type Routing,
} from "../lib/finding-pr-routing";

interface Args {
  title: string;
  bodyFile: string;
  repo: string;
  existingFile: string | null;
  votesFile: string | null;
  changedFilesArg: string | null;
  outOfScope: string | null;
  projectRoot: string;
  json: boolean;
  comment: boolean;
  limit: number;
  anchorFile: string | null;
  openPrsFile: string | null;
  thisPr: number | null;
  prLimit: number;
}

/** Exit codes, each declared once so no branch can invent its own. */
export const EXIT_COMMENT = 0;
export const EXIT_DROP = 1;
export const EXIT_USAGE = 2;
export const EXIT_ISSUE = 3;
export const EXIT_OTHER_PR = 4;

/**
 * The paths to route on: the anchor when the finding cites it, else the
 * finding's own cited paths (#1427).
 *
 * The anchor narrows; it never introduces a path the finding does not name.
 * Compared through `normalisePath` so `./lib/a.ts`, `lib/a.ts` and a leading
 * slash are one path — otherwise the verification is defeated by spelling,
 * which is the same bug one layer down.
 *
 * Exported because this is the whole of the trust decision, and a caller
 * reading `routePaths(...)` should be able to find it as one named thing.
 */
export function anchorOrCited(anchor: string | null, cited: readonly string[]): string[] {
  if (anchor === null) return [...cited];
  const wanted = normalisePath(anchor);
  return cited.some(p => normalisePath(p) === wanted) ? [anchor] : [...cited];
}

/**
 * A pull request number, or `null` for absent AND for unusable (#1427).
 *
 * Exported so the two states can be witnessed directly. `--this-pr` is read
 * from a workflow expression, so "the expression produced nothing" arrives
 * as an empty string or a literal `${{ … }}` rather than as a missing flag.
 */
export function parsePrNumber(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Was `--this-pr` given a value this script could not use? */
export function prNumberIsUnusable(argv: readonly string[]): boolean {
  const i = argv.indexOf("--this-pr");
  if (i === -1 || i + 1 >= argv.length) return false;
  return parsePrNumber(argv[i + 1]) === null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  return {
    title: get("--title") ?? "",
    bodyFile: get("--body-file") ?? "",
    repo: get("--repo") ?? "",
    existingFile: get("--existing"),
    votesFile: get("--votes"),
    changedFilesArg: get("--changed-files"),
    outOfScope: get("--out-of-scope"),
    projectRoot: get("--project-root") ?? process.cwd(),
    json: argv.includes("--json"),
    comment: argv.includes("--comment"),
    limit: Number.parseInt(get("--limit") ?? "60", 10),
    anchorFile: get("--file"),
    openPrsFile: get("--open-prs"),
    // #1427: `null` for a malformed value, never `NaN`. A NaN here is the
    // worst of the three states — the router sees `thisPr !== undefined` so
    // it does not refuse for a missing identity, and then
    // `p.number !== NaN` is true of every row so the own-PR exclusion
    // removes nothing. The pull request being arbitrated stays a candidate
    // to route to, which is exactly the fail-open the refusal exists for,
    // reached through a typo instead of an omission. `main` turns the null
    // into EXIT_USAGE so a bad flag is reported rather than absorbed.
    thisPr: parsePrNumber(get("--this-pr")),
    // Its own knob, not `--limit`. That one bounds the ISSUE population and
    // this one bounds the PULL REQUEST population; one flag for two
    // populations would make a truncation refusal name the wrong corpus.
    prLimit: Number.parseInt(get("--pr-limit") ?? "60", 10),
  };
}

/**
 * The open pull requests the finding is routed against (#1343).
 *
 * Fetched in ONE call — `gh pr list --json files` resolves each PR's diff in
 * the same GraphQL query, so this is not N round-trips — and `changedFiles`
 * is asked for alongside `files` so a page-limited file list is detectable
 * without hardcoding whatever page size `gh` currently uses. The two numbers
 * disagreeing IS the truncation detector; see `OpenPullRequest`.
 *
 * Every failure here is `unmeasured` and never an empty list. "No open pull
 * request touches this file" is the reading that sends a finding to the
 * tracker, and producing it from a `gh` that did not run is the fail-open
 * this whole module exists to avoid.
 */
function openPrCorpus(args: Args): OpenPrCorpus {
  if (args.openPrsFile === null && !args.repo) {
    return { status: "unmeasured", why: "no --repo and no --open-prs, so no pull requests were looked at" };
  }
  let raw: string;
  try {
    raw = args.openPrsFile
      ? readFileSync(args.openPrsFile, "utf-8")
      : execFileSync(
          "gh",
          ["pr", "list", "--repo", args.repo, "--state", "open",
           "--limit", String(args.prLimit + 1), "--json", "number,changedFiles,files"],
          { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
        );
  } catch (error) {
    return { status: "unmeasured", why: `the open pull requests could not be listed: ${message(error)}` };
  }
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch (error) {
    return { status: "unmeasured", why: `the open pull request list is not JSON: ${message(error)}` };
  }
  if (!Array.isArray(rows)) {
    return { status: "unmeasured", why: "the open pull request list is not an array" };
  }
  if (args.openPrsFile === null && rows.length > args.prLimit) {
    return {
      status: "unmeasured",
      why: `the repository returned more than --pr-limit ${args.prLimit} open pull requests, ` +
        "so a PR holding the cited file may not be in the population at all",
    };
  }
  const prs: OpenPullRequest[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") {
      return { status: "unmeasured", why: "an entry in the open pull request list is not an object" };
    }
    const r = row as { number?: unknown; files?: unknown; changedFiles?: unknown };
    const files = Array.isArray(r.files)
      ? r.files.map(f => (typeof f === "string" ? f : (f as { path?: unknown })?.path)).filter((p): p is string => typeof p === "string")
      : null;
    if (typeof r.number !== "number" || files === null) {
      return { status: "unmeasured", why: `pull request entry ${JSON.stringify(r.number)} has no number or no file list` };
    }
    prs.push({
      number: r.number,
      files,
      // An absent count is not a complete one. Reporting `files.length` here
      // would assert the list is whole on the strength of nothing, which is
      // the one reading the truncation guard exists to refuse.
      declaredFileCount: typeof r.changedFiles === "number" ? r.changedFiles : -1,
    });
  }
  return { status: "measured", prs };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Raised when the comparison population could not be read in full. */
class TruncatedPopulation extends Error {}

/**
 * The issues the new finding is compared against.
 *
 * Open issues only. A closed issue describes a symptom somebody already
 * decided about, and refusing a finding because it matches a resolved one
 * withholds the report that the fix did not hold.
 *
 * **`--limit` is requested as `limit + 1` and an extra row is a refusal.** A
 * dedupe against a truncated corpus returns "no duplicate" indistinguishably
 * from a real one, and the default of 60 against 27 open issues today is
 * exactly the shape that ships quietly and bites later. This matches the
 * no-input branch in `main`, which already refuses rather than passing.
 *
 * `--existing` takes the same JSON offline, which is how the comparison set
 * is pinned for a test or a measurement; it is the caller's own population
 * and so is never truncation-checked.
 */
function existingFindings(args: Args): Finding[] {
  let raw: string;
  if (args.existingFile) {
    raw = readFileSync(args.existingFile, "utf-8");
  } else {
    raw = execFileSync(
      "gh",
      ["issue", "list", "--repo", args.repo, "--state", "open",
       "--limit", String(args.limit + 1), "--json", "number,title,body"],
      { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
    );
  }
  const parsed = JSON.parse(raw) as Array<{ number?: number; id?: string; title: string; body?: string }>;
  if (!args.existingFile && parsed.length > args.limit) {
    throw new TruncatedPopulation(
      `the tracker returned more than --limit ${args.limit} open issues, so the dedupe population is truncated — ` +
      "raise --limit; a dedupe against a partial corpus reports no duplicate exactly as a complete one does",
    );
  }
  return parsed.map((i, at) => {
    // A DUPLICATE refusal withholds a finding, so it has to name WHERE the
    // symptom is already reported or it is not reviewable. An entry with no
    // identifier yields the id `"undefined"` and the refusal reads "already
    // reported as undefined, undefined" — a refusal that cannot be acted on,
    // which is worse than no refusal. Caught end-to-end against real tracker
    // data, where a hand-built `--existing` used `id` and the reader wanted
    // `number`; both are accepted now, and neither is guessed.
    const id = i.number !== undefined ? String(i.number) : i.id;
    if (id === undefined || id === "" || id === "undefined") {
      throw new Error(
        `entry ${at} of the existing-findings population has neither \`number\` nor \`id\` — ` +
        "a dedupe that cannot name what a finding collides with produces an unreviewable refusal",
      );
    }
    return { id, title: i.title, body: i.body ?? "" };
  });
}

/**
 * The ballot, validated rather than cast (#1235).
 *
 * This used to check `Array.isArray` and then `parsed as VerifierVote[]`, so
 * no entry was ever looked at — and `juryReading` counts agreement by
 * truthiness, which made `"real": "false"` a yes. `parseVotes` owns the shape
 * check; it throws, and `main`'s catch turns that into `DROP (UNMEASURED)`,
 * because a ballot that could not be read is not a ballot that passed.
 */
function readVotes(path: string): readonly VerifierVote[] {
  try {
    return parseVotes(JSON.parse(readFileSync(path, "utf-8")));
  } catch (error) {
    throw new Error(`--votes ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The adjudication, as a ledger row (#1467, CRC-B4).
 *
 * **One site, and it is the whole of the recording**, so a mutant copy with
 * `jury: verdict.jury` set to `null` neutralises the thing under test and
 * nothing else — `test/finding-arbiter.test.ts`'s `AR-25` runs that mutant
 * beside the real script and `AR-26` asserts the string appears exactly once,
 * because a second assignment somewhere else would survive the mutation and
 * the case would go green having witnessed nothing
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 *
 * `FilingLedgerRow` and not a new shape: the value of the two row populations
 * — the chokepoint's and this one's — is the corpus they form together, and a
 * second vocabulary for `category` / `refusal` / `withheldBy` would make that
 * union a join nobody can write. The chokepoint cannot fill `jury`; this is
 * the only writer that can, which is the point.
 *
 * **Written for a DROP as well as for a COMMENT, and that is the criterion
 * rather than a detail.** The cheapest wrong version of this records what it
 * surfaces, which satisfies every row a reader goes looking for and leaves the
 * withheld population exactly as unrecoverable as it was. A candidate the
 * quorum voted down is the one row that cannot be reconstructed from anywhere
 * else: it is never filed, never commented on, never fixed, so it enters no
 * downstream graph at all. `CandidateRecord`'s own header says it — *"written
 * down at the moment the candidate is withheld, or never."*
 */
export function ledgerRow(finding: Finding, verdict: Verdict, at: string): FilingLedgerRow {
  const batch = filingBatch(at);
  const emitted = verdict.disposition !== "DROP";
  return {
    at,
    // `${batch}/0`: one adjudication per process here, where the hook writes
    // one row per `gh issue create` clause. Same composition, so a row from
    // either writer is told apart from every other on the shared ledger.
    key: batch === null ? null : `${batch}/0`,
    id: verdict.id,
    title: finding.title,
    symptomHash: verdict.symptomHash,
    category: verdict.category,
    severity: verdict.severity,
    disposition: verdict.disposition,
    refusal: verdict.refusal,
    emitted,
    withheldBy: emitted ? null : (verdict.refusal ?? "UNACCOUNTED"),
    jury: verdict.jury,
    duplicateOf: verdict.duplicateOf,
    // No override exists on this path. The `arbiter-override` label is a
    // `gh issue create` flag the chokepoint reads, and nothing here has one.
    overridden: false,
  };
}

function emit(args: Args, verdict: Verdict, finding: Finding, routing: Routing | null): void {
  if (args.json) {
    console.log(JSON.stringify({ ...verdict, routing }, null, 2));
    return;
  }
  if (args.comment && verdict.disposition === "COMMENT") {
    console.log(renderComment(finding, verdict.severity ?? "Important", verdict.category));
  } else {
    console.log(verdictSummary(verdict));
  }
  // Always printed when it was taken, including when it changed nothing. A
  // routing reading that only appears when it fires is one a reader cannot
  // tell from one that was never asked for.
  if (routing !== null) console.log(routingSummary(routing));
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (!args.title || !args.bodyFile) {
    console.error(
      "usage: arbitrate-finding.ts --title <t> --body-file <p> --votes <p> " +
      "[--repo owner/name | --existing issues.json] [--project-root <p>] " +
      "[--changed-files a.ts,b.ts] [--out-of-scope <reason>] [--json|--comment] [--limit N] " +
      "[--this-pr N] [--file path] [--open-prs prs.json] [--pr-limit N]",
    );
    return EXIT_USAGE;
  }
  // #1427: a `--this-pr` that was GIVEN and could not be read is a usage
  // error, not an absent identity. Absorbing it would make the router's
  // refusal fire on a typo and read like a missing flag, and the whole
  // point of that refusal is that it names what is missing.
  if (prNumberIsUnusable(process.argv.slice(2))) {
    console.error("--this-pr must be a positive integer; refusing rather than routing with an unreadable identity");
    return EXIT_USAGE;
  }
  // Not usage errors: these are stages with no input, and the doctrine for an
  // absent input is to refuse, not to skip it.
  if (!args.repo && !args.existingFile) {
    console.log("DROP new (UNMEASURED): no --repo and no --existing, so the dedupe has nothing to compare against");
    return EXIT_DROP;
  }
  if (!args.votesFile) {
    console.log("DROP new (UNMEASURED): no --votes, so no verifier group was convened — not reaching a quorum and not having one are different states");
    return EXIT_DROP;
  }

  const finding: Finding = {
    id: UNFILED_ID,
    title: args.title,
    body: readFileSync(args.bodyFile, "utf-8"),
    ...(args.outOfScope ? { outOfScope: { reason: args.outOfScope } } : {}),
  };

  const changedFiles =
    args.changedFilesArg !== null
      ? args.changedFilesArg.split(",").map(s => s.trim()).filter(Boolean)
      : null;

  let verdict: Verdict;
  try {
    verdict = arbitrate(finding, {
      projectRoot: args.projectRoot,
      existing: existingFindings(args),
      votes: readVotes(args.votesFile),
      ...(changedFiles !== null ? { changedFiles } : {}),
    });
  } catch (error) {
    // No verdict, so no row. The ballot is not lost with the process the way
    // an in-memory one would be — it is the caller's own `--votes` file and
    // is still on disk — but nothing here records that it was refused.
    console.log(`DROP new (UNMEASURED): ${message(error)}`);
    return EXIT_DROP;
  }

  // ── Record the decision, at decision time ────────────────────────────────
  //
  // Before the routing below, which costs a `gh pr list`: a decision recorded
  // only once the network answered is a decision the ledger loses whenever the
  // network does. And before the exit, for every disposition — see
  // `ledgerRow`.
  //
  // A write that fails does NOT change the exit. `recordAdjudication`'s
  // standing doctrine is that a measurement apparatus must not block the thing
  // it measures, and the policy over that failure is to proceed LOUDLY: the
  // line below is the difference between an unrecorded decision and a silent
  // one.
  if (!recordAdjudication(ledgerRow(finding, verdict, new Date().toISOString()))) {
    console.log(
      `UNMEASURED: the adjudication could not be appended to ${ledgerPath()}, so this ballot is ` +
      "not on the record — re-running would re-sample the verifiers rather than recover their votes",
    );
  }

  // Cost order, the same doctrine `arbitrate` applies to its own stages: a
  // dropped finding is going nowhere, so it is never paid a `gh pr list`.
  const routing =
    verdict.disposition === "DROP"
      ? null
      // `--file` is the payload's own anchor, and it SELECTS among the paths
      // the finding cites rather than replacing them. An `ai-review` finding
      // names one file, and the body around it usually names more — the
      // exemplar that motivated #1343 cites the reader it is about AND the
      // writer it blames. Unioning them routes a precise finding by an
      // imprecise signal: run live on 2026-10-23 the full prose keys read
      // AMBIGUOUS across three pull requests holding the second file, while
      // the anchor alone named the one PR holding the first.
      //
      // #1427: it used to REPLACE them, unverified, and the agent being
      // arbitrated supplies it. An anchor pointing at some other open pull
      // request's files produced OTHER_PR, and the caller turns OTHER_PR
      // into exit 4, which suppresses the filing — so an agent could steer
      // its own adjudication into silence with one flag, and the finding's
      // own cited paths were never consulted on that path.
      //
      // An anchor the finding does not cite is therefore IGNORED rather than
      // obeyed, and routing falls back to the finding's own evidence. Not
      // refused: #1416 is live and working, a wrong answer in the refusing
      // direction is cheap only when it does not suppress, and falling back
      // can only widen the cited set — AMBIGUOUS and TRACKER both leave the
      // arbiter's disposition standing, so this path cannot newly silence
      // anything.
      : routePaths(anchorOrCited(args.anchorFile, citedPathsFromKeys(symptomKeys(finding))), {
          corpus: openPrCorpus(args),
          ...(args.thisPr !== null ? { thisPr: args.thisPr } : {}),
          ...(changedFiles !== null ? { changedFiles } : {}),
        });

  emit(args, verdict, finding, routing);
  if (verdict.disposition === "DROP") return EXIT_DROP;
  // Only the unambiguous case moves the answer. AMBIGUOUS, TRACKER,
  // NO_CITED_PATH and UNMEASURED all leave the arbiter's disposition standing
  // — see the exit-4 section at the top of this file for why a router that
  // picked between two candidates would be worse than the hand routing.
  if (routing !== null && routing.route === "OTHER_PR") return EXIT_OTHER_PR;
  return verdict.disposition === "ISSUE" ? EXIT_ISSUE : EXIT_COMMENT;
}

process.exit(main());
