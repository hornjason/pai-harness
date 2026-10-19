/**
 * What a commit holds at every path, as `<mode> <type> <oid>`.
 *
 * Extracted from `scripts/verify-merge-content.ts` (#516) when `#640` needed
 * the same reading to decide whether a run branch is safe to delete. It is
 * here rather than there because `gates/` and `lib/` may not import from
 * `scripts/` — that is a layering inversion — and because a second copy of
 * this parse would be two deciders that agree: a mutation of either would
 * leave the other answering correctly, and no behavioural test could tell
 * them apart (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
 *
 * Nothing about the reading changed in the move. The two defects its
 * docblock records were both measured on the first cut of the merge
 * verifier and both still govern this file.
 */
import { spawnSync } from "child_process";

/**
 * A path a commit does not hold.
 *
 * `ABSENT` is a value rather than a throw because "the branch deleted this
 * file" and "the comparison dropped it" are different answers and both have
 * to be comparable. Swallowing the error into a `null` that also means
 * "something went wrong" is how `0`, `{}` and `SKIP` become
 * indistinguishable from success.
 */
export const ABSENT = "ABSENT" as const;

/**
 * Run git and keep BOTH streams.
 *
 * stderr is returned rather than discarded because git warns on stderr and
 * exits 0: `multiple merge bases, using <sha>` is the one that matters to
 * callers here, and it means a scope was computed against an arbitrary
 * choice of base. A warning thrown away by the process that provoked it is
 * the fail-open shape one layer out from the code.
 */
export function gitRead(projectRoot: string, args: string[]): { out: string; err: string } {
  const r = spawnSync("git", ["-C", projectRoot, ...args], {
    encoding: "utf-8",
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`git ${args[0]} exited ${r.status}: ${(r.stderr || "").trim().split("\n")[0]}`);
  }
  return { out: r.stdout ?? "", err: r.stderr ?? "" };
}

/**
 * Every path a commit holds, mapped to `<mode> <type> <oid>`.
 *
 * **Why the whole tree, and why not `rev-parse <commit>:<path>`.** Two
 * defects, both measured on the first cut of the merge verifier (#516
 * review):
 *
 *   1. `git diff --name-only` C-quotes any path with a non-ASCII byte, a
 *      quote, a tab or a newline — `"caf\303\251.ts"`, quotes included. Fed
 *      back to `rev-parse` that string resolves on NEITHER commit, both sides
 *      came back ABSENT, and ABSENT equals ABSENT: a merge that dropped two
 *      whole files printed `2 file(s) landed as reviewed` and exited 0. The
 *      fix is `-z` everywhere, and then no path is ever re-parsed at all —
 *      these keys are raw bytes out of git, compared in JS.
 *   2. `rev-parse` answers with a blob, so it cannot see a MODE. A merge that
 *      drops a `chmod +x` lands the identical OID at 100644, and in this repo
 *      a hook that loses its exec bit is silently inert. A symlink replaced
 *      by a regular file with the same bytes is the same hole, sharper.
 *
 * The value is the ls-tree triple, so a mode or type change is a divergence
 * by construction rather than by a second comparison somebody has to
 * remember to write.
 */
export function treeEntries(projectRoot: string, commit: string): Map<string, string> {
  const { out } = gitRead(projectRoot, ["ls-tree", "-r", "-z", commit]);
  const entries = new Map<string, string>();
  for (const record of out.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    entries.set(record.slice(tab + 1), record.slice(0, tab).replace(/\s+/g, " ").trim());
  }
  return entries;
}

/** What a tree holds at a path, or `ABSENT`. One lookup, no second decider. */
export function entryOf(tree: Map<string, string>, path: string): string {
  return tree.get(path) ?? ABSENT;
}
