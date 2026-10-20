/**
 * Where a prove run's UI evidence lives, and what is actually in it (#809).
 *
 * ## The defect
 *
 * `workflows/prove.js` globbed **all of `/tmp`** for
 * `playwright-screenshot.*\.png$|browser-screenshot.*\.png$`, handed every
 * match to `uploadScreenshotsToIssue`, and embedded the resulting PUBLIC gist
 * links in a PR comment. Nothing scoped that read to this run, this issue, or
 * this project, on a machine that routinely carries a dozen concurrent
 * worktrees.
 *
 * It never fired, and the reason is worth keeping because it is the more
 * serious half. Playwright's `browser_take_screenshot` writes
 * `.playwright-mcp/page-{timestamp}.png` under the workspace root when given
 * no `filename` — not `/tmp`, and matching neither pattern. Measured across
 * the machine this was found on: 96 files produced by the tool between
 * 2026-09-28 and 2026-10-19, and zero ever named for either pattern. So the
 * glob could not match its producer, UI evidence had never been attached to
 * any pull request, and the phase reported success every time because
 * `markdownLinks.length > 0` was simply false.
 *
 * ## Why a directory rather than a better pattern
 *
 * A narrower glob is still a guess about a filename somebody else chooses.
 * `prove.js` now creates this directory, tells Quinn to write into it, and
 * reads nothing else — so a concurrent run cannot place a file where this
 * one will find it. That is a property of the layout rather than a prediction
 * about names, and it closes the exposure instead of narrowing it.
 *
 * The `--public` flag in `lib/screenshot-upload.ts` is deliberately NOT
 * touched here. Whether evidence is world-readable is a disclosure decision
 * for the repository owner, and changing it inside a scoping fix would make
 * that decision look like a cleanup.
 */

import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * The directory a prove run writes and reads its screenshots in.
 *
 * Derived from `WORK_DIR`, which `prove.js` already scopes per issue, so two
 * issues cannot share one. A plain subdirectory rather than `mkdtemp`: the
 * name has to be computable twice — once to tell Quinn, once to read it back
 * — and a random suffix would have to be threaded through an agent prompt and
 * returned intact, which is a second decider about the same path.
 */
export function screenshotDirFor(workDir: string): string {
  return join(workDir, "screenshots");
}

/**
 * What a scan of that directory found.
 *
 * Three cases, not two, because the old code had one. `missing` and `none`
 * both produced an empty array, `markdownLinks.length > 0` was false for
 * both, and the phase reported success either way — so a feature that had
 * never worked was indistinguishable from a run with nothing to show. The
 * distinction is the fix for that, and it only means anything because
 * `prove.js` creates the directory BEFORE Quinn runs: after that, empty is a
 * statement about Quinn and absent is a statement about us.
 */
export type ScreenshotScan =
  | { kind: "found"; dir: string; files: string[] }
  | { kind: "none"; dir: string }
  | { kind: "missing"; dir: string };

/** PNG only. The tool drops `.yml` snapshots and `.log` console dumps beside its images. */
function isScreenshot(name: string): boolean {
  return name.toLowerCase().endsWith(".png");
}

/**
 * Lists the names in a directory. A seam, for one reason: the sort below.
 *
 * `readdirSync` returns sorted order on the filesystem this was written on,
 * so a battery row that deleted the `.sort()` measured **0 red** — the
 * mechanism was present and unprovable, and a sort nothing can witness is a
 * sort somebody later deletes as dead code. Handing the lister in lets a case
 * return names in the wrong order on purpose. Same shape as `GistCreator` in
 * `lib/screenshot-upload.ts`.
 */
export type DirLister = (dir: string) => string[];

const realLister: DirLister = dir => readdirSync(dir);

/**
 * Reads exactly one directory, non-recursively, and reports what is in it.
 *
 * Returns absolute paths because the only consumer hands them to
 * `uploadScreenshotsToIssue`, which calls `existsSync` on each — a relative
 * path there resolves against whatever the process cwd happens to be and
 * lands in `failed` with no explanation.
 *
 * Sorted, so the order evidence appears in a PR comment is the order the
 * filenames imply rather than the order the filesystem offers.
 */
export function discoverScreenshots(dir: string, list: DirLister = realLister): ScreenshotScan {
  if (!existsSync(dir)) return { kind: "missing", dir };

  const files = list(dir)
    .filter(isScreenshot)
    .map(name => join(dir, name))
    .filter(path => statSync(path).isFile())
    .sort();

  return files.length === 0 ? { kind: "none", dir } : { kind: "found", dir, files };
}

/** One sentence for the run log, so each of the three readings is legible. */
export function describeScan(scan: ScreenshotScan): string {
  switch (scan.kind) {
    case "found":
      return `${scan.files.length} screenshot(s) from ${scan.dir}`;
    case "none":
      return `no screenshots: Quinn ran and wrote none into ${scan.dir}`;
    case "missing":
      return `UNMEASURED: ${scan.dir} does not exist, so no screenshot was ever looked for`;
  }
}
