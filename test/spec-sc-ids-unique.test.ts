/**
 * #246 — an SC id declared twice is a join key that points at two rows.
 *
 * SC ids are what bind a spec line to the test that proves it:
 * `test/harness-standard-security.test.ts` declares
 * `EXPECTED_REREVIEW_SCS = ["SC-621", ...]` and compares it against the ids it
 * extracts. If two lines claim SC-621, which one an extraction finds is an
 * ordering accident, and a test can bind to the wrong SC while going on
 * passing — a check that passed because of what it never looked at, arriving
 * through the id rather than through the assertion.
 *
 * This is not hypothetical. `work-171` and `work-239` were cut from the same
 * main, each read the highest SC in HARNESS-STANDARD.md, and each allocated
 * the next free block. Both were correct in isolation; they collided the
 * moment both existed, and SC-621, SC-622 and SC-623 were each declared twice.
 * Nothing in the suite noticed. The missing check is the defect — the
 * collision is only what it let through.
 *
 * Deliberately a property of the documents rather than a fixture: there is
 * nothing to plant, so there is nothing that can be planted wrongly.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { buildScRegistry, crossSpecCollisions, scDeclarationPattern } from "../lib/sc-ids";

const SPECS_DIR = join(import.meta.dir, "..", "specs");

/**
 * A declared SC: a checklist line opening with an id. Not a mention of one.
 *
 * Was `/^- \[.\] (SC-\d+)\b/gm` — the third of four copies of this pattern,
 * and the one that could not see an anti-criterion (#330). `SC-A1` was
 * declared by three specs and this guard, whose entire job is to catch that,
 * matched none of them.
 */
const DECLARATION = scDeclarationPattern();

export function duplicateScIds(source: string): string[] {
  const seen = new Map<string, number>();
  for (const m of source.matchAll(DECLARATION)) {
    seen.set(m[2], (seen.get(m[2]) ?? 0) + 1);
  }
  return [...seen.entries()]
    .filter(([, n]) => n > 1)
    .map(([id, n]) => `${id} (declared ${n} times)`)
    .sort();
}

const SPEC_FILES = readdirSync(SPECS_DIR).filter(f => f.endsWith(".md"));

describe("#246: every SC id is declared exactly once in the spec that owns it", () => {
  test("the corpus is non-empty, so the loop below is not vacuous", () => {
    // Without this, deleting specs/ or breaking the glob would leave every
    // case below passing over nothing at all.
    expect(SPEC_FILES.length, "no spec files were found to check").toBeGreaterThan(0);
    const declaring = SPEC_FILES.filter(
      f => [...readFileSync(join(SPECS_DIR, f), "utf-8").matchAll(DECLARATION)].length > 0,
    );
    expect(declaring.length, "no spec declares a single SC id").toBeGreaterThan(0);
  });

  for (const file of SPEC_FILES) {
    test(`${file} declares no id twice`, () => {
      const dupes = duplicateScIds(readFileSync(join(SPECS_DIR, file), "utf-8"));
      expect(
        dupes,
        `specs/${file} declares ${dupes.length} SC id(s) more than once: ${dupes.join(", ")}. ` +
          `Two branches most likely allocated the same block from the same base — renumber the ` +
          `later claimant to the next free id and update the tests that bind to it.`,
      ).toEqual([]);
    });
  }

  // The fixtures below use ids far above the allocated range, and build them
  // by concatenation rather than writing them out. #149: a spec-shaped id
  // sitting in a test file is read as that criterion being CLAIMED by this
  // test, and seven files once certified an unimplemented behavioural
  // criterion done that way. A fixture id that cannot collide with a real one
  // is the cheap half of not repeating it; not spelling it is the other half.
  const A = ["SC", "9001"].join("-");
  const B = ["SC", "9002"].join("-");

  test("the detector reads a duplicate when there is one", () => {
    // The guard proven able to fail, without leaving the plant in the tree.
    expect(duplicateScIds(`- [x] ${A}: a\n- [ ] ${B}: b\n- [x] ${A}: c\n`)).toEqual([
      `${A} (declared 2 times)`,
    ]);
  });

  test("a mention of an id is not a declaration of it", () => {
    // Prose cites ids constantly ("see SC-621"). Counting citations would make
    // this red everywhere and it would be switched off within a week.
    expect(duplicateScIds(`- [x] ${A}: a\nAs ${A} says, and ${A} again.\n`)).toEqual([]);
  });

  test("an anti-criterion declared twice in one spec is a duplicate too", () => {
    // The pattern used to be SC-\d+, so this whole shape was invisible —
    // which is how three specs came to declare SC-A1 with nothing noticing.
    const antiA = ["SC", "A91"].join("-");
    expect(duplicateScIds(`- [ ] ${antiA}: x\n- [ ] ${antiA}: y\n`)).toEqual([
      `${antiA} (declared 2 times)`,
    ]);
  });
});

