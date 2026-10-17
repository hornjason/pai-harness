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
 *   3. The waiver filter appears exactly once. The first cut had it written
 *      out twice and the duplicate measured 0 red, because a mutation of
 *      either copy left the other deciding.
 *
 * ## What the first cut got wrong, and how
 *
 * The happy path was never wrong. Every defect the security review of PR
 * #527 found was the guard going GREEN over a merge that lost something —
 * which is the only direction that matters, since a guard nobody can trust
 * to refuse is a line in a report.
 *
 *   - **C-quoted paths.** `--name-only` without `-z` returns
 *     `"caf\303\251.ts"`, quotes included; `rev-parse` then failed on both
 *     commits, both sides read ABSENT, and ABSENT equals ABSENT. A merge
 *     that dropped two whole files printed `2 file(s) landed as reviewed`.
 *   - **Modes were invisible**, because `rev-parse` answers with a blob. A
 *     dropped `chmod +x` and a symlink landing as a regular file both have
 *     the identical OID.
 *   - **The scope was the NET diff**, so work reverted within the branch,
 *     and the source half of a rename, were never compared at all.
 *   - **`--out` wrote nothing for a refusal that threw**, which is every
 *     refusal raised before a verdict exists — and those are the runs whose
 *     record somebody wants.
 *   - **A commit compared with itself, and a SHA resolving to nothing**,
 *     both passed.
 *
 * Found by sec-516, by building each merge rather than reading for it.
 */

import { spawnSync } from "child_process";
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

/**
 * Run git and keep BOTH streams.
 *
 * stderr is returned rather than discarded because git warns on stderr and
 * exits 0: `multiple merge bases, using <sha>` is the one that matters here,
 * and it means the scope was computed against an arbitrary choice of base. A
 * warning thrown away by the process that provoked it is the fail-open shape
 * one layer out from the code — nothing in the verdict could ever mention it.
 */
