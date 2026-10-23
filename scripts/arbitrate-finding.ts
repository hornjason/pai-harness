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
import {
  citedPathsFromKeys,
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
    thisPr: get("--this-pr") !== null ? Number.parseInt(get("--this-pr") as string, 10) : null,
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
    console.log(`DROP new (UNMEASURED): ${message(error)}`);
    return EXIT_DROP;
  }

  // Cost order, the same doctrine `arbitrate` applies to its own stages: a
  // dropped finding is going nowhere, so it is never paid a `gh pr list`.
  const routing =
    verdict.disposition === "DROP"
      ? null
      // `--file` is the payload's own anchor and REPLACES the prose keys when
      // it is supplied. An `ai-review` finding names one file, and the body
      // around it usually names more — the exemplar that motivated #1343 cites
      // the reader it is about AND the writer it blames. Unioning them routes
      // a precise finding by an imprecise signal: run live on 2026-10-23 the
      // full prose keys read AMBIGUOUS across three pull requests holding the
      // second file, while the anchor alone named the one PR holding the first.
      : routePaths(args.anchorFile !== null ? [args.anchorFile] : citedPathsFromKeys(symptomKeys(finding)), {
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
