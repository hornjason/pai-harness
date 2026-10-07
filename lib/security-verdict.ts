/**
 * The security review's gate verdict — the thing #129 is about.
 *
 * Twice in production rook returned `{"result":"FAIL"}` with a reproduced HIGH
 * guard bypass and the workflow returned SHIPPED and opened a PR. The verdict
 * was computed, logged and graded; nothing that could stop the run ever read
 * it. A review whose verdict goes nowhere is worse than no review, because it
 * manufactures the appearance of coverage.
 *
 * SOURCE OF TRUTH. `workflows/ship.js` carries inlined copies of all three
 * functions below, because the Workflow sandbox provides no module loading —
 * a top-level `require()` there killed every ship run before it spawned a
 * single agent (#69). The copies must stay behaviourally identical to these:
 * test/security-verdict-blocks.test.ts runs both over the same input matrix
 * and fails on any divergence. Change one, change the other.
 *
 * The same duplication has already drifted once in this repo — computeACHash
 * sorted its input and the inlined copy did not, so the "extracted" function
 * had never matched the code it replaced. That is what the agreement test is
 * for.
 */

/** A commit SHA: 7-40 hex, case-insensitive. Normalised to lowercase. */
const SHA = /^[0-9a-f]{7,40}$/i;

export interface SecurityVerdict {
  /** Whether the security agent returned anything at all. */
  spawned: boolean;
  /** PASS only when a real scope was reviewed and the reviewer passed it. */
  verdict: "PASS" | "FAIL";
  /** One entry per blocking problem. Non-empty whenever verdict is FAIL. */
  failures: string[];
}

/**
 * The commit the review is pinned to, or null.
 *
 * The value this is given comes back from an agent, so it is validated before
 * it is interpolated anywhere. Returning null rather than a fallback is the
 * point: there is no safe default commit to review, and "review HEAD" is
 * precisely the bug — rook's worktree is cut from origin/main, so HEAD there
 * yields an empty diff.
 */
