#!/usr/bin/env bun
/**
 * Ask whether a finding is worth filing, before `gh issue create` runs (#1187).
 *
 * ## Why this is a CLI and not a hook
 *
 * `hooks/VerifyPhaseLock.hook.ts` is already the place a `gh issue create`
 * passes through, and it is the wrong place for this. The three checks need
 * the tracker and the repository: the dedupe reads every open issue, and
 * branch scope runs `git grep` against `origin/main`. Putting a network
 * round-trip and a tree-wide grep inside a PreToolUse hook buys a
 * multi-second pause on an unrelated Bash call and a check that fails open
 * the moment the network does — which is the failure
 * `.claude/rules/config-access.md` names.
 *
 * #1187 records that the filing boundary has no sandbox around it: it runs
 * in the orchestrating session, not inside `ai-review.yml`'s
 * `--disallowedTools`. So the arbiter is a command the filer runs, and its
 * exit status is the answer.
 *
 *     bun scripts/arbitrate-finding.ts --title "…" --body-file /tmp/body.md
 *
 * Exit 0 — file it. Exit 1 — do not; the reason is on stdout.
 *
 * **Exit 1 is also what UNMEASURED produces.** A finding the arbiter could
 * not evaluate is not a finding that passes; that is #1187's doctrine and
 * the one behaviour here that must not be softened into a warning.
 */

import { execFileSync } from "child_process";
import { readFileSync } from "fs";

import { arbitrate, verdictSummary, type Finding } from "../lib/finding-arbiter";

interface Args {
  title: string;
  bodyFile: string;
  repo: string;
  existingFile: string | null;
  projectRoot: string;
  json: boolean;
  limit: number;
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
    projectRoot: get("--project-root") ?? process.cwd(),
    json: argv.includes("--json"),
    limit: Number.parseInt(get("--limit") ?? "60", 10),
  };
}

/**
 * The issues the new finding is compared against.
 *
 * Open issues only. A closed issue describes a symptom somebody already
 * decided about, and refusing a filing because it matches a resolved one
 * withholds the report that the fix did not hold.
 *
 * `--existing` takes the same JSON offline, which is how the comparison set
 * is pinned for a test or a measurement.
 */
function existingFindings(args: Args): Finding[] {
  const raw = args.existingFile
    ? readFileSync(args.existingFile, "utf-8")
    : execFileSync(
        "gh",
        ["issue", "list", "--repo", args.repo, "--state", "open",
         "--limit", String(args.limit), "--json", "number,title,body"],
        { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
      );
  const parsed = JSON.parse(raw) as Array<{ number: number; title: string; body?: string }>;
  return parsed.map(i => ({ id: String(i.number), title: i.title, body: i.body ?? "" }));
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (!args.title || !args.bodyFile) {
    console.error(
      "usage: arbitrate-finding.ts --title <t> --body-file <p> " +
      "[--repo owner/name | --existing issues.json] [--project-root <p>] [--json]",
    );
    return 2;
  }
  if (!args.repo && !args.existingFile) {
    // Not a usage error: it is the dedupe stage with no input, and the
    // doctrine for an input that is absent is to refuse, not to skip it.
    console.log("UNMEASURED new: no --repo and no --existing, so the dedupe has nothing to compare against");
    return 1;
  }

  const finding: Finding = {
    id: "new",
    title: args.title,
    body: readFileSync(args.bodyFile, "utf-8"),
  };

  const verdict = arbitrate(finding, {
    projectRoot: args.projectRoot,
    existing: existingFindings(args),
  });

  if (args.json) console.log(JSON.stringify(verdict, null, 2));
  else console.log(verdictSummary(verdict));

  return verdict.file ? 0 : 1;
}

process.exit(main());
