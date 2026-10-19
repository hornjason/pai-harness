#!/usr/bin/env bun
/**
 * Ask about — and optionally delete — a run's `rungate/run-<issue>` branch
 * (#640).
 *
 * `workflows/ship.js` cannot do any of this itself: it makes zero subprocess
 * calls and has no filesystem (#69). It already delegates the same way for
 * the build commit, the suite measurement and the harness provenance — an
 * agent runs a command, and the command answers.
 *
 * Three questions, three modes, because they are asked at three different
 * moments and conflating them would make one answer stand in for another:
 *
 *   --mode leftover   at the start: does this branch already exist, and is
 *                     anything on it unaccounted for on the base?
 *   --mode drift      at the end: the primary's branch before and after.
 *   --mode delete     at the end: remove the branch, and REFUSE when its
 *                     content is not already on the base.
 *
 * Usage:
 *   bun scripts/check-run-branch.ts --mode leftover --repo <dir> --issue <n> --base <ref>
 *   bun scripts/check-run-branch.ts --mode drift --before <branch> --after <branch>
 *   bun scripts/check-run-branch.ts --mode delete --repo <dir> --issue <n> --base <ref>
 *
 * Prints one JSON reading on stdout; diagnostics go to stderr.
 *
 * TWO PROPERTIES THIS FILE MUST KEEP:
 *
 *   1. Every refusal exits through `REFUSE_EXIT`, declared exactly once, so
 *      there is one site to mutate and a test can prove the refusal is what
 *      a case observed.
 *   2. It decides nothing itself. Containment, drift and the leftover
 *      reading all come from `lib/run-branch.ts`, so there is ONE binding
 *      to mutate rather than a script and a library that agree
 *      (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
 */

import {
  branchContainment,
  checkoutDrift,
  checkoutDriftRefusal,
  containmentRefusal,
  leftoverRunBranch,
  runBranchName,
  runBranchRefs,
} from "../lib/run-branch";
import { gitRead } from "../lib/tree-entries";

/** The one exit code every refusal travels through. */
export const REFUSE_EXIT = 1;

const MODES = new Set(["leftover", "drift", "delete"]);
const OPTIONS = new Set(["mode", "repo", "issue", "base", "before", "after"]);

export class RunBranchRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunBranchRefused";
  }
}

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z][a-z-]*)$/.exec(argv[i]);
    if (!m || !OPTIONS.has(m[1])) {
      throw new RunBranchRefused(`unexpected argument "${String(argv[i]).slice(0, 80)}"`);
    }
    const value = argv[++i];
    if (value === undefined) throw new RunBranchRefused(`--${m[1]} needs a value`);
    out[m[1]] = value;
  }
  if (!out.mode) throw new RunBranchRefused("--mode is required (leftover, drift or delete)");
  if (!MODES.has(out.mode)) {
    throw new RunBranchRefused(`--mode must be one of leftover, drift, delete — not "${out.mode}"`);
  }
  // Checked per mode rather than globally: --repo is meaningless to `drift`,
  // and requiring it would make the refusal a sentence about an argument
  // nobody needs rather than about the thing that is missing.
  //
  // PRESENT, not non-empty, and the difference is the whole of `drift`. An
  // empty `--after` is what a caller reports when it LOOKED and got
  // nothing, which is a reading `checkoutDrift` has an answer for
  // (UNMEASURED). Refusing it here as "missing" would collapse "I could not
  // read the branch" into "you forgot the flag" and make the library's
  // UNMEASURED arm unreachable from the command line.
  for (const k of out.mode === "drift" ? ["before", "after"] : ["repo", "issue", "base"]) {
    if (!(k in out)) throw new RunBranchRefused(`--${k} is required for --mode ${out.mode}`);
  }
  // A path or a ref, though, is a caller bug when empty rather than a
  // reading: there is no sense in which "" names a repository.
  if (out.mode !== "drift") {
    for (const k of ["repo", "issue", "base"]) {
      if (!out[k].trim()) throw new RunBranchRefused(`--${k} is required for --mode ${out.mode}`);
    }
  }
  return out;
}

/**
 * Delete the branch, or say why not.
 *
 * Exported and taking the reading rather than re-asking for it, so the
 * decision and the deletion are one binding: a second containment question
 * here would survive any mutation of the first and the guard would read as
 * covered while nothing depended on it.
 */
