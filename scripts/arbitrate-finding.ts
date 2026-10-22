#!/usr/bin/env bun
/**
 * Decide what happens to a finding: post it, file it, or drop it (#1187).
 *
 * ## The default is a PR comment
 *
 * Exit **0** — post it as an inline comment that must be answered.
 * Exit **3** — file it as an issue. Only reachable with `--out-of-scope`.
 * Exit **1** — drop it; the refusal and its reason are on stdout.
 * Exit **2** — usage.
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
  verdictSummary,
  type Finding,
  type Verdict,
} from "../lib/finding-arbiter";
import { renderComment, type VerifierVote } from "../lib/finding-jury";

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
}

/** Exit codes, each declared once so no branch can invent its own. */
export const EXIT_COMMENT = 0;
export const EXIT_DROP = 1;
export const EXIT_USAGE = 2;
export const EXIT_ISSUE = 3;

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
  };
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

function readVotes(path: string): readonly VerifierVote[] {
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  if (!Array.isArray(parsed)) throw new Error(`--votes ${path} is not a JSON array of votes`);
  return parsed as VerifierVote[];
}

function emit(args: Args, verdict: Verdict, finding: Finding): void {
  if (args.json) {
    console.log(JSON.stringify(verdict, null, 2));
  } else if (args.comment && verdict.disposition === "COMMENT") {
    console.log(renderComment(finding, verdict.severity ?? "Important", verdict.category));
  } else {
    console.log(verdictSummary(verdict));
  }
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (!args.title || !args.bodyFile) {
    console.error(
      "usage: arbitrate-finding.ts --title <t> --body-file <p> --votes <p> " +
      "[--repo owner/name | --existing issues.json] [--project-root <p>] " +
      "[--changed-files a.ts,b.ts] [--out-of-scope <reason>] [--json|--comment] [--limit N]",
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
    id: "new",
    title: args.title,
    body: readFileSync(args.bodyFile, "utf-8"),
    ...(args.outOfScope ? { outOfScope: { reason: args.outOfScope } } : {}),
  };

  let verdict: Verdict;
  try {
    verdict = arbitrate(finding, {
      projectRoot: args.projectRoot,
      existing: existingFindings(args),
      votes: readVotes(args.votesFile),
      ...(args.changedFilesArg !== null
        ? { changedFiles: args.changedFilesArg.split(",").map(s => s.trim()).filter(Boolean) }
        : {}),
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    console.log(`DROP new (UNMEASURED): ${why}`);
    return EXIT_DROP;
  }

  emit(args, verdict, finding);
  if (verdict.disposition === "ISSUE") return EXIT_ISSUE;
  return verdict.disposition === "COMMENT" ? EXIT_COMMENT : EXIT_DROP;
}

process.exit(main());
