/**
 * Covers SC-1955..SC-1959 (CONFIG-DRIVEN-TESTING-SPEC.md), #574.
 *
 * `scripts/sync-sc-status.ts` credits a criterion when a test file names it
 * in a declaring position, and a `test()` title is one — correctly, it is
 * this project's oldest coverage convention. `test.todo("SC-N: …")` is also
 * a title, and a todo is the one test guaranteed never to fail.
 *
 * Measured when this was found, on main at `469ef084`: 64 ids named inside
 * a `.todo`, 53 of them with no other declaring mention anywhere, 37 of
 * those ticked `[x]` in a spec — and 19 MORE flipping on the next run of
 * the sync, from a file whose own comment says four lines from the top that
 * none of its criteria are covered there.
 *
 * The fixtures are source strings run through the real scanner rather than
 * a parser test, because the defect is which call shapes count and that is
 * a fact about the scanner's regex, not about anybody's model of it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { globSync } from "fs";
import { join } from "path";

import { commentClaimForm, titleCall } from "../lib/sc-claim-forms";
import {
  checkConformitySCs,
  coverageClaimSites,
  findTestFilesForSCs,
  intendedOnly,
  readScRegistry,
  type UncheckedSC,
} from "../scripts/sync-sc-status";

const REPO_ROOT = join(import.meta.dir, "..");

/** The ids the scanner would credit in `source`, by kind. */
function kinds(source: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of coverageClaimSites(source)) (out[s.kind] ??= []).push(s.id);
  return out;
}