export function deleteRunBranch(
  repo: string,
  issue: number | string,
  base: string,
): {
  deleted: boolean
  branch: string
  reading: string
  detail: string
  refsReading: string
  resolvedRef: string | null
  resolvedSha: string | null
} {
  const branch = runBranchName(issue);

  // WHICH commit the name points at, before anything is compared or removed.
  //
  // This is the destructive mode, so it is the one place the local-only
  // resolution cost real work: a local head BEHIND the push reads CONTAINED
  // against the base and `git branch -D` then destroys the commits that
  // exist only under the remote name. Resolving both refs first means the
  // deletion is authorised by a reading that knows what it is about, and a
  // name that resolves to two commits authorises nothing (#640).
  const refs = runBranchRefs(repo, branch);
  const refsFloor = {
    deleted: false,
    branch,
    refsReading: refs.reading,
    resolvedRef: refs.resolvedRef ?? null,
    resolvedSha: refs.resolvedSha ?? null,
  };
  if (refs.reading === "DIVERGED" || refs.reading === "UNMEASURED") {
    return { ...refsFloor, reading: refs.reading, detail: refs.refusal };
  }
  if (refs.reading === "ABSENT") {
    return {
      ...refsFloor,
      reading: "ABSENT",
      detail: `no ref named ${branch} exists locally or on origin, so there is nothing to delete (#640)`,
    };
  }
  if (refs.reading === "REMOTE_ONLY") {
    // `git branch -D` only removes local heads. Reporting a deletion here
    // would be reporting a command git declined to perform, and deleting the
    // remote-tracking ref instead would hide a branch that still exists on
    // the remote.
    return {
      ...refsFloor,
      reading: "REMOTE_ONLY",
      detail:
        `${branch} exists only as ${refs.resolvedRef} (${refs.resolvedSha.slice(0, 12)}) and not as a local ` +
        "head. `git branch -D` removes local heads, so there is nothing here this can delete — the branch " +
        "on the remote is not this run's to remove (#640)",
    };
  }

  // The RESOLVED ref, never the bare name: the bare name resolves to the
  // local head by git's own rules, which is the reading that can be about a
  // commit the run never pushed.
  const containment = branchContainment(repo, refs.resolvedRef, base);
  const refusal = containmentRefusal(containment);
  if (refusal) {
    return { ...refsFloor, reading: containment.reading, detail: refusal };
  }
  // Narrowed off `refusal` above, which is null for CONTAINED and only
  // CONTAINED — but `containmentRefusal` is a function, so the compiler
  // cannot see that. Asserted rather than cast: a cast would make a future
  // fourth reading with no refusal fall through to a deletion.
  if (containment.reading !== "CONTAINED") {
    throw new RunBranchRefused(
      `${branch}: reading ${containment.reading} produced no refusal, which is not a verdict to delete on`,
    );
  }
  // `-D`, not `-d`. git's own `-d` asks the ANCESTRY question, and every
  // branch this repo creates is squash-merged, so `-d` refuses all of them
  // — the exact failure mode `lib/run-branch.ts` exists to avoid. The
  // containment reading above is the safety check, and it is a stricter one
  // than `-d` performs.
  gitRead(repo, ["branch", "-D", branch]);
  return {
    ...refsFloor,
    deleted: true,
    reading: containment.reading,
    detail:
      `deleted ${branch} at ${refs.resolvedRef} (${refs.resolvedSha.slice(0, 12)}): all ` +
      `${containment.comparedPaths} changed path(s) are present on ${base}, compared by blob and mode ` +
      "rather than by ancestry (#640)",
  };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));

    if (args.mode === "drift") {
      const reading = checkoutDrift(args.before, args.after);
      console.log(JSON.stringify(reading, null, 2));
      const refusal = checkoutDriftRefusal(reading);
      if (refusal) {
        // Loud, and non-zero: a shared checkout left on a run branch is the
        // state every other session then reads, and #640's first measured
        // cost. Exiting zero here would make it a log line nobody acts on.
        throw new RunBranchRefused(refusal);
      }
    } else if (args.mode === "leftover") {
      const reading = leftoverRunBranch(args.repo, args.issue, args.base);
      console.log(JSON.stringify(reading, null, 2));
      // Reported, never refused. An interrupted run's branch is usually
      // exactly what you want to resume onto, and a gate that stopped every
      // re-run is a gate that gets switched off.
      if (reading.reading !== "ABSENT") console.error(reading.notice);
    } else {
      const result = deleteRunBranch(args.repo, args.issue, args.base);
      console.log(JSON.stringify(result, null, 2));
      // The READING leads the sentence. #640's second gap was an output that
      // answered confidently without saying what it had answered about, and a
      // refusal whose class is only recoverable by reading the prose is the
      // same defect one layer out.
      if (!result.deleted) throw new RunBranchRefused(`${result.reading}: ${result.detail}`);
    }
  } catch (e: any) {
    console.error(
      e instanceof RunBranchRefused ? `REFUSED: ${e.message}` : `UNREADABLE: ${e?.message || e}`,
    );
    process.exit(REFUSE_EXIT);
  }
}
