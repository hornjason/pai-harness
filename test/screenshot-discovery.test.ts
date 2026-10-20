/**
 * Covers #809: UI evidence is discovered from a directory this run owns, and a
 * zero is a reading rather than a silence.
 *
 * ## The defect this replaces
 *
 * `workflows/prove.js` globbed all of `/tmp` for
 * `playwright-screenshot.*\.png$|browser-screenshot.*\.png$` and handed every
 * match to `uploadScreenshotsToIssue`, which publishes each one as a PUBLIC
 * gist and embeds the links in a PR comment. Unscoped by run, by issue and by
 * project, on a machine that routinely has a dozen concurrent worktrees.
 *
 * It had never fired, and the reason is not restraint. Playwright's
 * `browser_take_screenshot` writes `.playwright-mcp/page-{timestamp}.png`
 * under the workspace root when given no `filename` — not `/tmp`, and matching
 * neither pattern. Measured across this machine: 96 files produced by the tool
 * between 2026-09-28 and 2026-10-19, and zero ever named for either pattern.
 * So the live defect was the other half — UI evidence was never attached to
 * anything, and the phase reported success while doing nothing.
 *
 * ## Why a directory and not a better pattern
 *
 * A narrower glob is still a guess about a filename somebody else chooses.
 * Scoping to a directory this run creates and names is a property rather than
 * a prediction: a concurrent run cannot land a file there, so the exposure
 * closes instead of narrowing. The cheapest wrong fix — tightening the regex
 * to match `page-*.png` — is the one these cases are built to refuse, and
 * `a sibling directory is not read` is the row that refuses it.
 *
 * ## What was broken to prove these can fail
 *
 * Baseline 14 pass / 0 fail; restored and re-verified at 14 pass / 0 fail.
 *
 * | # | Mutation | Result |
 * |---|---|---|
 * | M1 | the listing widened to the parent directory | **3 fail** |
 * | M2 | the `.png` filter dropped | **1 fail** |
 * | M3 | `missing` folded into `none` | **2 fail** |
 * | M4 | `none` returned before the exists check | **3 fail** |
 * | M5 | paths returned relative instead of absolute | **4 fail** |
 * | M6 | `.sort()` deleted | **1 fail** |
 * | M7 | the `isFile` filter dropped | **1 fail** |
 * | M8 | the injected lister ignored, `readdirSync` used anyway | **1 fail** |
 *
 * M1 is the row that refuses the cheapest wrong fix — tightening the filename
 * pattern instead of scoping the directory. M3 and M4 are the pair that
 * matters most: they are the two ways to collapse "Quinn took no screenshots"
 * into "we never looked", which is the silence that hid this for as long as
 * it hid.
 *
 * **M6 and M7 measured 0 red in the first battery.** `readdirSync` returns
 * sorted names on this filesystem, so deleting the sort changed no result,
 * and nothing in the suite created a directory named `*.png`. Both mechanisms
 * were present and unprovable. The `DirLister` seam and the `decoy.png`
 * fixture exist for those two rows alone; the mechanisms did not change, only
 * whether they can be shown to work. M8 is the control on the seam, because
 * a lister that is accepted and then ignored would leave M6 passing.
 *
 * Twice now a battery here has been run against a tree that was not what it
 * looked like — the first time because `git checkout --` aborts on an
 * unmatched pathspec, the second because the restore reverted uncommitted
 * work from the same session. Commit before the battery, and read the
 * baseline row before trusting any other.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join } from "path";

import { discoverScreenshots, screenshotDirFor } from "../lib/screenshot-discovery";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "rg-809-"));
}

describe("#809: the directory is derived from the run's own work dir", () => {
  test("it sits under the work dir, so two issues cannot share one", () => {
    const a = screenshotDirFor("/home/u/.rungate/ddb-101");
    const b = screenshotDirFor("/home/u/.rungate/ddb-102");
    expect(a).toContain("/home/u/.rungate/ddb-101");
    expect(a).not.toBe(b);
  });

  test("it is absolute, because the consumer is a prompt and a cwd is not promised", () => {
    expect(isAbsolute(screenshotDirFor("/home/u/.rungate/ddb-101"))).toBe(true);
  });
});

describe("#809: discovery reads one directory and reports what it saw", () => {
  test("a directory with screenshots yields them, absolute and sorted", () => {
    const root = scratch();
    try {
      const dir = join(root, "shots");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "page-2.png"), "x");
      writeFileSync(join(dir, "page-1.png"), "x");
      const scan = discoverScreenshots(dir);
      expect(scan.kind).toBe("found");
      if (scan.kind !== "found") throw new Error("unreachable");
      expect(scan.files.every(isAbsolute), "a relative path reaches the uploader as a miss").toBe(
        true,
      );
      expect(scan.files.map(f => f.split("/").pop())).toEqual(["page-1.png", "page-2.png"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a sibling directory is NOT read, which is the whole point", () => {
    // The row that refuses the cheapest wrong fix. A tightened filename
    // pattern would pass every other case here and still pick this file up.
    const root = scratch();
    try {
      const mine = join(root, "shots");
      const theirs = join(root, "someone-elses-run");
      mkdirSync(mine, { recursive: true });
      mkdirSync(theirs, { recursive: true });
      writeFileSync(join(theirs, "page-1.png"), "not mine");
      writeFileSync(join(theirs, "playwright-screenshot-9.png"), "also not mine");

      const scan = discoverScreenshots(mine);
      expect(scan.kind, "another run's screenshots were collected for this PR").toBe("none");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a lister returning reverse order still yields sorted paths", () => {
    // The sort measured 0 red without this: readdirSync happens to return
    // sorted names here, so deleting `.sort()` changed nothing and the
    // mechanism was unprovable. The seam exists for exactly this row.
    const root = scratch();
    try {
      const dir = join(root, "shots");
      mkdirSync(dir, { recursive: true });
      for (const n of ["a.png", "b.png", "c.png"]) writeFileSync(join(dir, n), "x");
      const scan = discoverScreenshots(dir, () => ["c.png", "b.png", "a.png"]);
      if (scan.kind !== "found") throw new Error(`expected found, got ${scan.kind}`);
      expect(scan.files.map(f => f.split("/").pop())).toEqual(["a.png", "b.png", "c.png"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the lister is really what gets read, or the row above proves nothing", () => {
    // The control. If the injected lister were ignored and readdirSync used
    // anyway, the sorted assertion above would still pass.
    const root = scratch();
    try {
      const dir = join(root, "shots");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "real.png"), "x");
      expect(discoverScreenshots(dir, () => []).kind, "the injected lister was ignored").toBe(
        "none",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a directory named like a screenshot is not a screenshot", () => {
    // Witnesses the isFile filter, which also measured 0 red. Playwright
    // will not create one, but `scan.files` is handed straight to an
    // uploader that calls existsSync — which a directory satisfies.
    const root = scratch();
    try {
      const dir = join(root, "shots");
      mkdirSync(join(dir, "decoy.png"), { recursive: true });
      writeFileSync(join(dir, "real.png"), "x");
      const scan = discoverScreenshots(dir);
      if (scan.kind !== "found") throw new Error(`expected found, got ${scan.kind}`);
      expect(scan.files.map(f => f.split("/").pop())).toEqual(["real.png"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-png files in my own directory are ignored", () => {
    const root = scratch();
    try {
      const dir = join(root, "shots");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "page-1.png"), "x");
      writeFileSync(join(dir, "page-1.yml"), "snapshot, not evidence");
      writeFileSync(join(dir, "console-1.log"), "log, not evidence");
      const scan = discoverScreenshots(dir);
      if (scan.kind !== "found") throw new Error(`expected found, got ${scan.kind}`);
      expect(scan.files).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#809: an empty result says WHICH kind of empty it is", () => {
  test("a directory that exists and is empty is `none` — Quinn looked and took none", () => {
    const root = scratch();
    try {
      const dir = join(root, "shots");
      mkdirSync(dir, { recursive: true });
      const scan = discoverScreenshots(dir);
      expect(scan.kind).toBe("none");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a directory that does not exist is `missing` — nobody ever looked", () => {
    // The distinction the old code could not express. Both of these produced
    // an empty array, `markdownLinks.length > 0` was false, and the phase
    // reported success either way. A step that cannot tell "nothing happened"
    // from "nothing was attempted" reports the same thing for a working
    // feature and a broken one, which is how this survived.
    const root = scratch();
    try {
      const scan = discoverScreenshots(join(root, "never-created"));
      expect(scan.kind).toBe("missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("`none` and `missing` are different values, or the case above is decoration", () => {
    const root = scratch();
    try {
      const present = join(root, "shots");
      mkdirSync(present, { recursive: true });
      expect(
        discoverScreenshots(present).kind,
        "the two empties collapsed, so the silence is back",
      ).not.toBe(discoverScreenshots(join(root, "absent")).kind);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("every reading carries the directory it read, so a wrong path is visible", () => {
    const root = scratch();
    try {
      const dir = join(root, "shots");
      mkdirSync(dir, { recursive: true });
      expect(discoverScreenshots(dir).dir).toBe(dir);
      expect(discoverScreenshots(join(root, "absent")).dir).toBe(join(root, "absent"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#809: the production glob is gone from prove.js", () => {
  test("no /tmp screenshot glob survives in the workflow", async () => {
    // The defect was a string inside an `agent()` prompt, which is why no
    // test could reach it. Asserting its absence is the only guard available
    // until that whole block is code; it is a source scan and it says so.
    const src = await Bun.file(join(import.meta.dir, "..", "workflows", "prove.js")).text();
    const needle = "playwright-screenshot" + ".*";
    expect(src.includes(needle), "the unscoped /tmp glob is still in prove.js").toBe(false);
  });

  test("the workflow names the scoped directory helper", async () => {
    // The control. Asserting only the absence above would pass if the whole
    // upload block were deleted, which is not the fix.
    const src = await Bun.file(join(import.meta.dir, "..", "workflows", "prove.js")).text();
    expect(src).toContain("screenshotDirFor");
  });
});