function git(projectRoot: string, args: string[]): { out: string; err: string } {
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
 * A path a commit does not hold.
 *
 * `ABSENT` is a value rather than a throw because "the PR deleted this file"
 * and "the merge dropped the commit that deleted it" are different answers
 * and both have to be comparable. Swallowing the error into a `null` that
 * also means "something went wrong" is how `0`, `{}` and `SKIP` become
 * indistinguishable from success.
 */
export const ABSENT = "ABSENT" as const;

/**
 * Every path a commit holds, mapped to `<mode> <type> <oid>`.
 *
 * **Why the whole tree, and why not `rev-parse <commit>:<path>`.** Two
 * defects, both measured on the first cut of this file (#516 review):
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
  const { out } = git(projectRoot, ["ls-tree", "-r", "-z", commit]);
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

/**
 * Paths the diff calls added, modified or type-changed that the reviewed
 * head does not actually hold.
 *
 * That combination is impossible if both readings are sound, so it means a
 * lookup failed — and a failed lookup on both sides compares equal, which
 * reads as a clean merge. This is the shape the C-quoting defect took, and
 * `-z` removed that cause rather than this class of cause.
 *
 * **Exported and taking a map rather than a repo on purpose.** With `-z` in
 * place there is no fixture that reaches it through git, so testing it
 * through a repository would be a 0-red row dressed as coverage. Given the
 * map directly it has an input on which it differs from a stub, and the
 * guard is a check rather than a comment about one.
 */
export function unresolvablePaths(
  scope: Map<string, PathStatus>,
  headTree: Map<string, string>,
): string[] {
  return [...scope.keys()]
    .filter(p => {
      const status = scope.get(p);
      return status !== "D" && status !== "?" && !headTree.has(p);
    })
    .sort();
}

export interface MergeDivergence {
  path: string;
  /** `<mode> <type> <oid>` the reviewed head holds, or `ABSENT`. */
  head: string;
  /** `<mode> <type> <oid>` the merge commit holds, or `ABSENT`. */
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
  /**
   * git warnings emitted while computing the scope, verbatim.
   *
   * Never empty-as-clean by omission: the key is always present, so a reader
   * can tell "git said nothing" from "this build of the script never looked".
   */
  warnings: string[];
}

/**
 * The divergences that are NOT waived — the ones that make this refuse.
 *
 * Exported and used by both the report and the CLI because the first cut had
 * this filter written out twice, and the duplicate was measured at 0 red: a
 * mutation of either copy left the other deciding, so both read as covered
 * and neither was. That is the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`, and the sanctioned fix is
 * one binding.
 */
export function unacceptedDivergences(v: MergeContentVerdict): MergeDivergence[] {
  return v.divergent.filter(d => !d.accepted);
}

/**
 * Every path to compare, and what the PR did to it.
 *
 * **Why this is not just the net diff.** `base...head` is what the branch
 * CHANGED end-to-end, and two ways of losing work leave no trace in it:
 *
 *   - **Reverted within the branch.** A commit adds something and a later
 *     commit — typically the one a reviewer asked for — takes it back out.
 *     Head equals base at that path, so the net diff omits it entirely. A
 *     squash merge that captures the first commit lands the reverted content
 *     on main, and nothing in scope can see it.
 *   - **Half-dropped rename.** `git mv a b` with the addition landing and the
 *     deletion not. Rename detection reports only the destination, so the
 *     source is never compared and the legacy file survives on main.
 *
 * So the scope is the net diff UNIONED with every path any commit in the
 * range touched, and `--no-renames` makes a rename two ordinary records.
 */
export type PathStatus = "A" | "M" | "D" | "T" | "?";

export function mergeScope(
  projectRoot: string,
  base: string,
  head: string,
): { paths: Map<string, PathStatus>; warnings: string[] } {
  const warnings: string[] = [];
  const note = (err: string) => {
    for (const line of err.split("\n").map(l => l.trim()).filter(Boolean)) warnings.push(line);
  };

  let net, touched;
  try {
    net = git(projectRoot, ["diff", "--name-status", "-z", "--no-renames", `${base}...${head}`]);
    touched = git(projectRoot, ["log", "--format=", "--name-only", "-z", "--no-renames", `${base}..${head}`]);
  } catch (e) {
    throw new MergeContentRefused(
      `could not read the scope of ${base}...${head}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
    );
  }
  note(net.err);
  note(touched.err);

  const paths = new Map<string, PathStatus>();
  const fields = net.out.split("\0").filter((f, i, all) => f !== "" || i < all.length - 1);
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i].trim();
    const path = fields[i + 1];
    if (!status || !path) continue;
    // A `--name-status -z` record is exactly two fields. A RENAME is three,
    // and one three-field record desynchronises every pair after it: the
    // destination becomes a status and the next status becomes a path, so
    // the scope quietly fills with entries named `A` and `M`. `--no-renames`
    // is what keeps this to two, and this refusal is what makes a future
    // edit that drops it loud instead of silently mis-statusing the tree.
    if (!/^[A-Z][0-9]*$/.test(status)) {
      throw new MergeContentRefused(
        `could not parse git's --name-status stream: expected a status letter, got "${status.slice(0, 40)}". ` +
          `A desynchronised pair stream assigns the wrong status to every path after it.`,
      );
    }
    const letter = status[0];
    paths.set(path, (letter === "A" || letter === "M" || letter === "D" || letter === "T" ? letter : "?") as PathStatus);
  }
  for (const path of touched.out.split("\0")) {
    if (path && !paths.has(path)) paths.set(path, "?");
  }
  return { paths, warnings };
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

  // Comparing a commit with itself answers "did this land" with "yes" for
  // every tree there has ever been. Nothing in the SHA check above rules it
  // out, and the two SHAs arrive from two different `gh` queries that can
  // collapse to the same value when a merge is a fast-forward.
  if (head === merged) {
    throw new MergeContentRefused(
      `--head and --merged are the same commit (${head.slice(0, 12)}). A tree compared ` +
        `against itself cannot diverge, so this would report success without looking.`,
    );
  }

  // A SHA that is well-formed and resolves to nothing would make every
  // lookup ABSENT, and ABSENT matches ABSENT — the whole tree would read as
  // "landed exactly as reviewed".
  for (const [flag, value] of [["head", head], ["merged", merged]] as const) {
    try {
      git(projectRoot, ["rev-parse", "--verify", "--quiet", `${value}^{commit}`]);
    } catch {
      throw new MergeContentRefused(
        `--${flag} ${value.slice(0, 12)} does not resolve to a commit in ${projectRoot}. ` +
          `Every path would then be absent on both sides, which compares equal.`,
      );
    }
  }

  // An override must be justified in writing, or it is a warning nobody
  // reads. #516 asked for this by name.
  if (accept.length > 0 && reason.trim().length === 0) {
    throw new MergeContentRefused(
      `--accept was given for ${accept.join(", ")} without --reason. An unexplained ` +
        `waiver of a content mismatch is the failure this check exists to make visible.`,
    );
  }

  // The scope is what the PR TOUCHED, read from the reviewed head. Taking it
  // from the merge commit instead would be the bug asking itself whether it
  // happened: a dropped commit's files are exactly the ones missing there.
  const { paths, warnings } = mergeScope(projectRoot, base, head);
  // Sorted so the artefact is byte-stable across runs: git emits tree order
  // and the commit walk appends to it, so a path only the walk can see
  // arrives last however it sorts.
  const compared = [...paths.keys()].sort();
  if (compared.length === 0) {
    throw new MergeContentRefused(
      `${base}...${head} touches no files. A scope of zero compares nothing and ` +
        `would report success for any merge at all.`,
    );
  }

  const headTree = treeEntries(projectRoot, head);
  const mergedTree = treeEntries(projectRoot, merged);

  // A path the diff calls added, modified or type-changed MUST exist at head
  // — that is what those letters mean. If it does not, the lookup failed and
  // the comparison that follows is between two failures, which agree. This
  // is the shape the C-quoting defect took, and `-z` removed that cause
  // rather than this class of cause.
  const unresolvable = unresolvablePaths(paths, headTree);
  if (unresolvable.length > 0) {
    throw new MergeContentRefused(
      `${unresolvable.length} path(s) the diff reports as changed do not exist in ${head.slice(0, 12)}: ` +
        `${unresolvable.slice(0, 5).join(", ")}. The lookup failed rather than the file being absent, ` +
        `and two failed lookups compare equal — which would read as a clean merge.`,
    );
  }

  const accepted = new Set(accept);
  const divergent: MergeDivergence[] = [];
  for (const path of compared) {
    const a = entryOf(headTree, path);
    const b = entryOf(mergedTree, path);
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
    warnings,
  };
}

