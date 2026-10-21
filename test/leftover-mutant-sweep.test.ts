import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

import { commitFixture, initFixtureRepo } from "./helpers/git-fixture";
import { pathsContaining, untrackedUnder } from "./helpers/planted-artefacts";

/**
 * #1025 — the leftover sweep matched FILENAMES.
 *
 * `test/suite-binding-mutation.test.ts` plants a mutated copy of the gate
 * suite, and a copy left inside the repository would be collected by a later
 * `bun test` run as if it were source. Real hazard, real check. The predicate
 * was not:
 *
 * ```ts
 * readdirSync(dir).filter(f => /mutant/i.test(f) && f !== "suite-binding-mutation.test.ts")
 * ```
 *
 * A filename is a proxy for "an artefact was planted", and
 * `.claude/rules/checks-must-be-able-to-fail.md` says what to do about a
 * refusal worded after the proxy instead of the property — the
 * `bytesScanned === 0` precedent: word it after the property you care about,
 * because a proxy is a thing people can satisfy directly.
 *
 * It failed in both directions at once:
 *
 * - **Satisfiable without fixing anything.** Rename the leftover. The planted
 *   file this harness writes is `workflow-mutant-<sha1>.ts`; one character
 *   out of that stem and the sweep walks past a mutated module sitting in
 *   `test/`.
 * - **Refusable by something that is not the problem.** #906 committed a
 *   mutation harness called `test/preserve-overlap-mutants.test.ts` and the
 *   sweep went red on CI with nothing planted and nothing left behind — and
 *   green for everyone who had not created the file yet, which is the worst
 *   shape for a failure to take. PR #1022 renamed its own file to get past
 *   it and left the trap for the next one.
 *
 * The exemption the predicate already carried is the tell: `/mutant/i` never
 * matched `suite-binding-mutation.test.ts` in the first place — *mutation*
 * does not contain *mutant* — so the one name the sweep spelled out was a
 * name it was never going to flag.
 *
 * This file measures the replacement from both sides, and measures the
 * cheapest wrong fix beside it. It is also, by its own NAME, the standing
 * negative control: a checked-in file matching `/mutant/i`, which the old
 * predicate would refuse on sight.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const SWEPT_DIRS = ["gates", "test"];

/**
 * A marker of this file's own, never the one `buildMutantSource` writes.
 * Importing the real constant would mean importing a `.test.ts` module and
 * re-running its suite here, and spelling the literal would make this very
 * file look planted to the sweep it is testing.
 */
const PROBE_MARKER = "PROBE: a planted artefact, written by test/leftover-mutant-sweep.test.ts";

/**
 * The predicate as it shipped, as a function, so the claims about it below
 * are measurements rather than assertions about remembered code.
 */
function oldSweep(names: string[], exemptions: string[]): string[] {
  return names.filter(f => /mutant/i.test(f) && !exemptions.includes(f));
}

let SCRATCH = "";
let REPO = "";

/**
 * A repository, not a directory. The distinction the fix rests on —
 * tracked versus untracked — does not exist outside one, so the fixture has
 * to be a real git repo with a real commit in it.
 */
beforeEach(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "leftover-sweep-"));
  REPO = join(SCRATCH, "repo");
  mkdirSync(join(REPO, "test"), { recursive: true });
  mkdirSync(join(REPO, "gates"), { recursive: true });
  initFixtureRepo(REPO);

  // The checked-in harness that turned the old sweep red on CI, by name.
  writeFileSync(
    join(REPO, "test", "preserve-overlap-mutants.test.ts"),
    "// a committed mutation harness, nothing planted\n",
  );
  writeFileSync(join(REPO, "gates", "workflow.test.ts"), "// the source a mutant is built from\n");
  commitFixture(REPO, "the harness, checked in");
});

afterEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

/** Plant an untracked file, the way a mutation harness mis-aimed at the repo would. */
function plant(rel: string): void {
  writeFileSync(join(REPO, rel), `${PROBE_MARKER}\nexport const planted = true;\n`);
}

