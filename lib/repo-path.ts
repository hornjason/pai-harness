/**
 * One function that turns a string into a comparable repository path (#1437).
 *
 * Covers CRC-E2's precondition (CODE-REVIEW-CONVERGENCE-SPEC.md): a classifier
 * that reads the change can only be trusted if both sides of every path
 * comparison were spelled by the same hand.
 *
 * ## Why this is its own module
 *
 * The first version of this lived inside `lib/scaffold/ai-review-findings.ts`,
 * where it decides whether a finding names a file the pull request touched.
 * `lib/risk-tier.ts` needs the identical question answered — does this changed
 * path sit under a sensitive prefix — and two private answers to one question
 * are behaviourally ONE decider with a dead copy nobody can identify
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
 *
 * So the function lives here and both import it. The findings module still
 * carries its own copy while #1435 is open; collapsing that one into this
 * import is a one-line follow-up once #1435 lands, and it is deliberately NOT
 * done from this branch — chaining onto an unmerged tip replays commits a
 * squash merge is about to rewrite.
 *
 * ## What it refuses, and why refusing is the point
 *
 * A path it cannot read returns `null`, and every caller must decide what
 * `null` means for it. Both current callers decide the same way — toward the
 * stricter answer, blocking or HIGH — because the alternative is a gate that
 * fails open on input it did not understand, which is the exact defect the
 * push review found in the findings module's round one: six spellings of a
 * file that WAS in the change list each read as "not in the change list" and
 * demoted a `critical` to CLEAN.
 *
 * Git C-quoting (`"lib/\303\251.ts"`) is refused rather than decoded. Decoding
 * it wrongly is the same fail-open wearing a different hat, and a caller that
 * is told "I could not read this" can route to a person; a caller handed a
 * mis-decoded path cannot tell that anything happened.
 */

/**
 * A repository-relative path in a single spelling, or `null` when the input
 * cannot be read as one.
 *
 * Normalises: backslash separators, a leading `./`, leading slashes, a
 * trailing `:line` or `:line:col` suffix, and case. Refuses: anything that is
 * not a string, a git C-quoted path, and anything whose remaining shape is not
 * a plain sequence of path segments.
 */
export function normaliseRepoPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let p = value.trim().replace(/\\/g, "/");
  // A C-quoted path is refused, not decoded — see the module docblock.
  if (p.startsWith('"') && p.endsWith('"')) return null;
  p = p.replace(/^\/+/, "").replace(/:\d+(?::\d+)?$/, "");

  // Dot segments are COLLAPSED, not stripped once. A single `.replace(/^\.\//)`
  // removes one leading `./` and leaves `././lib/a.ts` as `./lib/a.ts`, which
  // the shape test below accepts — `.` and `..` are both legal matches for
  // `[\w.@+-]+`. The result compares unequal to `lib/a.ts` and every caller
  // reads that as "a different file", which is this module's fail-open in its
  // purest form: an attacker-chosen spelling of a path that IS in the change
  // list reads as one that is not. Found by the push review on #1435.
  //
  // A `..` that would leave the repository root is refused rather than
  // clamped: `../outside.ts` is not a repository-relative path, and silently
  // turning it into `outside.ts` invents a file.
  const out: string[] = [];
  for (const segment of p.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.pop() === undefined) return null;
      continue;
    }
    out.push(segment);
  }
  p = out.join("/");
  if (p === "") return null;

  return /^(?:[\w.@+-]+\/)*[\w.@+-]+$/.test(p) ? p.toLowerCase() : null;
}

/**
 * Does `path` sit at or under `prefix`? Both sides are normalised first.
 *
 * Segment-aware on purpose: `.github/workflows` must not match
 * `.github/workflows-archive/x.yml`, which a bare `startsWith` would.
 * Returns false when either side cannot be read — the caller decides what an
 * unreadable path means, and this function never invents an answer.
 */
export function underPrefix(path: unknown, prefix: string): boolean {
  const p = normaliseRepoPath(path);
  const q = normaliseRepoPath(prefix.replace(/\/+$/, ""));
  if (p === null || q === null) return false;
  return p === q || p.startsWith(`${q}/`);
}
