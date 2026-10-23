/**
 * A second criterion prefix, tracked by the same machinery as the first.
 *
 * `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` (#1298) declares 56 criteria as
 * `CRC-A1`..`CRC-N5`. They are spelled `CRC-` rather than `SC-` deliberately:
 * in the `SC-` namespace a class letter means ANTI-criterion — `isAntiCriterion`
 * is `/^SC-[A-Z]\d+$/`, and `specs/SPEC-TEMPLATE.md` ships
 * `- [ ] SC-A1: [anti-criterion — must NOT happen]` — so all 56 would have read
 * as things that must not happen. In the `CRC-` namespace the letter is a
 * SECTION, which is a different fact about the same character.
 *
 * The rename was right and is not reverted here. What it also did was make the
 * criteria invisible: `SC_ID_SOURCE` was `SC-[A-Z]?\d+`, every declaration,
 * mention and heading pattern is built from it, and `git grep CRC-` over
 * `lib/ scripts/ test/` returned nothing. MEASURED on `origin/main` against the
 * spec's content: **56 lines matching `^- \[ \] CRC-…:` and 0 parsed
 * declarations.** Nothing could tick one, no test could claim one, and —
 * the sharp end — `detectDrift` is the gate `scripts/sync-sc-status.ts` runs
 * before flipping a box, so an unparsed criterion is also an unguarded one.
 *
 * ## What this file holds, and what it must NOT let through
 *
 * Widening the id pattern is the whole fix and it is also the whole hazard.
 * The cheapest version — widen `SC_ID_SOURCE` and build `isAntiCriterion` from
 * it, which is what "one owner for the id pattern" reads like at a glance —
 * parses all 56 and re-creates the exact bug the rename fixed. Measured:
 * `isAntiCriterion("CRC-A1")` true, `ambiguityOf` `"per-spec"`, and
 * `crossSpecCollisions`/`crossFormCollisions` both filter anti-criteria OUT, so
 * two specs declaring the same `CRC-` id collide silently.
 *
 * So a parse assertion alone is green on the wrong fix. The three guards below
 * — anti-criterion, cross-spec collision, cross-form collision — are what
 * separate them, and each is paired with the `SC-` reading it must not change.
 *
 * Fixture ids are spelled in the 9000 range (`CRC-9301`…) per the convention
 * `lib/sc-ids.ts`'s `FIXTURE_SC_FLOOR` records. No spec declares them, so a
 * claiming mention in this file credits nothing — the self-reference trap
 * `test/sc-id-namespace.test.ts` documents.
 *
 * Covers SC-787 of CONFIG-DRIVEN-TESTING-SPEC.md.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  ambiguityOf,
  buildScRegistry,
  crossFormCollisions,
  crossSpecCollisions,
  isAntiCriterion,
  parseScDeclarations,
  parseScHeadingDeclarations,
  oneScMentionPattern,
  SC_ID_SOURCE,
  scDeclarationPattern,
  scHeadingDeclarationPattern,
  scMentionPattern,
  TRACKED_ID_PREFIXES,
} from "../lib/sc-ids";
import { coverageClaimSites } from "../scripts/sync-sc-status";
import { findUncheckedSCs } from "../scripts/sync-sc-status";
import { detectDrift } from "../scripts/detect-sc-drift";
import { detectNewSCs } from "../lib/sc-guard";

const REPO = join(import.meta.dir, "..");
const SPEC = "specs/A-FIXTURE-SPEC.md";

/** A tracked id in each namespace, same shape, so every row has its control. */
const CRC = "CRC-9301";
const CRC_LETTERED = "CRC-B9301";
const SC_LETTERED = "SC-B9301";

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "crc-tracked-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the tracked prefixes are one list, read from one binding", () => {
  test("every declaring and mentioning pattern is built from SC_ID_SOURCE", () => {
    // #330's property, restated for two prefixes: the root cause was four
    // regexes, so the thing to assert is that there is one. A reader that
    // rebuilt its own would not contain the shared source verbatim.
    expect(scDeclarationPattern().source).toContain(SC_ID_SOURCE);
    expect(scHeadingDeclarationPattern().source).toContain(SC_ID_SOURCE);
    expect(scMentionPattern().source).toContain(SC_ID_SOURCE);
  });

  test("SC_ID_SOURCE names every tracked prefix and nothing else does", () => {
    // The list is the single decider. A prefix present in the list but absent
    // from the pattern is a prefix nothing parses; a prefix in the pattern but
    // not the list is a second place that decides what a criterion is.
    expect(TRACKED_ID_PREFIXES.length).toBeGreaterThan(1);
    for (const p of TRACKED_ID_PREFIXES) expect(SC_ID_SOURCE).toContain(p);
    const inPattern = SC_ID_SOURCE.match(/[A-Z]{2,}/g) ?? [];
    expect([...inPattern].sort()).toEqual([...TRACKED_ID_PREFIXES].sort());
  });

  test("a longer prefix is not eaten by a shorter one that prefixes it", () => {
    // Regex alternation is first-match, not longest-match, so `(?:S|SC)-1`
    // never reaches the second branch. Nothing in the list triggers this
    // today; the assertion is what keeps the next entry from doing so.
    for (const p of TRACKED_ID_PREFIXES) {
      const id = `${p}-9301`;
      const m = id.match(new RegExp(`^${SC_ID_SOURCE}$`));
      expect(m?.[0], `${id} did not match the pattern whole`).toBe(id);
    }
  });
});

