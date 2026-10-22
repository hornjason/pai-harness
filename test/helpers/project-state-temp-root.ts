/**
 * A throwaway repo root that `scripts/update-project-state.ts` can be run
 * against (#1135).
 *
 * The script resolves its own root as `join(import.meta.dir, "..")`, with no
 * root parameter and no env override, so the only seam it offers is WHERE THE
 * COPY OF THE SCRIPT SITS. Put it in `<tmp>/scripts/` and every path it
 * derives — `project-state.json`, `PROJECT-STATE.md`, `specs/` — lands under
 * `<tmp>` instead of the checkout.
 *
 * This is the seam `test/project-state-shape.test.ts` already drives; it is
 * named here so the suite that was writing the real records can use it too.
 *
 * `lib` and `node_modules` are symlinked rather than copied: the script
 * imports `../lib/project-state-shape` and `../lib/local-calendar-day`, and
 * copying either would mean the test exercised a stale duplicate.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO = join(import.meta.dir, "..", "..");

export interface ProjectStateTempRoot {
  /** The fake repo root. `project-state.json` and `PROJECT-STATE.md` go here. */
  root: string;
  /** Absolute path to the copied script, for `spawnSync`/`execSync`. */
  script: string;
  /** `<root>/specs` — empty, so SC promotion is whatever the test puts in it. */
  specs: string;
  /** Delete the whole tree. Safe to call twice. */
  cleanup(): void;
}

export function makeProjectStateTempRoot(prefix = "ps-root-"): ProjectStateTempRoot {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "specs"));
  symlinkSync(join(REPO, "lib"), join(root, "lib"));
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
  cpSync(join(REPO, "scripts", "update-project-state.ts"), join(root, "scripts", "update-project-state.ts"));
  return {
    root,
    script: join(root, "scripts", "update-project-state.ts"),
    specs: join(root, "specs"),
    // `rmSync` on the root removes the symlinks themselves, not their
    // targets — `recursive` does not follow a symlinked directory.
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
