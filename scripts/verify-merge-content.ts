/**
 * Did the merge actually land the commit that was reviewed? (#516)
 *
 * On 2026-10-16 eight commits across two PRs were silently dropped. #500 and
 * #502 were squash-merged while their security reviews were still in flight,
 * and each merge captured a commit FOUR BEHIND the branch head. 611 lines
 * across 5 files never reached main, including the whole of #500's headline
 * fix — so a project whose only source was `tests/helper.ts`, holding a live
 * direct config read, was waived with the sentence "no source files of any
 * kind were found anywhere in the tree", which is false about the tree the
 * walk had just finished.
 *
 * **Why nobody noticed, and why this compares CONTENT.** A squash merge
 * destroys ancestry. `git log main..branch` reports nothing unusual,
 * `gh pr view` says MERGED, and the branch's commits have no descendant on
 * main — so every cheap way of asking "did my work land" answers yes.
 *
 * Measured, because the attractive alternative is an ancestry check and it
 * does not work: `git merge-base --is-ancestor` reports ORPHANED for all six
 * of the commits #511 and #512 cherry-picked, whose content is fully on main.
 * An ancestry guard therefore fires on the NORMAL case — every squash merge
 * this repo makes — which is the fastest way to build a refusal everyone
 * learns to pass with the override. Blob identity is the only question whose
 * answer means what it says.
 *
 * Usage:
 *   bun scripts/verify-merge-content.ts --project <dir> --head <sha> --merged <sha> \
 *     [--base <ref>] [--accept <path>] [--reason <text>] [--out <file>]
 *
 * Prints one JSON object on stdout; diagnostics go to stderr so stdout stays
 * machine-readable. Exits non-zero when a reviewed file's content is not what
 * landed.
 *
 * TWO PROPERTIES THIS FILE MUST KEEP, both asserted by
 * test/verify-merge-content.test.ts (see
 * .claude/rules/checks-must-be-able-to-fail.md):
 *
 *   1. Every refusal exits through REFUSE_EXIT, declared exactly once. The
 *      test builds a mutant copy with that constant set to 0 and runs every
 *      negative case twice — real refuses, mutant does not. An exit written
 *      with a literal code instead of the constant would slip past the
 *      mutation.
 *   2. No relative imports. The mutant runs from a temp directory, and a
 *      relative import of anything under lib/ would make it die on module
 *      resolution — a non-zero exit that reads as the mutation having been
 *      rejected on the merits.
 */

import { execFileSync } from "child_process";
import { statSync, writeFileSync } from "fs";

/** The one exit code every refusal travels through. See note 1 above. */
export const REFUSE_EXIT = 1;

export class MergeContentRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeContentRefused";
  }
}

/** A commit SHA, not a ref. `HEAD` means "whatever worktree you are in". */
const SHA = /^[0-9a-f]{7,40}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

function git(projectRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", projectRoot, ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  });
}

/**
 * The blob a commit holds at a path, or `ABSENT`.
 *
 * `ABSENT` is a value rather than a throw because "the PR deleted this file"
 * and "the merge dropped the commit that deleted it" are different answers
 * and both have to be comparable. Swallowing the error into a `null` that
 * also means "something went wrong" is how `0`, `{}` and `SKIP` become
 * indistinguishable from success.
 */
export const ABSENT = "ABSENT" as const;

export function blobAt(projectRoot: string, commit: string, path: string): string {
  try {
    return git(projectRoot, ["rev-parse", `${commit}:${path}`]).trim();
  } catch {
    return ABSENT;
  }
}

export interface MergeDivergence {
  path: string;
  /** The blob the reviewed head holds. */
  head: string;
  /** The blob the merge commit holds. */
  merged: string;
  /** Set when `--accept` named this path. */
  accepted?: boolean;
}

export interface MergeContentVerdict {
  head: string;
  merged: string;
  base: string;
  /** Every path the PR touched, sorted. */
  compared: string[];
  /** The paths whose content differs. Empty means the merge landed the review. */
  divergent: MergeDivergence[];
  /** Divergences waived by `--accept`, with the reason that justified them. */
  acceptedReason?: string;
}