describe("a CRC criterion is parsed, ticked and claimed like an SC one", () => {
  test("the declaration reader sees a CRC checkbox", () => {
    // MEASURED on origin/main: 0 of the spec's 56 lines parsed.
    const parsed = parseScDeclarations(`- [ ] ${CRC}: a fixture criterion\n`, SPEC);
    expect(parsed.map(p => p.id)).toEqual([CRC]);
    expect(parsed[0].form).toBe("checkbox");
    expect(parsed[0].checked).toBe(false);
  });

  test("a ticked CRC checkbox reads as ticked, not as a second unticked one", () => {
    const parsed = parseScDeclarations(`- [x] ${CRC}: a fixture criterion\n`, SPEC);
    expect(parsed.map(p => [p.id, p.checked])).toEqual([[CRC, true]]);
  });

  test("the heading reader sees a CRC subsection, which owns the number", () => {
    const parsed = parseScHeadingDeclarations(`### ${CRC}: a fixture section\n`, SPEC);
    expect(parsed.map(p => p.id)).toEqual([CRC]);
    expect(parsed[0].form).toBe("heading");
  });

  test("the flipper's spec scan finds an unchecked CRC criterion", () => {
    withTmpDir(dir => {
      writeFileSync(join(dir, "A-FIXTURE-SPEC.md"), `- [ ] ${CRC}: a fixture criterion\n`);
      expect(findUncheckedSCs(dir).map(u => u.id)).toEqual([CRC]);
    });
  });

  test("a test file can claim a CRC criterion in every declaring form", () => {
    // All five forms, because three of them — label, line, attribution — were
    // built on a regex spelling `(?:SC|AC)-[A-Z]?\d+` by hand, and a widened
    // `SC_ID_SOURCE` alone leaves those three refusing the credit while the
    // other two grant it. A prefix that is claimable in two forms of five is
    // a prefix whose coverage depends on how the author happened to type.
    const sources: Array<[string, string]> = [
      ["covers", `// covers ${CRC}\ntest("x", () => {});\n`],
      ["label", `// #1298 / ${CRC}: the thing\ntest("x", () => {});\n`],
      ["line", `// ${CRC}\ntest("x", () => {});\n`],
      ["spec-ref", `// SPEC-REF: ${CRC}\ntest("x", () => {});\n`],
      ["attribution", `// the reviewer blocks it (${CRC}).\ntest("x", () => {});\n`],
      ["title", `test("${CRC}: the thing", () => {});\n`],
    ];
    for (const [form, src] of sources) {
      const sites = coverageClaimSites(src).filter(s => s.id === CRC);
      expect(sites.length, `${form}: the id was not even seen`).toBe(1);
      expect(
        sites[0].kind === "title" ? "title" : sites[0].form,
        `${form}: seen but not credited as a declaring position`,
      ).toBe(form);
    }
  });

  test("the drift gate reads a CRC criterion, so a tick cannot bypass it", () => {
    // `scripts/sync-sc-status.ts` calls `detectDrift` before flipping. A
    // criterion the gate cannot see is auto-flipped with no gate at all —
    // the failure `detect-sc-drift.ts`'s own docblock records for
    // subdirectory specs, arriving a second time by prefix.
    withTmpDir(dir => {
      writeFileSync(
        join(dir, "A-FIXTURE-SPEC.md"),
        `- [ ] ${CRC}: lib/this-file-does-not-exist.ts contains [nothing]\n`,
      );
      const result = detectDrift(dir, REPO);
      expect(result.checked).toBe(1);
      expect(result.drifted.get("A-FIXTURE-SPEC.md")?.map(d => d.scId)).toEqual([CRC]);
    });
  });

  test("the new-criterion guard sees a CRC line arrive", () => {
    expect(detectNewSCs("", `- [ ] ${CRC}: a fixture criterion\n`).map(s => s.id)).toEqual([CRC]);
  });
});

