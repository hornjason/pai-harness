/**
 * Who owns the harness work root, and may this process delete inside it (#904).
 *
 * ## The harm this exists to stop
 *
 * `lib/stale-cleanup.ts` walks every top-level directory under the harness
 * work root and renames or deletes it on `mtime` and `phase` alone. It has
 * never had an ownership check. On asaCommandCenter's pool, ten runner
 * processes share `/home/gharunner`, so they also share
 * `$HOME/.rungate` — and a SessionStart on runner-5 archives runner-4's live
 * run directory the moment runner-4's `workflow-state.json` looks stale.
 *
 * The failure that produces is NON-LOCAL. Runner-4 fails in a step that did
 * nothing wrong, because a sibling moved a file underneath it. It reads as a
 * flaky test, which is the worst possible disguise for a contention bug.
 *
 * ## Why this is not the `$HOME`-in-the-workflow fix
 *
 * The cheapest wrong fix is `HOME: ${{ runner.temp }}/home` in the workflow
 * YAML. The symptom goes away for CI and the harness keeps its one unguarded
 * `$HOME` assumption: a consumer who runs the same jobs without that line
 * gets the original bug back, and nothing in the harness says so. The check
 * here is on the sweep's behaviour, so it is unaffected by that line either
 * way — which is the point. A regression test that goes green when you edit
 * the workflow file is testing the workflow file.
 *
 * ## Why an empty `$HOME` cannot see this
 *
 * `scripts/test-clean-env.ts` runs suites with `HOME` at an empty `mkdtemp`.
 * An empty work root archives nothing whether the sweep is ownership-aware or
 * not, so the isolation bug is invisible to exactly the suites that look most
 * rigorous. The discriminating input is a work root that is POPULATED with
 * another runner's directory: the ownership-blind sweep archives it, the
 * guarded one refuses and names the owner.
 *
 * ## The lifecycle, and why auto-claim is safe only when vacant
 *
 * Claiming a root that already holds state would let whichever runner booted
 * first assume ownership of everybody's work — the original bug with a marker
 * file on top. So a claim happens only when there is nothing to destroy:
 *
 * - vacant root, no marker  → claim it, sweep (a no-op this time round)
 * - marker names this runner → sweep, exactly as before
 * - marker names another     → REFUSE, and name the other runner
 * - occupied, no marker      → REFUSE; nothing here can be attributed
 * - not on a runner at all   → sweep, exactly as before
 *
 * The last line is why this change is inert on a developer's machine and in
 * every existing test: `RUNNER_NAME` is a GitHub Actions variable, so off a
 * runner the verdict is `unscoped` and the sweep behaves as it always has.
 *
 * Once each runner has its own `HOME` (#904's infrastructure half), each
 * private root is vacant on its first job, claims itself, and sweeps normally
 * forever after. This check is what converts that isolation into something
 * measurable instead of something assumed.
 *
 * ## Zero is not success
 *
 * A refused sweep returns `archived: 0`, which is indistinguishable from "a
 * clean root with nothing to archive". That ambiguity is the reason
 * `sweep: false` and `reason` exist as fields rather than as a log line:
 * silence, `0` and `null` must not all mean the same thing.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

/** Basename of the ownership marker written at the root of the work dir. */
export const WORK_ROOT_OWNER_FILE = ".owner";

/**
 * Directory entries that do not count as occupancy.
 *
 * `.archive` is excluded only when it is EMPTY — an archive holding another
 * runner's directories is occupancy, and treating the directory's mere
 * existence as vacancy would let a root be claimed out from under the very
 * state the sweep already moved there.
 */
const VACANCY_EXEMPT = new Set([WORK_ROOT_OWNER_FILE, ".archive"]);

export const WORK_ROOT_REFUSED_SHARED =
  "the harness work root is claimed by a DIFFERENT runner, so the stale " +
  "sweep refused: archiving here would move a sibling runner's live state " +
  "out from under it, and the job that fails is the sibling's, not this one " +
  "(#904). Give each runner its own HOME.";

export const WORK_ROOT_REFUSED_UNATTRIBUTED =
  "the harness work root already holds run state but records no owning " +
  "runner, so the stale sweep refused: on a shared HOME nothing here can be " +
  "attributed to this runner, and an unattributed delete is the bug (#904).";

export const WORK_ROOT_REFUSED_UNNAMABLE =
  "RUNNER_NAME is set but contains no characters usable as an owner id, so " +
  "the stale sweep refused: this runner cannot be told apart from a sibling " +
  "and ownership cannot be decided (#904).";

export type WorkRootState =
  | "unscoped"
  | "vacant"
  | "claimed"
  | "owned"
  | "shared"
  | "unattributed"
  | "unnamable";