/**
 * #330 — the same id in two specs, which the per-file guard above cannot see.
 *
 * Two specs each declaring `SC-2` once are each internally consistent, so
 * every case above passes and the id still points at two rows. The flipper
 * ticked the checkbox in both, because its credit was a bare id.
 *
 * Anti-criteria are exempt and that is not a loophole: `specs/SPEC-TEMPLATE.md`
 * ships `- [ ] SC-A1: [anti-criterion — must NOT happen]`, so every spec
 * numbers its own from A1 and three specs declaring `SC-A1` is the notation
 * working. They are disambiguated by requiring the spec's name near a
 * mention, not by renumbering — see `findTestFilesForSCs`.
 */
describe("#330: a global SC id belongs to one spec", () => {
  const specsOnDisk = () =>
    readdirSync(SPECS_DIR, { recursive: true, encoding: "utf-8" })
      .filter(f => f.endsWith(".md"))
      .map(f => ({ file: f, content: readFileSync(join(SPECS_DIR, f), "utf-8") }));

  test("the registry is non-empty, so the case below is not vacuous", () => {
    const reg = buildScRegistry(specsOnDisk());
    expect(reg.byId.size, "no SC ids were found in specs/").toBeGreaterThan(100);
  });

  test("no numeric id is declared by two specs", () => {
    const collisions = crossSpecCollisions(buildScRegistry(specsOnDisk()));
    expect(
      collisions,
      `${collisions.length} SC id(s) are declared by more than one spec: ` +
        `${collisions.join("; ")}. A bare mention of one names two criteria, and the ` +
        `checkbox flipper ticks both. Renumber the later claimant.`,
    ).toEqual([]);
  });

  test("the detector reads a cross-spec collision when there is one", () => {
    // The guard proven able to fail, without planting anything in specs/.
    const id = ["SC", "9003"].join("-");
    const reg = buildScRegistry([
      { file: "ONE-SPEC.md", content: `- [x] ${id}: a\n` },
      { file: "TWO-SPEC.md", content: `- [ ] ${id}: b\n` },
    ]);
    expect(crossSpecCollisions(reg)).toEqual([`${id} declared by ONE-SPEC.md and TWO-SPEC.md`]);
  });

  test("the same anti-criterion in two specs is NOT a collision", () => {
    // The positive control. A rule that called every repeat a collision would
    // satisfy the case above and demand that three specs renumber a notation
    // the template tells them to use.
    const id = ["SC", "A93"].join("-");
    const reg = buildScRegistry([
      { file: "ONE-SPEC.md", content: `- [x] ${id}: a\n` },
      { file: "TWO-SPEC.md", content: `- [ ] ${id}: b\n` },
    ]);
    expect(crossSpecCollisions(reg)).toEqual([]);
  });

  test("the template's placeholder ids are not registry ids", () => {
    // SPEC-TEMPLATE.md ships SC-1, SC-2 and SC-A1 as examples. Counting them
    // makes SC-1 a two-spec collision that no renumbering can fix.
    const reg = buildScRegistry([
      { file: "SPEC-TEMPLATE.md", content: "- [ ] SC-1: [first criterion]\n" },
      { file: "REAL-SPEC.md", content: "- [ ] SC-1: a real one\n" },
    ]);
    expect(reg.byId.get("SC-1")).toEqual(["REAL-SPEC.md"]);
    expect(crossSpecCollisions(reg)).toEqual([]);
  });
});