/** `100644 blob 1a2b3c4d5e6f`, or `ABSENT`. The mode is shown because it can diverge alone. */
function describeEntry(e: string): string {
  if (e === ABSENT) return ABSENT;
  const parts = e.split(" ");
  return parts.length === 3 ? `${parts[0]} ${parts[1]} ${parts[2].slice(0, 12)}` : e;
}

/** The refusal text, so the CLI and the tests read one sentence. */
export function divergenceReport(v: MergeContentVerdict): string {
  const unaccepted = unacceptedDivergences(v);
  return (
    `${unaccepted.length} of ${v.compared.length} reviewed file(s) did not land:\n` +
    unaccepted
      .map(d =>
        `  ${d.path}\n` +
        `    reviewed at ${describeEntry(d.head)}\n` +
        `    merged   as ${describeEntry(d.merged)}`,
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
  // Parsed outside the main try so a refusal further down still knows where
  // the artefact goes. An argv this malformed has no --out to honour, and
  // that is the one case where no record is written.
  let args: Record<string, string[]>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`verify-merge-content: REFUSED — ${firstLine(e)}`);
    process.exit(REFUSE_EXIT);
  }
  const out = one(args, "out");
  // Written whatever the verdict, INCLUDING a refusal that throws before a
  // verdict exists — a refused run is exactly the run whose record somebody
  // needs afterwards. The first cut said this in a comment and did not do
  // it: every throwing refusal exited through a catch that wrote nothing.
  const record = (body: unknown) => {
    if (out) writeFileSync(out, `${JSON.stringify(body)}\n`);
  };

  try {
    const verdict = verifyMergeContent(
      one(args, "project"),
      one(args, "head"),
      one(args, "merged"),
      one(args, "base", "origin/main"),
      args.accept ?? [],
      one(args, "reason"),
    );
    const json = JSON.stringify(verdict);
    record(verdict);
    for (const w of verdict.warnings) console.error(`verify-merge-content: git warned — ${w}`);
    const unaccepted = unacceptedDivergences(verdict);
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
    record({ refused: firstLine(e) });
    console.error(`verify-merge-content: REFUSED — ${firstLine(e)}`);
    process.exit(REFUSE_EXIT);
  }
}
