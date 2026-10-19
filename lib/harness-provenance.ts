/**
 * Which harness graded this run? (#602)
 *
 * ## The silence, not the version
 *
 * `workflows/ship.js` resolves its gate machinery out of `harnessRoot` —
 * a checkout on somebody's disk — and nothing has ever said which version
 * that was. On 2026-10-18 the primary was 82 files and 10,527 insertions
 * behind `origin/main`, including 44 lines of `gates/schema.ts` and 22 of
 * `lib/evidence-prevalidator.ts`. Three runs that session were graded by a
 * validator missing changes those very runs merged.
 *
 * **A stale harness and a current one emit byte-identical artefacts.**
 * That is the whole defect: not that the checkout drifts — checkouts drift
 * — but that a run reporting PASS cannot be distinguished from a run that
 * reported PASS because the refusal had not been written yet.
 *
 * The direction is the bad one. A stale harness is strictly MORE
 * permissive, because every refusal added since the checkout last moved is
 * simply absent.
 *
 * ## What this does not do
 *
 * It does not pull, and it must not. Swapping `gates/` and `lib/` under a
 * run already in flight produces a half-old, half-new grade that nothing
 * can reproduce. It does not fetch either: a fetch is a network side
 * effect in the middle of a grade, and an offline run would then report a
 * staleness it had invented. It reads what is already on disk and says so.
 *
 * ## Three readings, and `UNMEASURED` is one of them
 *
 * `0`, `{}`, `null` and silence are indistinguishable from success;
 * UNMEASURED is not (`.claude/rules/config-access.md`). A harness whose
 * SHA cannot be read has not been proven current — it has not been
 * *asked*, and those are different states.
 */
import { spawnSync } from "child_process";

import { isCommitSha } from "./commit-sha";

/**
 * The directories a run's grade actually depends on.
 *
 * Not the whole tree. A dirty `README.md` does not change a verdict, and a
 * check that refused on one would be a refusal everybody learns to click
 * past — which is worse than no check, because it trains people past the
 * cases that matter. These three are what `ship.js` loads: `gates/` is the
 * gate machinery, `lib/` is everything the gates import, and `workflows/`
 * is the run script itself.
 */
export const GRADING_PATHS = ["gates", "lib", "workflows"] as const;

export type HarnessProvenance =
  | {
      reading: "MEASURED";
      /** HEAD of the harness checkout, as a SHA — never a ref name. */
      sha: string;
      /** The branch HEAD is on, or `null` when detached. Informational. */
      branch: string | null;
      /**
       * Paths under `GRADING_PATHS` with uncommitted changes. Empty means
       * clean, and it means it because the probe succeeded — an unreadable
       * status makes the whole reading UNMEASURED rather than this empty.
       */
      dirty: string[];
      /**
       * Commits HEAD is behind its configured upstream, or `null` when
       * there is no upstream to compare against.
       *
       * `null` is NOT zero. A checkout with no upstream is one nobody can
       * say anything about, and reporting 0 for it would be the silent
       * default this module exists to refuse.
       */
      behind: number | null;
      /** Why `behind` is null, when it is. `null` when it is a number. */
      behindReason: string | null;
    }
  | { reading: "UNMEASURED"; reason: string };

/**
 * `raw` is the untrimmed stdout and `out` is the trimmed one.
 *
 * Both, because porcelain status is COLUMN-SIGNIFICANT: a modified file
 * arrives as `" M gates/schema.ts"`, and trimming eats the leading space
 * so any fixed-width slice then cuts one character into the path. That
 * produced `"ates/schema.ts"` here, caught by this module's own test.
 * Every other probe in this file wants the trimmed form.
 */
function git(root: string, args: string[]): { out: string; raw: string; ok: boolean; err: string } {
  const r = spawnSync("git", ["-C", root, ...args], { timeout: 15_000, encoding: "utf-8" });
  if (r.error) return { out: "", raw: "", ok: false, err: r.error.message };
  const raw = String(r.stdout ?? "");
  return {
    out: raw.trim(),
    raw,
    ok: r.status === 0,
    err: String(r.stderr ?? "").trim().split("\n")[0] ?? "",
  };
}

/**
 * The paths in a `git status --porcelain -z` reading.
 *
 * `-z` for the reason `lib/test-case-deletion.ts` gives at greater
 * length: without it, any path with a non-ASCII byte, a quote, a tab or a
 * newline comes back C-quoted — `"caf\303\251.ts"`, quotes included — and
 * the name in the report is then not the name on disk.
 *
 * A rename record is `XY <new>\0<old>`, so the field after one is an
 * ORIGIN path and not a status record. Treating it as one would report a
 * path with its first three characters eaten, which is the same defect
 * this function exists to avoid, arriving from the other side.
 */
export function porcelainPaths(raw: string): string[] {
  const fields = raw.split("\0").filter(f => f !== "");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.length < 4) continue;
    paths.push(f.slice(3));
    // R and C carry their source path in the next field. Skip it.
    if (f[0] === "R" || f[0] === "C" || f[1] === "R" || f[1] === "C") i++;
  }
  return paths.sort();
}