export function rookReviewSha(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return SHA.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** Whether the security review still describes the commit the branch ends at. */
export interface ReviewCurrency {
  /** True only when both SHAs are real and name the same commit. */
  current: boolean;
  /** The commit the review was pinned to, normalised, or null if it was not one. */
  testedSha: string | null;
  /** The commit the branch ends at now, normalised, or null if it was not one. */
  headSha: string | null;
  /** Why the review is not current. Null when it is. */
  reason: string | null;
}

/**
 * Two SHAs name the same commit.
 *
 * Prefix comparison, because the two values reach this check at different
 * lengths by construction: the commit step reports `git rev-parse --short
 * HEAD` and the branch tip is read with `git rev-parse HEAD`. Requiring
 * character-for-character equality would report EVERY run stale, which is the
 * failure mode a staleness check can least afford — a gate that always refuses
 * gets switched off.
 *
 * This is git's own abbreviation rule and both inputs are already validated as
 * 7-40 hex, so the weakest comparison this makes is 28 bits. That is a real
 * limit and it is stated rather than hidden: a crafted collision would defeat
 * it. The failure being caught is a branch that moved on, not an adversary
 * choosing SHAs, and `git rev-parse` resolves abbreviations the same way.
 */
function sameCommit(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  return a.slice(0, n) === b.slice(0, n);
}

/**
 * Whether the security review's verdict still describes the code being shipped
 * (#169).
 *
 * #129 made rook's verdict block the run. It did not make the verdict a
 * statement about the PR: the review is pinned to one commit, and the
 * remediation rounds that follow it commit again to the same branch. Measured
 * on the #164 run — `agents.rook.testedSha` was 3fe336f1 while the branch tip
 * was ef998b73, and the diff between them rewrote ALL FOUR files rook had
 * reviewed, 236 insertions and 254 deletions. Rook passed a tree that no
 * longer existed, and the PR carried a `rook: PASS` that was true of nothing
 * in it.
 *
 * FAILS CLOSED. A missing SHA, a ref name, a SHA with a shell command in it,
 * an unreadable branch tip — none of them establishes that the reviewed code
 * is the shipped code, and absence of evidence is not evidence here either.
 * `current` is true only when both values are real SHAs and name one commit.
 */
export function reviewIsCurrent(testedSha: unknown, headSha: unknown): ReviewCurrency {
  const tested = rookReviewSha(testedSha);
  const head = rookReviewSha(headSha);

  if (!tested) {
    return {
      current: false,
      testedSha: null,
      headSha: head,
      reason:
        `the security review is not pinned to a commit (got ${describe(testedSha)}), ` +
        `so there is nothing to compare the branch tip against`,
    };
  }
  if (!head) {
    return {
      current: false,
      testedSha: tested,
      headSha: null,
      reason:
        `the branch tip could not be read as a commit SHA (got ${describe(headSha)}), ` +
        `so the review at ${tested} cannot be shown to describe it`,
    };
  }
  if (!sameCommit(tested, head)) {
    return {
      current: false,
      testedSha: tested,
      headSha: head,
      reason:
        `the security review was performed at ${tested} but the branch now ends at ${head} — ` +
        `the reviewed commit is not the commit this run would ship (#169)`,
    };
  }
  return { current: true, testedSha: tested, headSha: head, reason: null };
}

/**
 * The command the workflow hands the scope step.
 *
 * Throws rather than quoting when the SHA is not a SHA. A value needing
 * quoting here is not a commit SHA, and three consecutive security reviews of
 * this area each found a hole in a filter that tried to sanitise its way to
 * safety instead of refusing (shape allowlist → absolute paths → traversal →
 * `.env`). Refusal has no fourth hole.
 *
 * `projectRoot`, `harnessRoot` and `outPath` are workflow-supplied constants,
 * not agent output, and are interpolated as-is.
 */
export function rookScopeCommand(
  projectRoot: string,
  harnessRoot: string,
  sha: string,
  outPath: string,
): string {
  const pinned = rookReviewSha(sha);
  if (!pinned) {
    throw new Error(
      `rookScopeCommand: "${String(sha).slice(0, 80)}" is not a commit SHA — ` +
        `refusing to build a scope command the review cannot be pinned to`,
    );
  }
  // Quoted even though every path here is a workflow argument rather than
  // agent-reported text. ship.js:377 records an unquoted path that was
  // "obviously safe" until what fed it changed, and #155's own fix introduced
  // the same hole one layer out. A path with a space is the ordinary case this
  // also fixes. The SHA is refused above rather than quoted: a SHA that needs
  // quoting is not a SHA.
  const q = (w: string) => `'${String(w).replace(/'/g, "'\\''")}'`;
  return (
    `cd ${q(projectRoot)} && bun ${q(`${harnessRoot}/scripts/rook-review-scope.ts`)} ` +
    `--project ${q(projectRoot)} --sha ${pinned} --out ${q(outPath)}`
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Combine the git-derived scope and the reviewer's answer into one verdict.
 *
 * FAILS CLOSED EVERYWHERE. Every branch that cannot positively establish both
 * "a real, non-empty scope was determined by git" and "the reviewer read it
 * and passed it" returns FAIL. A missing field, a malformed field, a reviewer
 * that returned nothing, a verdict string nobody recognises — all of them are
 * the absence of evidence that the code is safe, and absence of evidence is
 * what this function is not allowed to read as evidence of absence.
 *
 * The scope is checked first and independently of the reviewer, because the
 * production failure was a PASS over zero files. "Found no problems in nothing"
 * and "found no problems" serialise to the same object.
 */
export function rookGateVerdict(scope: unknown, rook: unknown): SecurityVerdict {
  const failures: string[] = [];

  if (!isRecord(scope)) {
    failures.push(
      `the review scope was never established: the scope step returned ${describe(scope)}`,
    );
  } else if (scope.exitCode !== 0) {
    failures.push(
      `the review scope could not be established: scripts/rook-review-scope.ts reported ` +
        `exit ${describe(scope.exitCode)}`,
    );
  } else if (!Array.isArray(scope.files)) {
    failures.push(
      `the review scope is not a list of files (got ${describe(scope.files)}) — ` +
        `refusing to treat an unreadable scope as a reviewed one`,
    );
  } else if (scope.files.filter(f => typeof f === "string" && f.trim() !== "").length === 0) {
    // Counted, not `.length`. A report of `[""]` or `[null]` is the same
    // absence of a reviewed scope as `[]`, and length cannot tell them apart —
    // a fail-open inside the one function whose contract is to fail closed
    // everywhere. Entries are filtered rather than the whole report rejected:
    // git produces clean paths, so a stray blank beside a real path is noise,
    // not evidence that nothing was reviewed.
    failures.push(
      "the review scope is empty — the security review read zero files, so its verdict " +
        "says nothing about this change (#129)",
    );
  }

  const spawned = isRecord(rook);
  if (!spawned) {
    failures.push("the security review did not run");
  } else if (rook.result === "FAIL") {
    const detail = Array.isArray(rook.failures)
      ? rook.failures.map(f => String(f)).filter(f => f.trim() !== "")
      : [];
    if (detail.length > 0) {
      failures.push(...detail);
    } else {
      // gates/SCHEMA-GUIDE.md: a FAIL must carry a non-empty failures list.
      // A FAIL with nothing attached blocks the run without naming what to
      // fix, so say that much rather than recording an empty list.
      failures.push(
        "the security review returned FAIL with no findings attached — see the rook transcript",
      );
    }
  } else if (rook.result !== "PASS") {
    failures.push(
      `the security review returned no usable verdict (got ${describe(rook.result)})`,
    );
  }

  return {
    spawned,
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    failures,
  };
}

function describe(v: unknown): string {
  if (v === undefined) return "nothing";
  if (v === null) return "null";
  if (Array.isArray(v)) return `an array of ${v.length}`;
  if (typeof v === "object") return "an object";
  return JSON.stringify(v);
}
