/**
 * Covers SC-1985..SC-1992 (DOC-HYGIENE-ARCHITECTURE-SPEC.md), #579.
 *
 * `specs/PROJECT-STATE.md` was a rendered `PROJECT-STATE.md` snapshot from
 * 2026-09-22 with spec frontmatter pasted on top, and
 * `.claude/rules/specs-routing.md` — the table every agent is told to consult
 * before changing an area — presented it as the governing spec for project
 * state management. It stated `Suite: 984 tests` against a suite of 11,961.
 * An agent that followed the routing table got no requirements at all.
 *
 * A gap in the table is visible. This was not: the reader believes they have
 * arrived. Same harm as `.claude/rules/config-access.md`'s Silent Default
 * Substitution, with a document as the victim.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  ambiguousSpecNames,
  countCriteria,
  readSpecRequirements,
  requirementViolations,
  specIsReferenced,
  testableViolations,
} from "../lib/spec-requirements";
import { collectSpecFiles } from "../lib/spec-files";
import { generateScopedRules } from "../lib/generators/agents-md";
import { scanProject } from "../lib/scanner";

const REPO = join(import.meta.dir, "..");
const SPECS = join(REPO, "specs");

function specDir(): string {
  return mkdtempSync(join(tmpdir(), "rg-579-"));
}

function writeSpec(dir: string, name: string, frontmatter: string, body: string): void {
  const full = join(dir, name);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, `---\n${frontmatter}\n---\n\n${body}\n`);
}

describe("#579: a document the routing table calls a spec states something", () => {
  test("SC-1985: a spec with no criteria and no declaration is refused, and the live tree has none", () => {
    // The synthetic half first, because the live half goes green the moment
    // this issue lands and a case that can only fail on today's tree is a
    // case that stops being able to fail — `.claude/rules/checks-must-be-able-to-fail.md`.
    const dir = specDir();
    try {
      writeSpec(dir, "SILENT-SPEC.md", "doc-type: spec\ngoverns: something\ntestable: true", "# Prose only.");
      const v = requirementViolations([readSpecRequirements(dir, "SILENT-SPEC.md")]);
      expect(v).toHaveLength(1);
      expect(v[0]).toContain("SILENT-SPEC.md states no criteria");
      // Actionable, not just accusatory: the message has to name the way out.
      expect(v[0], "the refusal does not say how to clear it").toContain("criteria-reason");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const live = requirementViolations(
      collectSpecFiles(SPECS).map(s => readSpecRequirements(SPECS, s)),
    );
    expect(live, live.join("\n")).toEqual([]);
  });

  test("SC-1986: the declaration is refused when it is a mute rather than a statement", () => {
    // `criteria: none` with no reason is the exemption-list failure mode
    // reproduced in frontmatter: a line that silences the check and tells the
    // reader nothing. The check exists to reach a reader, so a declaration
    // that reaches no reader is not a declaration.
    const dir = specDir();
    try {
      writeSpec(dir, "MUTE.md", "doc-type: spec\ngoverns: x\ncriteria: none", "# Prose.");
      const v = requirementViolations([readSpecRequirements(dir, "MUTE.md")]);
      expect(v).toHaveLength(1);
      expect(v[0]).toContain("no \"criteria-reason:\"");

      // The positive control. Without it, a `requirementViolations` that
      // refused every `criteria: none` would satisfy the case above and make
      // the declaration mechanism useless, which is the cheapest wrong fix.
      writeSpec(dir, "STUB.md", "doc-type: spec\ngoverns: x\ncriteria: none\ncriteria-reason: redirect stub", "# Go here.");
      expect(requirementViolations([readSpecRequirements(dir, "STUB.md")])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SC-1987: a spec that declares none and states some is refused too", () => {
    // Both directions, like every other ratchet here. A declaration that
    // outlives the gap keeps the routing table warning readers away from a
    // document that now has what they came for — and rots into a line nobody
    // reads, which is how the allowlist this replaced would have failed.
    const dir = specDir();
    try {
      writeSpec(
        dir,
        "GAINED.md",
        "doc-type: spec\ngoverns: x\ncriteria: none\ncriteria-reason: unwritten",
        "## Success Criteria\n\n- [ ] SC-1: a thing\n",
      );
      const v = requirementViolations([readSpecRequirements(dir, "GAINED.md")]);
      expect(v).toHaveLength(1);
      expect(v[0]).toContain("declares \"criteria: none\" and states 1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SC-1988: criteria are counted on any checkbox, not on the SC- prefix", () => {
    // The first census written for this issue counted `- [ ] SC-` and
    // reported BOOTSTRAP-TEST-PLAN.md as stating nothing. It states 41,
    // numbered `TP-1`. A detector narrower than what it detects, pointed at a
    // correct document — and it would have demanded a false `criteria: none`
    // declaration on a spec that has criteria.
    expect(countCriteria("- [ ] TP-1: a thing\n- [x] AC-2: another\n")).toBe(2);
    expect(countCriteria("- [ ] SC-1: a thing\n")).toBe(1);
    expect(countCriteria("Prose about `- [ ]` checkboxes mid-sentence.\n")).toBe(0);

    // The live control, because the regex above proves nothing about the file
    // that motivated it.
    expect(
      countCriteria(readFileSync(join(SPECS, "BOOTSTRAP-TEST-PLAN.md"), "utf-8")),
      "the plan that motivated this reads as stating nothing",
    ).toBeGreaterThan(10);
  });

  test("SC-1989: a bare spec name that also names another file does not credit the spec", () => {
    // DRIFT-2 credited a testable spec when any test file's text contained
    // its name. `specs/PROJECT-STATE.md` and the generated root
    // `PROJECT-STATE.md` share a basename, and ten test files mention the
    // root one.
    //
    // This is the fifth shape aimed at #579's own fix: the issue prescribes
    // `testable: true` plus "a test naming it, which
    // test/update-project-state.test.ts can do in one line". Flipping the
    // flag alone would have turned DRIFT-2 green on the strength of
    // test/organize-project.test.ts discussing a status file.
    const ambiguous = new Set(["PROJECT-STATE.md"]);
    const mentionsTheOtherFile = 'readFileSync(join(root, "PROJECT-STATE.md"))';

    expect(
      specIsReferenced(mentionsTheOtherFile, "PROJECT-STATE.md", ambiguous),
      "a test naming the ROOT file credited the spec",
    ).toBe(false);
    expect(
      specIsReferenced('readFileSync("specs/PROJECT-STATE.md")', "PROJECT-STATE.md", ambiguous),
      "the qualified form does not credit the spec it names",
    ).toBe(true);

    // The other direction, and the reason the rule is narrowed to ambiguous
    // names: requiring `specs/` from every test would orphan 15 of this
    // repo's 22 testable specs, which is a refusal nobody could act on.
    expect(specIsReferenced("SCAFFOLD-DECOMPOSITION-SPEC.md", "SCAFFOLD-DECOMPOSITION-SPEC.md", ambiguous)).toBe(true);
  });

  test("SC-1990: the ambiguity is measured against the tree, not listed", () => {
    // A hard-coded list of colliding names is a second decider that agrees
    // until a new collision arrives, and nothing would say so. It is computed
    // from the same tree DRIFT-2 reads.
    const found = ambiguousSpecNames(REPO, collectSpecFiles(SPECS));
    expect([...found], "the live collision is not detected").toContain("PROJECT-STATE.md");

    // Non-vacuous in the other direction: a walk that reported EVERY spec as
    // ambiguous would satisfy the line above and orphan the whole surface.
    expect(found.size, "every spec was called ambiguous, so the walk is not discriminating")
      .toBeLessThan(collectSpecFiles(SPECS).length);
  });

  test("SC-1991: testable: carries a value every reader agrees on", () => {
    // Every reader asks `=== "true"`, so `yes` means false while saying the
    // opposite to a human. `specs/DA-COMPLIANCE-SPEC.md` carried `testable:
    // no`, which happened to mean what its author intended; the inverse would
    // have dropped a spec out of the conformity surface silently.
    const dir = specDir();
    try {
      writeSpec(dir, "YES.md", "doc-type: spec\ngoverns: x\ntestable: yes", "- [ ] SC-1: a thing");
      const v = testableViolations(dir, ["YES.md"]);
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('"testable: yes"');

      writeSpec(dir, "OK.md", "doc-type: spec\ngoverns: x\ntestable: false", "- [ ] SC-1: a thing");
      expect(testableViolations(dir, ["OK.md"]), "a correct value was refused").toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const live = testableViolations(SPECS, collectSpecFiles(SPECS));
    expect(live, live.join("\n")).toEqual([]);
  });
});

describe("#579: the routing table carries the declaration", () => {
  test("SC-1992: a row sending a reader to a criteria-free spec says so in the row", () => {
    // This is the whole argument for frontmatter over an allowlist: the
    // reader harmed by a criteria-free spec is the one the TABLE sends
    // there, and a JSON file in `.claude/` is not on that path. A
    // declaration nobody renders is an allowlist with extra steps.
    const routing = generateScopedRules(scanProject(REPO)).find(r => r.filename === "specs-routing.md");
    expect(routing, "there is no routing table to check").toBeDefined();

    // Keyed on the row's FIRST CELL, not on the line. One spec's `governs`
    // cites another spec's filename, so a whole-line `includes` matched two
    // rows — `lib/spec-listing.ts`'s "a mention is not a listing", arriving
    // in the table that module is about.
    const rowFor = (file: string): string | undefined =>
      routing!.content.split("\n").find(l => l.split("|")[1]?.trim() === file);

    // A `testable: false` spec on purpose. The first draft keyed this on an
    // allowlisted testable one and turned DRIFT-2 red: DRIFT-2 credits a spec
    // when any test file's text contains its name, so naming it here as a
    // FIXTURE made it read as tested, and the ratchet then demanded it be
    // delisted — certifying an untested spec on the strength of this line.
    // That is the defect this issue is about, produced by the test written to
    // fix it. Nothing below names such a spec, including these comments.
    const declared = rowFor("BOOTSTRAP-DATA-FLOW-SPEC.md");
    expect(declared, "the declared spec has no row at all").toBeDefined();
    expect(declared, "the row promises governance and omits that there are no criteria")
      .toContain("STATES NO CRITERIA");

    // The positive control, and it is the half that matters: a generator
    // marking EVERY row satisfies the line above while telling a reader
    // nothing. A spec that states criteria must read as an ordinary row.
    const ordinary = rowFor("SCAFFOLD-DECOMPOSITION-SPEC.md");
    expect(ordinary, "the control spec has no row").toBeDefined();
    expect(ordinary, "a spec with criteria was marked as having none")
      .not.toContain("STATES NO CRITERIA");
  });
});

describe("#579: specs/PROJECT-STATE.md is a spec", () => {
  test("it states the criteria that were homeless, and no longer renders a status snapshot", () => {
    const src = readFileSync(join(SPECS, "PROJECT-STATE.md"), "utf-8");

    const declares = (text: string, id: string): boolean =>
      text.includes(`- [x] ${id}:`) || text.includes(`- [ ] ${id}:`);

    // The relocated ids, by name. A count would pass if the block were
    // replaced by any twelve criteria.
    for (const id of ["SC-296", "SC-297", "SC-298", "SC-308", "SC-1960", "SC-1963"]) {
      expect(declares(src, id), `${id} did not arrive`).toBe(true);
    }

    // And they left. Two homes for one criterion is the condition this issue
    // is about, arriving from the other side.
    const old = readFileSync(join(SPECS, "AGENTS-MD-TEMPLATE-SPEC.md"), "utf-8");
    for (const id of ["SC-296", "SC-1960"]) {
      expect(declares(old, id), `${id} is still declared in two specs`).toBe(false);
    }

    // The snapshot's own tells — searched in the SLICE below the history
    // section, not in the document. The first draft of this assertion failed
    // against a correct file, because the section recording what this file
    // used to be quotes `Suite: 984 tests` in order to say it was stale. That
    // is `.claude/rules/checks-must-be-able-to-fail.md`'s "search the slice,
    // not the document", caught by the check it was being written for.
    const contract = src.slice(src.indexOf("## The contract"));
    expect(contract.length, "the contract section is missing, so the tells below are vacuous")
      .toBeGreaterThan(500);
    expect(contract, "the stale suite count is still the body").not.toContain("Suite: 984 tests");
    expect(contract, "the rendered status table is still the body").not.toContain("| Status | SC | What |");
    expect(contract, "the snapshot's priorities list is still the body").not.toContain("**Next priorities:**");
  });
});