/**
 * The provenance of one harness checkout.
 *
 * ONE discriminator, `reading`. Every field is a projection of the probes
 * taken here and nowhere else, so no two of them can disagree, and a
 * caller wanting a boolean derives it with `harnessProvenanceWarning`
 * rather than re-asking git.
 */
export function harnessProvenance(harnessRoot: string): HarnessProvenance {
  const root = String(harnessRoot ?? "");
  if (!root.trim()) {
    return { reading: "UNMEASURED", reason: "no harnessRoot was given, so there is no checkout to read" };
  }

  const head = git(root, ["rev-parse", "HEAD"]);
  if (!head.ok || !isCommitSha(head.out)) {
    return {
      reading: "UNMEASURED",
      reason:
        `the harness checkout at ${JSON.stringify(root)} has no readable HEAD ` +
        `(${head.err || `git printed ${JSON.stringify(head.out)}`}), so nothing says which harness graded this run`,
    };
  }

  // `--porcelain` with explicit pathspecs, so the reading is scoped to what
  // a grade depends on and the format is the stable one. Untracked files
  // count: an untracked `lib/x.ts` is loadable code the remote does not
  // have, which is the same divergence as a modified one.
  //
  // `-uall` is load-bearing and not a flourish. The default collapses
  // untracked files into their containing directory — a brand-new
  // `workflows/ship.js` is reported as `workflows/`, and a wholly
  // untracked `gates/` is reported as `gates/` whether it holds one file
  // or a hundred. The reading would then name a directory in a message
  // whose job is to tell an operator which file to look at, and a
  // one-file divergence and a hundred-file one would be the same string.
  // Caught by this module's own test, which expected a filename.
  const status = git(root, ["status", "--porcelain", "-z", "-uall", "--", ...GRADING_PATHS]);
  if (!status.ok) {
    // Refused rather than reported clean. An unreadable status and a clean
    // one both produce an empty list, and only one of them is a reading.
    return {
      reading: "UNMEASURED",
      reason:
        `the harness checkout at ${JSON.stringify(root)} is at ${head.out}, but its status could not be ` +
        `read (${status.err || "git exited non-zero"}), so whether the grading code on disk matches ` +
        "that commit is unknown — and unknown is not clean",
    };
  }
  const dirty = porcelainPaths(status.raw);

  const branchRead = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchRead.ok && branchRead.out !== "HEAD" ? branchRead.out : null;

  // No fetch. This compares against the upstream ref as it already stands
  // on disk, which is a reading of "behind what I last saw", not "behind
  // the server". Saying which is the difference between a number and a
  // claim, so `behindReason` carries it when the number is unavailable.
  const upstream = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  let behind: number | null = null;
  let behindReason: string | null = null;
  if (!upstream.ok || upstream.out === "") {
    behindReason = `HEAD has no configured upstream (${upstream.err || "git named none"})`;
  } else {
    const count = git(root, ["rev-list", "--count", `HEAD..${upstream.out}`]);
    const n = Number(count.out);
    if (!count.ok || !Number.isInteger(n) || n < 0) {
      behindReason =
        `the distance from HEAD to ${upstream.out} could not be counted ` +
        `(${count.err || `git printed ${JSON.stringify(count.out)}`})`;
    } else {
      behind = n;
    }
  }

  return { reading: "MEASURED", sha: head.out, branch, dirty, behind, behindReason };
}

/**
 * The sentence a run summary should carry, or `null` when there is nothing
 * to say.
 *
 * Derived from `harnessProvenance` and never from a second probe. Three
 * things make it non-null, and they are reported together rather than as
 * the first one found: a run can be both dirty and behind, and a message
 * naming one of them sends an operator to fix half the problem.
 *
 * It is a WARNING and not a refusal. #602 asks for *"refuse — or at
 * minimum emit a loud UNMEASURED"*, and this takes the second: the
 * decision to stop a run on a dirty harness is an operator's, and a
 * refusal that fires on the ordinary state of a development checkout is
 * one that gets switched off. What must not happen is silence.
 */
export function harnessProvenanceWarning(p: HarnessProvenance): string | null {
  if (p.reading === "UNMEASURED") {
    return `HARNESS_UNMEASURED: ${p.reason}. A run whose grader cannot be identified has not been graded in any reproducible sense (#602)`;
  }
  const parts: string[] = [];
  if (p.dirty.length > 0) {
    parts.push(
      `it has ${p.dirty.length} uncommitted change(s) under ${GRADING_PATHS.join("/, ")}/ ` +
        `(${p.dirty.slice(0, 8).join(", ")}${p.dirty.length > 8 ? ", …" : ""}), so the code that graded ` +
        `this run is not the code at ${p.sha}`,
    );
  }
  if (p.behind !== null && p.behind > 0) {
    parts.push(
      `it is ${p.behind} commit(s) behind its upstream, so every refusal added since is absent from this ` +
        "grade — a stale harness is strictly more permissive than a current one",
    );
  }
  if (p.behind === null) {
    parts.push(`whether it is behind its upstream is unknown: ${p.behindReason}`);
  }
  if (parts.length === 0) return null;
  return `HARNESS_DIVERGENCE (${p.sha}${p.branch ? ` on ${p.branch}` : " detached"}): ${parts.join("; ")} (#602)`;
}