describe("#574: a criterion whose only test is a todo is not a covered criterion", () => {
  test("SC-1955: a todo title declares intent, a test title declares coverage", () => {
    // The same id, the same file, the same words — one character of
    // difference. Nothing but the modifier can account for the two answers.
    const todo = `test.todo("SC-8001: the rate is a rate");\n`;
    const real = `test("SC-8001: the rate is a rate", () => {});\n`;

    expect(kinds(todo).title ?? [], "a todo was credited as coverage").toEqual([]);
    expect(kinds(todo)["unrun-title"], "the todo was dropped instead of recorded").toEqual(["SC-8001"]);
    // The positive control, without which every assertion here is satisfied
    // by a scanner that credits no title at all.
    expect(kinds(real).title).toEqual(["SC-8001"]);
    expect(kinds(real)["unrun-title"] ?? []).toEqual([]);
  });

  test("SC-1956: the modifiers that never run are refused and the ones that run are not", () => {
    // `.skip` is the same fact in a different word and there were five.
    // `.skipIf`/`.todoIf` take a condition, so whether they ran is not
    // answerable from the source; there are none today and they are named
    // anyway, because a detector narrower than what it detects is this
    // repo's third defect shape.
    for (const mod of [".todo", ".skip", ".skipIf(isCI)", ".todoIf(slow)"]) {
      expect(titleCall(`test${mod}(`), `test${mod} was treated as coverage`).toBe("never-runs");
    }
    // `.failing` runs: a test expected to fail still goes red when the
    // expectation stops holding, which is the property being credited.
    for (const mod of ["", ".only", ".each(CASES)", ".failing", ".concurrent"]) {
      expect(titleCall(`test${mod}(`), `test${mod} stopped being coverage`).toBe("runs");
    }
    for (const fn of ["describe", "it"]) {
      expect(titleCall(`${fn}.todo(`)).toBe("never-runs");
      expect(titleCall(`${fn}(`)).toBe("runs");
    }
    // Not a title call at all is a third answer, and it has to stay
    // distinct: folding it into "never-runs" would report every bare string
    // in the tree as an unwritten test.
    expect(titleCall("const label = (")).toBeNull();
    expect(titleCall("somethingElse.todo(")).toBeNull();
  });

  test("SC-1957: a todo is credited to nothing and reported by name", () => {
    // Silence is the failure mode this replaces: `0`, `{}`, `null` and "not
    // in the list" are all indistinguishable from success, so an id nothing
    // can measure has to be said out loud.
    const reported = intendedOnly(join(REPO_ROOT, "test"));
    expect(reported.size, "the report went empty, so it is not reporting").toBeGreaterThan(10);
    expect(reported.get("SC-1931"), "a criterion whose only test is a todo is not reported").toEqual([
      "rule-lifecycle-spec.test.ts",
    ]);

    // And an id that ALSO has a real test is NOT in the list. Without this
    // the report names every criterion with a todo beside a passing test,
    // and a list that cries wolf is ignored within a week.
    //
    // One scan for all of them, not one per id: the first version asked the
    // whole test tree 59 times and took 18s against a 5s default timeout,
    // which is #508's defect arriving in the test written to fix #574.
    const credited = findTestFilesForSCs(
      [...reported.keys()].map(id => ({ id, specFile: "x.md" })),
      readScRegistry(),
      join(REPO_ROOT, "test"),
    );
    const creditedIds = new Set([...credited.values()].flat().map(c => c.id));
    expect(
      [...reported.keys()].filter(id => creditedIds.has(id)),
      "an id is reported unmeasured AND credited by a test claim",
    ).toEqual([]);
  });

  test("SC-1958: a range in a parenthetical is prose about a group, not an attribution", () => {
    // The sentence from the tree, verbatim. It credited its two endpoints
    // and ticked both boxes — a comment saying the criteria are NOT covered
    // was the evidence that they were.
    const line = " * The spec's 19 behavioural criteria (SC-1930..SC-1948) are NOT covered here.";
    expect(commentClaimForm(line, line.indexOf("SC-1930"), "SC-1930")).toBeNull();
    expect(commentClaimForm(line, line.indexOf("SC-1948"), "SC-1948")).toBeNull();

    // An attribution names THE criterion a statement is about, and that
    // form is unchanged — measured at 30 of 32 attribution credits in the
    // tree before the range was excluded.
    const one = " * …which turns it red (SC-4).";
    expect(commentClaimForm(one, one.indexOf("SC-4"), "SC-4")).toBe("attribution");
    const two = " * …both of them (SC-358, SC-359).";
    expect(commentClaimForm(two, two.indexOf("SC-358"), "SC-358")).toBe("attribution");

    // A range at the START of a line is still a claim, by the `line` form.
    // Narrowing a detector is the change most likely to buy green with
    // blindness, so the half that must NOT move is asserted too.
    const heading = " *     SC-561..SC-564 (SPEC.md)";
    expect(commentClaimForm(heading, heading.indexOf("SC-561"), "SC-561")).toBe("line");
  });

  test("SC-1959: no ticked criterion in this repo rests on a test that never runs", () => {
    // The ratchet, and the only case here that keeps the fix. Everything
    // above is about one source string; this is the live tree, which is
    // where the 40 false ticks were.
    const unmeasured = new Set(intendedOnly(join(REPO_ROOT, "test")).keys());
    expect(unmeasured.size, "nothing is unmeasured, so this asserts nothing").toBeGreaterThan(10);

    const ticked: UncheckedSC[] = [];
    const specs = globSync("specs/**/*.md", { cwd: REPO_ROOT });
    expect(specs.length, "no specs were read, so the walk found nothing to check").toBeGreaterThan(20);
    for (const rel of specs) {
      for (const raw of readFileSync(join(REPO_ROOT, rel), "utf-8").split("\n")) {
        const m = raw.trim().match(/^- \[x\] (SC-[0-9A-Z]+): (.*)$/);
        if (m && unmeasured.has(m[1])) {
          ticked.push({ id: m[1], specFile: rel.replace(/^specs\//, ""), statement: m[2] });
        }
      }
    }

    // A test claim is not the only way to earn a tick: the conformity
    // engine matches an SC statement mechanically, and two of the forty
    // unticked here came back on the next run through that path. So the
    // property is "every tick is backed by SOME measurement", not "every
    // tick is backed by a test file" — asserting the narrower one would
    // have made the honest answer look like a regression.
    const conformity = checkConformitySCs(ticked, REPO_ROOT);
    const backed = new Set([...conformity.passing]);
    const unbacked = ticked
      .map(sc => `${sc.specFile} ${sc.id}`)
      .filter((_, i) => !backed.has(`${ticked[i]!.specFile}::${ticked[i]!.id}`));
    expect(unbacked, "a criterion is ticked whose only test is a todo or a skip").toEqual([]);
  });
});