describe("CRC is NOT an anti-criterion, and is NOT exempt from collisions", () => {
  test("a lettered CRC id is a section, a lettered SC id is an anti-criterion", () => {
    // The control is the SC row. A change that makes CRC-B9301 anti also has
    // to keep SC-B9301 anti, so asserting only the CRC row would be green on
    // a fix that broke the SC namespace instead.
    expect(isAntiCriterion(SC_LETTERED)).toBe(true);
    expect(isAntiCriterion(CRC_LETTERED)).toBe(false);
    expect(isAntiCriterion(CRC)).toBe(false);
  });

  test("a lettered CRC id declared once is unambiguous, not per-spec", () => {
    const reg = buildScRegistry([
      { file: SPEC, content: `- [ ] ${CRC_LETTERED}: a\n- [ ] ${SC_LETTERED}: b\n` },
    ]);
    expect(ambiguityOf(CRC_LETTERED, reg)).toBe("none");
    expect(ambiguityOf(SC_LETTERED, reg)).toBe("per-spec");
  });

  test("two specs declaring the same CRC id collide", () => {
    // `crossSpecCollisions` filters anti-criteria out, because being per-spec
    // is their definition. A CRC id is global, so the filter must not reach
    // it — and if it does, this is the only reading that says so.
    const reg = buildScRegistry([
      { file: "specs/ONE-FIXTURE-SPEC.md", content: `- [ ] ${CRC_LETTERED}: a\n` },
      { file: "specs/TWO-FIXTURE-SPEC.md", content: `- [ ] ${CRC_LETTERED}: b\n` },
    ]);
    expect(crossSpecCollisions(reg)).toEqual([
      `${CRC_LETTERED} declared by specs/ONE-FIXTURE-SPEC.md and specs/TWO-FIXTURE-SPEC.md`,
    ]);
  });

  test("the same CRC number as a heading in one spec and a checkbox in another collides", () => {
    const reg = buildScRegistry([
      { file: "specs/ONE-FIXTURE-SPEC.md", content: `### ${CRC_LETTERED}: a section\n` },
      { file: "specs/TWO-FIXTURE-SPEC.md", content: `- [ ] ${CRC_LETTERED}: b\n` },
    ]);
    expect(crossFormCollisions(reg)).toEqual([
      `${CRC_LETTERED} declared by specs/ONE-FIXTURE-SPEC.md and specs/TWO-FIXTURE-SPEC.md`,
    ]);
    // And the checkbox-only view still sees one declarer, so widening the
    // prefix did not quietly make a heading tickable.
    expect(reg.byId.get(CRC_LETTERED)).toEqual(["specs/TWO-FIXTURE-SPEC.md"]);
  });

  test("two specs declaring the same SC anti-criterion still do not collide", () => {
    // The negative control for the row above: the exemption that had to
    // survive. Removing `!isAntiCriterion` passes every CRC assertion here
    // and turns this one red.
    const reg = buildScRegistry([
      { file: "specs/ONE-FIXTURE-SPEC.md", content: `- [ ] ${SC_LETTERED}: a\n` },
      { file: "specs/TWO-FIXTURE-SPEC.md", content: `- [ ] ${SC_LETTERED}: b\n` },
    ]);
    expect(crossSpecCollisions(reg)).toEqual([]);
  });
});

describe("widening the prefix did not widen what counts as an id", () => {
  test("a word ending in the prefix is not an id", () => {
    // `\b` is what keeps `MISC-1` out of the SC namespace. The same leading
    // boundary has to hold for a prefix that is itself a common letter run.
    for (const s of ["MISC-9301", "ABCRC-9301", "xSC-9301"]) {
      expect([...s.matchAll(scMentionPattern())].map(m => m[0])).toEqual([]);
    }
  });

  test("a shorter CRC id does not match inside a longer one", () => {
    // #148 in the second namespace: `content.includes("SC-1")` was true of
    // every file naming `SC-144`, and eighteen files were credited with a
    // criterion none of them mentioned. The trailing boundary is what stops
    // it, and `CRC-93014` is a different criterion, not a mention of this one.
    expect(oneScMentionPattern(CRC).test(`${CRC}4`)).toBe(false);
    expect(oneScMentionPattern(CRC).test(`${CRC}-draft`)).toBe(false);
    expect(oneScMentionPattern(CRC).test(`see ${CRC}.`)).toBe(true);
    // Both whole ids are still read as ids — the boundary narrows credit,
    // not the namespace.
    expect([...`${CRC} and ${CRC}4`.matchAll(scMentionPattern())].map(m => m[0])).toEqual([
      CRC,
      `${CRC}4`,
    ]);
  });

  test("the real spec tree gains no cross-spec collision from the widening", () => {
    // The tree is the population this change is actually applied to, and the
    // bank it has to leave at zero. A fixture cannot show this.
    const specsDir = join(REPO, "specs");
    const specs = [...new Bun.Glob("**/*.md").scanSync({ cwd: specsDir, absolute: false })].map(
      file => ({ file, content: readFileSync(join(specsDir, file), "utf-8") }),
    );
    expect(specs.length, "the spec scan found nothing, so this proves nothing").toBeGreaterThan(10);
    expect(crossSpecCollisions(buildScRegistry(specs))).toEqual([]);
  });
});