describe("#1025: the sweep catches what was planted, not what was named", () => {
  test("a planted artefact is caught — and caught under a name the old predicate missed", () => {
    plant("test/workflow-mutant-deadbeef.ts");
    plant("test/quietly-renamed-leftover.ts");
    plant("gates/workflow-mutant-deadbeef.ts");

    const untracked = untrackedUnder(REPO, SWEPT_DIRS);
    expect(untracked, "a planted file is untracked by construction and all three must be listed").toEqual([
      "gates/workflow-mutant-deadbeef.ts",
      "test/quietly-renamed-leftover.ts",
      "test/workflow-mutant-deadbeef.ts",
    ]);

    // And by content, which is what makes a leftover from an earlier,
    // crashed run visible to a sweep that has no "before" to compare against.
    expect(pathsContaining(REPO, untracked, PROBE_MARKER).length).toBe(3);

    // The hole, measured rather than described: the old predicate saw two of
    // the three plants, and the one it missed is the one whose name was
    // changed — the thing a proxy can always be satisfied by.
    const names = untracked.map(p => p.split("/")[1]);
    expect(oldSweep(names, []).sort()).toEqual([
      "workflow-mutant-deadbeef.ts",
      "workflow-mutant-deadbeef.ts",
    ]);
    expect(
      oldSweep(names, []),
      "the renamed plant was invisible to the filename filter — this is the direction a proxy fails silently",
    ).not.toContain("quietly-renamed-leftover.ts");
  });

  test("a committed harness named `mutants` is not refused — #906's CI failure, reproduced", () => {
    const committed = "preserve-overlap-mutants.test.ts";
    expect(existsSync(join(REPO, "test", committed))).toBe(true);

    // The old predicate, against the directory listing it read: red, on a
    // tree where nothing was planted and nothing was left behind.
    expect(
      oldSweep([committed], ["suite-binding-mutation.test.ts"]),
      "the shipped predicate refused the committed harness — this is the bug #906 hit",
    ).toEqual([committed]);

    // The replacement, against the same tree: nothing. Not because the file
    // is exempted, but because git tracks it, and a planted file is untracked
    // by construction.
    expect(untrackedUnder(REPO, SWEPT_DIRS)).toEqual([]);
  });

  test("the cheapest wrong fix clears the instance and leaves the class", () => {
    // `&& f !== "preserve-overlap-mutants.test.ts"` — one term, no new
    // concept, CI green, reads as a fix. It is the repair the issue predicts
    // the next person reaches for.
    plant("test/quietly-renamed-leftover.ts");
    const names = ["preserve-overlap-mutants.test.ts", "quietly-renamed-leftover.ts"];
    const exemptions = ["suite-binding-mutation.test.ts", "preserve-overlap-mutants.test.ts"];

    expect(oldSweep(names, exemptions), "the exemption does clear the false refusal").toEqual([]);

    // And that is the whole of what it does. The plant is still invisible,
    // and the list has to grow again for the next committed harness — at
    // which point the list itself becomes the evidence those files are
    // accounted for, which is the pattern
    // `.claude/conformity-allowlists.json` fails the suite for growing.
    expect(
      untrackedUnder(REPO, SWEPT_DIRS),
      "the property-based sweep still sees the plant the exempted predicate cannot",
    ).toEqual(["test/quietly-renamed-leftover.ts"]);
  });

  test("an untracked file that is not a plant is not a finding — content decides", () => {
    writeFileSync(join(REPO, "test", "somebody-elses-scratch.ts"), "export const wip = 1;\n");
    const untracked = untrackedUnder(REPO, SWEPT_DIRS);
    expect(untracked).toEqual(["test/somebody-elses-scratch.ts"]);
    expect(
      pathsContaining(REPO, untracked, PROBE_MARKER),
      "an unrelated work-in-progress file carries no mutation and is not a leftover",
    ).toEqual([]);
  });

  test("a plant inside a NEW directory is listed, not hidden behind its parent", () => {
    // `--untracked-files=all`. The default collapses an untracked directory
    // to one entry ending in `/`, and a mutant one level down would be
    // reported as a folder nobody reads the contents of.
    mkdirSync(join(REPO, "test", "scratch"), { recursive: true });
    plant("test/scratch/workflow-mutant-deadbeef.ts");
    expect(untrackedUnder(REPO, SWEPT_DIRS)).toEqual(["test/scratch/workflow-mutant-deadbeef.ts"]);
  });

  test("git refusing to answer is an error, not an empty sweep", () => {
    // The `bytesScanned === 0` shape: a reading that cannot be taken must not
    // come back as "nothing found". `SCRATCH` itself is not a repository.
    expect(() => untrackedUnder(SCRATCH, SWEPT_DIRS)).toThrow(/cannot read the untracked files/);
  });
});

describe("#1025: this file is the standing negative control", () => {
  test("its own name matches the old predicate, and git does not call it a plant", () => {
    expect(
      /mutant/i.test(import.meta.file),
      "rename this file and the control it provides is gone — the name is the point",
    ).toBe(true);

    const self = relative(REPO_ROOT, import.meta.path);
    expect(existsSync(import.meta.path)).toBe(true);
    expect(
      untrackedUnder(REPO_ROOT, [self]),
      `${self} is checked in; a sweep that refuses it is refusing something that is not the problem`,
    ).toEqual([]);
  });
});
