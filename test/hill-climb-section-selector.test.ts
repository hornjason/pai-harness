/**
 * Covers SC-2300..SC-2305 (INSTRUCTION-COMPLIANCE-SPEC.md), #704.
 *
 * The hill-climb's section selector used to be a nested conditional inside
 * `applyHillClimb`: `## Testing Rules` if the id was literally `COMP-2`,
 * otherwise `## Efficiency Rules`, otherwise `## Never Do`. `marcus.md`
 * carries only the first of those three, so every COMP except COMP-2 was
 * refused by a brief that was holding an insertion point the whole time.
 *
 * Everything here drives the REAL exported bindings —
 * `resolveHillClimbSection` and `applyHillClimb` — over briefs written to a
 * temp directory. Nothing in this file reimplements the selector; a local
 * copy would be a test of itself, and the lib could stop resolving entirely
 * with every case still green.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { BRIEF_CONSTRAINTS_SECTION } from "../lib/agents-md-sections";
import {
  applyHillClimb,
  hillClimbSectionPreference,
  hillClimbSkipSentence,
  resolveHillClimbSection,
  HILL_CLIMB_DURABLE_SECTION,
  HILL_CLIMB_SECTIONS,
  REINFORCEMENT_PREFIX,
  type HillClimbAction,
} from "../lib/compliance-report";
import {
  classifySkip,
  emptyHillClimbStates,
  HILL_CLIMB_STATES,
  UNMEASURED_HILL_CLIMB_STATES,
} from "../scripts/persist-compliance";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every COMP id this repository's grader can emit.
 *
 * Read off `lib/transcript-checker.ts`'s criterion declarations and
 * `.claude/rungate/compliance.json`'s rule keys — the two positions that
 * decide which ids exist — rather than typed out here. A hand-written list
 * would agree with itself forever, which is the artefact trap (#530): it
 * would answer "is this id covered" with the ids the author remembered.
 */
function graderCompIds(): string[] {
  const checker = readFileSync(join(REPO_ROOT, "lib", "transcript-checker.ts"), "utf-8");
  const declared = [...checker.matchAll(/^\s*id: "(COMP-\d+)",$/gm)].map((m) => m[1]!);
  const config = JSON.parse(
    readFileSync(join(REPO_ROOT, ".claude", "rungate", "compliance.json"), "utf-8"),
  ) as { rules: Record<string, unknown> };
  const configured = Object.keys(config.rules).filter((k) => /^COMP-\d+$/.test(k));
  return [...new Set([...declared, ...configured])].sort();
}

let root: string;
let briefPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hill-climb-selector-"));
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  briefPath = join(root, ".claude", "agents", "marcus.md");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const action = (compId: string): HillClimbAction => ({
  compId,
  rule: `${compId}: the rule text`,
  reinforcement: `${compId}: a reinforcement nothing in this brief already says`,
  consecutiveFails: 4,
  tier: 1,
});

/** One run of the REAL loop over `brief`, writing nothing. */
function runOne(
  brief: string,
  compId: string,
): { applied: string[]; kinds: string[]; sentences: string[] } {
  writeFileSync(briefPath, brief);
  const { applied, skipped, skipOutcomes } = applyHillClimb(briefPath, [action(compId)], {
    destination: "DISCARD",
  });
  return { applied, kinds: skipOutcomes.map((o) => o.kind), sentences: skipped };
}

const briefWithOnly = (heading: string) =>
  `# Marcus\n\n## Context\n\n- Read the issue.\n\n${heading}\n\n- An existing bullet.\n\n## Reference\n\n| a | b |\n`;