export function verifyMergeContent(
  projectRoot: string,
  head: string,
  merged: string,
  base: string,
  accept: string[] = [],
  reason = "",
): MergeContentVerdict {
  if (!projectRoot) throw new MergeContentRefused("--project is required");
  if (!head) throw new MergeContentRefused("--head is required: the commit the review was performed against");
  if (!merged) throw new MergeContentRefused("--merged is required: the commit the merge actually landed");

  let stat;
  try {
    stat = statSync(projectRoot);
  } catch {
    throw new MergeContentRefused(`--project ${projectRoot} does not exist`);
  }
  if (!stat.isDirectory()) throw new MergeContentRefused(`--project ${projectRoot} is not a directory`);

  for (const [flag, value] of [["head", head], ["merged", merged]] as const) {
    if (!SHA.test(value)) {
      throw new MergeContentRefused(
        `--${flag} "${value.slice(0, 80)}" is not a commit SHA (7-40 lowercase hex). ` +
          `A ref is not accepted: this check exists because the thing everyone asked was ` +
          `easy rather than true, and "HEAD" is the easiest of all.`,
      );
    }
  }
  if (!REF.test(base)) throw new MergeContentRefused(`--base "${base.slice(0, 80)}" is not a usable ref name`);

  // An override must be justified in writing, or it is a warning nobody
  // reads. #516 asked for this by name.
  if (accept.length > 0 && reason.trim().length === 0) {
    throw new MergeContentRefused(
      `--accept was given for ${accept.join(", ")} without --reason. An unexplained ` +
        `waiver of a content mismatch is the failure this check exists to make visible.`,
    );
  }

  // The scope is what the PR CHANGED, read from the reviewed head. Taking it
  // from the merge commit instead would be the bug asking itself whether it
  // happened: a dropped commit's files are exactly the ones missing there.
  let raw: string;
  try {
    raw = git(projectRoot, ["diff", "--name-only", `${base}...${head}`]);
  } catch (e) {
    throw new MergeContentRefused(
      `could not diff ${base}...${head}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
    );
  }
  const compared = [...new Set(raw.split("\n").map(l => l.trim()).filter(Boolean))].sort();
  if (compared.length === 0) {
    throw new MergeContentRefused(
      `${base}...${head} touches no files. A scope of zero compares nothing and ` +
        `would report success for any merge at all.`,
    );
  }

  const accepted = new Set(accept);
  const divergent: MergeDivergence[] = [];
  for (const path of compared) {
    const a = blobAt(projectRoot, head, path);
    const b = blobAt(projectRoot, merged, path);
    if (a === b) continue;
    divergent.push({ path, head: a, merged: b, ...(accepted.has(path) ? { accepted: true } : {}) });
  }

  return {
    head,
    merged,
    base,
    compared,
    divergent,
    ...(accept.length > 0 ? { acceptedReason: reason.trim() } : {}),
  };
}

/** The refusal text, so the CLI and the tests read one sentence. */
export function divergenceReport(v: MergeContentVerdict): string {
  const unaccepted = v.divergent.filter(d => !d.accepted);
  return (
    `${unaccepted.length} of ${v.compared.length} reviewed file(s) did not land:\n` +
    unaccepted
      .map(d =>
        `  ${d.path}\n` +
        `    reviewed at ${d.head === ABSENT ? "ABSENT" : d.head.slice(0, 12)}\n` +
        `    merged   as ${d.merged === ABSENT ? "ABSENT" : d.merged.slice(0, 12)}`,
      )
      .join("\n") +
    `\n\nA squash merge can capture a commit behind the branch head, and ancestry ` +
    `cannot see it: git log, gh pr view and the absence of descendants all report ` +
    `success. Re-apply the missing work, or pass --accept <path> --reason "<why>" ` +
    `if the divergence is a deliberate conflict resolution.`
  );
}

function firstLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split("\n")[0];
}

const OPTIONS = new Set(["project", "head", "merged", "base", "accept", "reason", "out"]);

export function parseArgs(argv: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const m = /^--([A-Za-z][A-Za-z-]*)$/.exec(arg);
    if (!m) {
      throw new MergeContentRefused(
        `unexpected argument "${arg.slice(0, 80)}" — every input is a --flag with a value`,
      );
    }
    if (!OPTIONS.has(m[1])) throw new MergeContentRefused(`unknown option --${m[1]}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new MergeContentRefused(`--${m[1]} needs a value`);
    }
    (out[m[1]] ??= []).push(value);
  }
  return out;
}

const one = (args: Record<string, string[]>, k: string, fallback = "") => args[k]?.[0] ?? fallback;

// CLI entry point. Guarded so the module can be imported by tests without
// running the comparison and calling process.exit.
if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const verdict = verifyMergeContent(
      one(args, "project"),
      one(args, "head"),
      one(args, "merged"),
      one(args, "base", "origin/main"),
      args.accept ?? [],
      one(args, "reason"),
    );
    const json = JSON.stringify(verdict);
    // Written whatever the verdict, because a refused run is exactly the run
    // whose record somebody needs afterwards.
    if (one(args, "out")) writeFileSync(one(args, "out"), `${json}\n`);
    const unaccepted = verdict.divergent.filter(d => !d.accepted);
    if (unaccepted.length > 0) {
      console.error(`verify-merge-content: REFUSED — ${divergenceReport(verdict)}`);
      console.log(json);
      process.exit(REFUSE_EXIT);
    }
    const waived = verdict.divergent.length;
    console.error(
      `verify-merge-content: ${verdict.compared.length} file(s) landed as reviewed` +
        (waived > 0 ? `, ${waived} accepted — ${verdict.acceptedReason}` : ""),
    );
    console.log(json);
  } catch (e) {
    console.error(`verify-merge-content: REFUSED — ${firstLine(e)}`);
    process.exit(REFUSE_EXIT);
  }
}
