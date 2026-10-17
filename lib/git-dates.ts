/**
 * Every path's most recent commit date, from ONE git subprocess (#323).
 *
 * A LEAF module (#508). The implementation and its history live below,
 * unchanged, moved out of `lib/conformity.ts` so a CLI can use it:
 * conformity imports `bun:test` at module scope, and
 * `scripts/extract-constraints.ts` runs outside a test runner. It is
 * re-exported from `lib/conformity.ts`, which is the name every existing
 * caller and SC-842 knows — one binding, two names, the same arrangement
 * `isHarnessItself` has with `lib/harness-identity.ts` (#380).
 *
 * The second caller is why this moved. `computeStaleness` in
 * `scripts/extract-constraints.ts` was still spawning one `git log` per
 * document — the exact code #323 replaced here, in a file #323 did not
 * touch — and HYGIENE-6 was timing out at 5001ms because of it.
 */
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

export function lastCommitDates(root: string, pathspecs: string[]): Map<string, string> {
  const lastCommit = new Map<string, string>();
  // Not a git repository: nothing is tracked, so no path has a commit date.
  // That is a real answer, not a failure, and scaffolded projects hit it.
  if (!existsSync(join(root, ".git"))) return lastCommit;
  if (pathspecs.length === 0) return lastCommit;
  {
    const log = spawnSync(
      "git",
      ["-C", root, "log", "--format=%H %ci", "--name-only", "--", ...pathspecs],
      { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
    );
    if (log.error) {
      throw new Error(`lastCommitDates: git log could not run in ${root}: ${log.error.message}`);
    }
    if (log.status !== 0) {
      throw new Error(
        `lastCommitDates: git log exited ${log.status} in ${root}: ` +
          `${log.stderr?.toString().trim() || "(no stderr)"}`,
      );
    }
    let currentDate = "";
    for (const line of log.stdout.toString().split("\n")) {
      const header = /^[0-9a-f]{7,40} (\d{4}-\d{2}-\d{2})/.exec(line);
      if (header) {
        currentDate = header[1];
        continue;
      }
      const path = line.trim();
      if (!path || !currentDate) continue;
      if (!lastCommit.has(path)) lastCommit.set(path, currentDate);
    }
  }
  return lastCommit;
}