describe("SC-2300: one binding maps a COMP id to a heading, with one call site", () => {
  const SOURCE = readFileSync(join(REPO_ROOT, "lib", "compliance-report.ts"), "utf-8");

  test("the selector is called from exactly one place in the module", () => {
    // Two deciders answering one question are behaviourally one, and a
    // mutation of either leaves the other holding every case up
    // (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape). The
    // declaration is excluded by matching the CALL form.
    const calls = [...SOURCE.matchAll(/resolveHillClimbSection\(/g)].length;
    const declarations = [...SOURCE.matchAll(/export function resolveHillClimbSection\(/g)].length;
    expect(declarations).toBe(1);
    expect(calls - declarations).toBe(1);
  });

  test("no second position re-derives a heading from a COMP id", () => {
    // The pre-#704 defect in one line: the heading strings were read inside
    // `applyHillClimb`. The three GENERATED headings may now appear only in
    // `HILL_CLIMB_SECTIONS` and in `COMP_PRIMARY_SECTION`, so there is one
    // thing to mutate.
    const inApply = SOURCE.slice(SOURCE.indexOf("export function applyHillClimb"));
    expect(inApply.length).toBeGreaterThan(0);
    const generated = HILL_CLIMB_SECTIONS.filter((h) => h !== HILL_CLIMB_DURABLE_SECTION);
    expect(generated).toHaveLength(3);
    for (const heading of generated) {
      // Asserted positively first: a module naming no headings at all would
      // satisfy the `not.toContain` below vacuously.
      expect(SOURCE.split(`"${heading}"`).length - 1).toBeGreaterThan(0);
      expect(inApply).not.toContain(`"${heading}"`);
    }
  });

  test("the durable heading is read from its owner, never spelled here (#655)", () => {
    // `## Project Constraints` is `lib/agents-md-sections.ts`'s string — the
    // same one `preserveSections` anchors on. A literal copy in this module
    // is a second position naming it, and the two stop agreeing the day the
    // preserver's heading is reworded (#621).
    expect(HILL_CLIMB_DURABLE_SECTION).toBe(BRIEF_CONSTRAINTS_SECTION.label);
    expect(SOURCE).not.toContain(`"${HILL_CLIMB_DURABLE_SECTION}"`);
    // And it really is the first thing every COMP tries, which is the
    // ordering #655 measured rather than a preference between headings.
    expect(HILL_CLIMB_SECTIONS[0]).toBe(HILL_CLIMB_DURABLE_SECTION);
  });
});

describe("SC-2301: every COMP id the grader can emit resolves to a heading", () => {
  test("the id population is non-empty and read from the two declaring positions", () => {
    // The closure claim below is vacuous over an empty set, and an empty set
    // is exactly what a renamed field or a moved config produces.
    const ids = graderCompIds();
    expect(ids.length).toBeGreaterThanOrEqual(12);
    expect(ids).toContain("COMP-2");
    expect(ids).toContain("COMP-13");
  });

  test("each one has a declared preference covering every heading", () => {
    for (const id of graderCompIds()) {
      const preference = hillClimbSectionPreference(id);
      expect(preference, `${id} has no declared destination heading`).not.toBeNull();
      // A preference that omits a heading is a COMP that a brief carrying
      // only that heading still cannot accept — the defect one size smaller.
      expect([...preference!].sort()).toEqual([...HILL_CLIMB_SECTIONS].sort());
    }
  });
});

describe("SC-2302: a brief carrying ANY one of the headings accepts every COMP", () => {
  test("each heading, alone, accepts a reinforcement for each id", () => {
    const ids = graderCompIds();
    let insertions = 0;
    for (const heading of HILL_CLIMB_SECTIONS) {
      for (const id of ids) {
        const { applied, kinds } = runOne(briefWithOnly(heading), id);
        expect(applied, `${id} was refused by a brief carrying ${heading}`).toHaveLength(1);
        expect(kinds).toEqual([]);
        insertions++;
      }
    }
    // Asserted positively and counted: `every` over an empty product is
    // true, and so is a loop that never ran.
    expect(insertions).toBe(ids.length * HILL_CLIMB_SECTIONS.length);
  });

  test("the durable region outranks every COMP's own preference (#655)", () => {
    // Pair, varying ONE thing: whether the brief carries the region. The
    // generated three are identical in both halves, so the difference can
    // only be the region. A reinforcement in a generated section is
    // destroyed by the next scaffold run, so durability beats topicality.
    const WITHOUT =
      "# Marcus\n\n## Efficiency Rules\n\n- e\n\n## Testing Rules\n\n- t\n\n## Never Do\n\n- n\n";
    const WITH = `${WITHOUT}\n${HILL_CLIMB_DURABLE_SECTION}\n\n- a project rule.\n`;
    for (const id of ["COMP-2", "COMP-7", "COMP-9"]) {
      expect(resolveHillClimbSection(id, WITHOUT)).toMatchObject({ kind: "RESOLVED" });
      expect((resolveHillClimbSection(id, WITHOUT) as { heading: string }).heading).not.toBe(
        HILL_CLIMB_DURABLE_SECTION,
      );
      expect(resolveHillClimbSection(id, WITH)).toEqual({
        kind: "RESOLVED",
        compId: id,
        heading: HILL_CLIMB_DURABLE_SECTION,
        index: WITH.indexOf(HILL_CLIMB_DURABLE_SECTION),
      });
    }
  });

  test("the preferred heading wins when more than one generated one is present", () => {
    // Varying ONE thing: the id. The brief is byte-identical in all three
    // halves, so a difference can only be the mapping (#585). The durable
    // region is deliberately absent — with it present every id resolves
    // there and the mapping would be invisible, which is the case above.
    const ALL_THREE =
      "# Marcus\n\n## Efficiency Rules\n\n- e\n\n## Testing Rules\n\n- t\n\n## Never Do\n\n- n\n";
    // The INDEX is asserted beside the heading, not the heading alone. A
    // resolver that reported the preferred name while returning somebody
    // else's offset would satisfy a name-only assertion and still splice the
    // rule into the wrong section — which is the exact shape of the defect
    // being fixed, reported correctly.
    for (const [id, heading] of [
      ["COMP-2", "## Testing Rules"],
      ["COMP-7", "## Never Do"],
      ["COMP-9", "## Efficiency Rules"],
    ] as const) {
      expect(resolveHillClimbSection(id, ALL_THREE)).toEqual({
        kind: "RESOLVED",
        compId: id,
        heading,
        index: ALL_THREE.indexOf(heading),
      });
    }
  });
});

describe("SC-2303: a brief with none of the three still refuses — #646's state survives", () => {
  const NONE = "# Quinn\n\n## Core Rule\n\n- Test it.\n\n## Report Format\n\n- Say what ran.\n";

  test("nothing is applied and the outcome is NO_SECTION", () => {
    const { applied, kinds, sentences } = runOne(NONE, "COMP-7");
    expect(applied).toEqual([]);
    expect(kinds).toEqual(["NO_SECTION"]);
    expect(sentences).toEqual(["COMP-7: no suitable section found in brief"]);
  });

  test("the brief on disk is unchanged, not merely unreported", () => {
    // A refusal that still wrote something would read identically through
    // the return value. `COMMIT` is the destination that writes in place.
    writeFileSync(briefPath, NONE);
    const r = applyHillClimb(briefPath, [action("COMP-7")], { destination: "COMMIT" });
    expect(r.applied).toEqual([]);
    expect(readFileSync(briefPath, "utf-8")).toBe(NONE);
    expect(r.write.path).toBeNull();
  });
});

describe("SC-2304: an unmapped COMP id is refused BY NAME, not as a missing heading", () => {
  const ALL_THREE =
    "# Marcus\n\n## Efficiency Rules\n\n- e\n\n## Testing Rules\n\n- t\n\n## Never Do\n\n- n\n";

  test("the two refusals are different kinds over inputs that differ in one thing", () => {
    // The pair: same id-with-no-mapping against a brief that HAS every
    // heading, and a mapped id against a brief that has none. If both came
    // back NO_SECTION, a reader would go and edit a brief that is fine.
    const unmapped = resolveHillClimbSection("COMP-9001", ALL_THREE);
    expect(unmapped.kind).toBe("UNMAPPED_COMP");
    expect(hillClimbSkipSentence(unmapped as never)).toContain("COMP-9001");
    expect(hillClimbSkipSentence(unmapped as never)).toContain("no destination heading declared");

    const noHeadings = resolveHillClimbSection("COMP-7", "# Marcus\n\n## House Style\n\n- x\n");
    expect(noHeadings.kind).toBe("NO_SECTION");
  });

  test("the loop reports it as its own outcome rather than dropping it", () => {
    const { applied, kinds, sentences } = runOne(ALL_THREE, "COMP-9001");
    expect(applied).toEqual([]);
    expect(kinds).toEqual(["UNMAPPED_COMP"]);
    expect(sentences[0]).toContain("COMP-9001");
  });

  test("the receipt carries it as its own UNMEASURED state", () => {
    // A refusal nothing reports is a refusal nobody acts on. `classifySkip`
    // is the one renaming of the decision — asked here with the real outcome
    // the resolver produced, not a hand-written literal.
    const outcome = resolveHillClimbSection("COMP-9001", ALL_THREE);
    expect(outcome.kind).toBe("UNMAPPED_COMP");
    const state = classifySkip(outcome as never);
    expect(state).toBe("COMP_HAS_NO_SECTION_MAPPING");
    expect(HILL_CLIMB_STATES).toContain("COMP_HAS_NO_SECTION_MAPPING");
    // Nobody knows what reinforcing it would have done, so it is not clean.
    expect(UNMEASURED_HILL_CLIMB_STATES).toContain("COMP_HAS_NO_SECTION_MAPPING");
    expect(Object.keys(emptyHillClimbStates())).toContain("COMP_HAS_NO_SECTION_MAPPING");
  });

  test("ship.js declares the state in both of its positions", () => {
    // `workflows/*.js` cannot import (#69), so the state list exists three
    // times. A state declared in the script and not in the relay schema is
    // filtered out of the reply one hop before the operator reads it (#646).
    const ship = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");
    const schema = ship.slice(
      ship.indexOf("const PERSIST_RECEIPT_SCHEMA"),
      ship.indexOf("const PERSIST_SIGNATURE_STATES"),
    );
    const signature = ship.slice(
      ship.indexOf("const PERSIST_SIGNATURE_STATES"),
      ship.indexOf("const PERSIST_READINGS"),
    );
    // Both cuts must be non-empty, or `toContain` is asked of "" and the
    // claim is satisfied by a slice that found nothing (#297).
    expect(schema.length).toBeGreaterThan(0);
    expect(signature.length).toBeGreaterThan(0);
    expect(schema).toContain("COMP_HAS_NO_SECTION_MAPPING");
    expect(signature).toContain("COMP_HAS_NO_SECTION_MAPPING");
  });
});

describe("SC-2305: the reinforcement lands INSIDE the resolved section", () => {
  test("it is before the next heading, not after the document", () => {
    // Asserted by POSITION, not by presence. Appending at the end of the
    // brief — the cheapest wrong fix, named in #704 and in
    // `.claude/rules/config-access.md` — also makes the string present.
    const BRIEF =
      "# Marcus\n\n## Testing Rules\n\n- t\n\n## Workflow\n\n- w\n\n## Reference\n\n| a |\n";
    writeFileSync(briefPath, BRIEF);
    applyHillClimb(briefPath, [action("COMP-13")], { destination: "COMMIT" });
    const after = readFileSync(briefPath, "utf-8");

    const sectionAt = after.indexOf("## Testing Rules");
    const nextHeadingAt = after.indexOf("\n## Workflow");
    const bulletAt = after.indexOf(REINFORCEMENT_PREFIX);
    expect(sectionAt).toBeGreaterThanOrEqual(0);
    expect(nextHeadingAt).toBeGreaterThan(sectionAt);
    expect(bulletAt).toBeGreaterThan(sectionAt);
    expect(bulletAt).toBeLessThan(nextHeadingAt);
    // And the sections that follow are still there and still in order, so
    // the insertion did not consume the rest of the document.
    expect(after.indexOf("## Reference")).toBeGreaterThan(nextHeadingAt);
  });

  test("a resolved section that is LAST still takes it inside itself", () => {
    const BRIEF = "# Marcus\n\n## Workflow\n\n- w\n\n## Never Do\n\n- n\n";
    writeFileSync(briefPath, BRIEF);
    applyHillClimb(briefPath, [action("COMP-7")], { destination: "COMMIT" });
    const after = readFileSync(briefPath, "utf-8");
    expect(after.indexOf(REINFORCEMENT_PREFIX)).toBeGreaterThan(after.indexOf("## Never Do"));
    // The only heading after the insertion point is none — so the claim
    // that makes this case non-vacuous is that it is NOT under `## Workflow`.
    expect(after.indexOf(REINFORCEMENT_PREFIX)).toBeGreaterThan(after.indexOf("## Workflow"));
    expect(after.slice(after.indexOf("## Never Do"))).toContain(REINFORCEMENT_PREFIX);
  });

  test("a `### ` sub-heading is not mistaken for the section", () => {
    // `indexOf("## Never Do")` matches the last eleven characters of
    // `### Never Do`, and the insertion arithmetic then measures from an
    // index one past where the line starts.
    const BRIEF = "# Marcus\n\n## Efficiency Rules\n\n### Never Do\n\n- n\n";
    const r = resolveHillClimbSection("COMP-7", BRIEF);
    expect(r).toMatchObject({ kind: "RESOLVED", heading: "## Efficiency Rules" });
    expect((r as { index: number }).index).toBe(BRIEF.indexOf("## Efficiency Rules"));
  });
});