export interface WorkRootVerdict {
  /** May this process delete or archive inside the work root? */
  readonly sweep: boolean;
  readonly state: WorkRootState;
  /** This process's runner id, or `null` when not running on a runner. */
  readonly runner: string | null;
  /** The id recorded in the marker file, or `null` when there is none. */
  readonly owner: string | null;
  /** One of the exported refusal constants, and non-null exactly when `sweep` is false. */
  readonly reason: string | null;
}

/**
 * Filesystem-safe form of a runner name.
 *
 * GitHub Actions names hosted runners "GitHub Actions 2" — spaces and all —
 * so the raw value is not usable as a path component or a stable token.
 */
function slugifyRunner(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/**
 * This process's runner id, or `null` when it is not running on a runner.
 *
 * Returns `null` for BOTH "absent" and "unusable", so callers that need to
 * tell a developer's laptop from a misconfigured runner must read
 * `workRootOwnership`'s verdict instead — `null` here is deliberately not a
 * licence to sweep.
 */
export function runnerId(env: NodeJS.ProcessEnv = process.env): string | null {
  const slug = slugifyRunner(env.RUNNER_NAME ?? "");
  return slug === "" ? null : slug;
}

/**
 * An `.archive` that cannot be read counts as OCCUPIED, not as empty — an
 * unreadable directory is a thing this process knows nothing about, and the
 * safe reading of "I could not tell" is "do not claim this root".
 */
function archiveIsEmpty(workRoot: string): boolean {
  try {
    return readdirSync(join(workRoot, ".archive")).length === 0;
  } catch {
    return false;
  }
}

function isVacant(workRoot: string): boolean {
  let names: string[];
  try {
    names = readdirSync(workRoot);
  } catch {
    // Unreadable or absent: there is nothing here this process could destroy.
    return true;
  }
  for (const name of names) {
    if (!VACANCY_EXEMPT.has(name)) return false;
    if (name === ".archive" && !archiveIsEmpty(workRoot)) return false;
  }
  return true;
}

function readOwner(workRoot: string): string | null {
  const marker = join(workRoot, WORK_ROOT_OWNER_FILE);
  if (!existsSync(marker)) return null;
  try {
    const recorded = readFileSync(marker, "utf-8").trim();
    return recorded === "" ? null : recorded;
  } catch {
    return null;
  }
}

/**
 * Record `runner` as the owner of `workRoot`.
 *
 * Exported so that a consumer provisioning a genuinely private `HOME` can
 * claim it up front rather than waiting for a vacant-root job to do it.
 * Idempotent, and deliberately silent on failure: an unwritable root is
 * reported by the next verdict as `unattributed`, which refuses, rather than
 * by throwing out of a SessionStart hook.
 */
export function claimWorkRoot(workRoot: string, runner: string): boolean {
  try {
    mkdirSync(workRoot, { recursive: true });
    writeFileSync(join(workRoot, WORK_ROOT_OWNER_FILE), `${runner}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether this process may delete inside `workRoot`.
 *
 * Claims a vacant root as a side effect; see the module docblock for why that
 * is the only case in which claiming cannot harm a sibling.
 */
export function workRootOwnership(
  workRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): WorkRootVerdict {
  const raw = env.RUNNER_NAME ?? "";
  if (raw.trim() === "") {
    return { sweep: true, state: "unscoped", runner: null, owner: null, reason: null };
  }

  const runner = slugifyRunner(raw);
  if (runner === "") {
    return {
      sweep: false,
      state: "unnamable",
      runner: null,
      owner: null,
      reason: WORK_ROOT_REFUSED_UNNAMABLE,
    };
  }

  const owner = readOwner(workRoot);
  if (owner !== null) {
    return owner === runner
      ? { sweep: true, state: "owned", runner, owner, reason: null }
      : {
          sweep: false,
          state: "shared",
          runner,
          owner,
          reason: WORK_ROOT_REFUSED_SHARED,
        };
  }

  if (!isVacant(workRoot)) {
    return {
      sweep: false,
      state: "unattributed",
      runner,
      owner: null,
      reason: WORK_ROOT_REFUSED_UNATTRIBUTED,
    };
  }

  const claimed = claimWorkRoot(workRoot, runner);
  return {
    sweep: true,
    state: claimed ? "claimed" : "vacant",
    runner,
    owner: claimed ? runner : null,
    reason: null,
  };
}

/**
 * The log line a refusing sweep emits.
 *
 * One formatter so the reason, the two runner ids and the path always travel
 * together: a refusal that named neither party would be exactly as mysterious
 * as the silent delete it replaces.
 */
export function workRootRefusalLine(workRoot: string, verdict: WorkRootVerdict): string {
  return (
    `REFUSED sweep state=${verdict.state} runner=${verdict.runner ?? "?"} ` +
    `owner=${verdict.owner ?? "none"} path=${workRoot} :: ${verdict.reason}`
  );
}
