/**
 * COMP-4 was wrong in both directions at once (#287).
 *
 * `test/compliance-tests.json` declares the contract:
 *
 *     "transcript scan: Bash with 'shasum' AND Edit with 'SPEC_HASH' or 'bootstrap'"
 *
 * An **AND across two data sources**. The implementation was an **OR within
 * one**: `data.bashes.some(b => b.includes("shasum") || b.includes("SPEC_HASH"))`,
 * and `data.edits` was never consulted after the filter that selected the spec
 * edits. So COMP-4 was satisfied by running `shasum` on any file whatsoever,
 * and the one thing the rule exists to verify — that the constant was updated
 * — was the one thing never checked.
 *
 * The other direction: it fired on any path containing `specs/` and ending
 * `.md`. Exactly two specs have a drift hash guarding them. The spec nearly
 * every harness run edits — `specs/HARNESS-STANDARD.md`, where SC records are
 * written — has none, so the common correct action was graded IGNORED at
 * weight 10 and the only way to clear it was a `shasum` whose output nothing
 * read.
 *
 * The two compose into a check that is reliably green and never right: the
 * ritual that clears the false positive also satisfies the false negative.
 *
 * Covers SC-755..758 of GATE-CONTRACTS-SPEC.md.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  discoverSpecHashGuards,
  specHashViolations,
  getCriteria,
  evaluateCriteria,
  type TranscriptData,
  type ToolCall,
} from "../lib/transcript-checker";

const ROOT = join(import.meta.dir, "..");

/** A TranscriptData built the way scripts/audit-transcript.ts builds one. */
function dataFrom(calls: ToolCall[]): TranscriptData {
  const of = (n: string) => calls.filter(c => c.name === n).map(c => c.input.file_path || "?");
  return {
    calls,
    reads: of("Read"),
    bashes: calls.filter(c => c.name === "Bash").map(c => c.input.command || "?"),
    edits: of("Edit"),
    writes: of("Write"),
    duplicateReads: {},
    firstThreeReads: [],
    promptContent: "",
  };
}

const edit = (p: string, extra: Record<string, any> = {}): ToolCall =>
  ({ name: "Edit", input: { file_path: p, ...extra } });
const bash = (command: string): ToolCall => ({ name: "Bash", input: { command } });

const GUARDS = discoverSpecHashGuards(ROOT);
const comp4 = () => getCriteria("marcus").find(c => c.id === "COMP-4")!;

describe("#287: which specs actually have a drift hash", () => {
  test("the guarded set is discovered, not hardcoded in the checker", () => {
    // SC-756. Two specs are guarded today. Writing that list into
    // transcript-checker.ts is the hardcoding defect class this repo keeps
    // finding; it is read out of the guard sources instead, so adding or
    // removing a hash moves the check without anyone remembering to.
    expect(GUARDS.specs.sort()).toEqual([
      "BOOTSTRAP-DATA-FLOW-SPEC.md",
      "BOOTSTRAP-TEST-PLAN.md",
    ]);
    // ONE guard file as of #579. `test/phase-5.test.ts` carried its own
    // `SPEC_HASH` over the same spec — two deciders answering one question
    // about one input, and they were found by exactly that: a deliberate
    // frontmatter change re-pinned one and left the other red with an
    // identical message about an identical fact. It calls `checkSpecDrift`
    // now, which also covers the test plan the copy did not.
    //
    // This case going red at the collapse is the discovery working. A
    // hardcoded list in the checker would have stayed green over it, which
    // is SC-756's whole point.
    expect(GUARDS.guardFiles.sort()).toEqual(["test/helpers/scaffold-fixture.ts"]);
  });

  test("the discovery is reading the tree, not returning a constant", () => {
    // Without this the case above is satisfied by a literal that happens to
    // be right today — which is the thing it exists to prevent.
    const empty = discoverSpecHashGuards(join(ROOT, "test", "fixtures"));
    expect(empty.specs).toEqual([]);
    expect(empty.guardFiles).toEqual([]);
  });

  test("a guard named only in a comment is not a guard", () => {
    // The self-reference trap, which this file walked straight into: the
    // docblock above explains the discovery and names both the constant and
    // the specs, and the first version of the scan reported this very file
    // as a guard for AGENTS.md and CLAUDE.md.
    //
    // Planted rather than asserted against the real tree, because comment
    // stripping scored 0 red without it — nothing in the tree currently
    // writes the pattern inside a comment, so the protection was real and
    // unmeasured.
    // Assembled from fragments so the pattern does not appear verbatim in
    // THIS file's source. Written out whole, the scan reads the fixture
    // string as code and reports this test file as a guard for a spec that
    // does not exist — which it did, and which is the same trap one level
    // down.
    const DECL = `const SPEC_${"HASH"} = "abc";`;
    const CALL = `const p = jo${"in"}(specsDir, "INVENTED-SPEC.md");`;

    const dir = mkdtempSync(join(tmpdir(), "comp4-guard-"));
    try {
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(join(dir, "test", "prose.ts"), `/**\n * ${DECL}\n * ${CALL}\n */\nexport const unrelated = 1;\n`);
      expect(discoverSpecHashGuards(dir).specs).toEqual([]);

      // ...and the same text as code IS a guard, so the case above is not
      // passing because the scan reads nothing at all.
      writeFileSync(join(dir, "test", "real.ts"), `${DECL}\n${CALL}\n`);
      expect(discoverSpecHashGuards(dir).specs).toEqual(["INVENTED-SPEC.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the specs it names are really hash-guarded", () => {
    // Executed, not described: each named spec must appear in a guard file
    // alongside a hash constant.
    for (const spec of GUARDS.specs) {
      const inSomeGuard = GUARDS.guardFiles.some(g =>
        readFileSync(join(ROOT, g), "utf-8").includes(spec),
      );
      expect(inSomeGuard, `${spec} is named as guarded but no guard file mentions it`).toBe(true);
    }
  });
});

describe("#287: COMP-4 checks the edit side, not just the word shasum", () => {
  const GUARDED_SPEC = "/repo/specs/BOOTSTRAP-DATA-FLOW-SPEC.md";

  test("Defect 1: shasum on an unrelated file does not clear a guarded spec edit", () => {
    // SC-755. The whole of defect 1. This was FOLLOWED.
    const v = specHashViolations(
      dataFrom([edit(GUARDED_SPEC), bash("shasum README.md")]),
      GUARDS,
    );
    expect(v.length, `expected a violation, got none`).toBeGreaterThan(0);
    expect(v.join(" ")).toContain("BOOTSTRAP-DATA-FLOW-SPEC.md");
  });

  test("Defect 2: editing a spec with no drift hash is not a violation", () => {
    // SC-757. HARNESS-STANDARD.md is where SC records go, so nearly every
    // run edits it, and nearly every run was graded IGNORED at weight 10 for
    // doing the correct thing.
    expect(specHashViolations(dataFrom([edit("/repo/specs/HARNESS-STANDARD.md")]), GUARDS)).toEqual([]);
  });

  test("the negative control: a real hash update is clean", () => {
    // The fix must not buy green by exempting everything. This is the shape
    // the rule was written for and it has to still pass.
    expect(
      specHashViolations(
        dataFrom([
          edit(GUARDED_SPEC),
          bash("shasum -a 256 specs/BOOTSTRAP-DATA-FLOW-SPEC.md | cut -c1-16"),
          edit("/repo/test/phase-5.test.ts", { new_string: 'const SPEC_HASH = "05f388d8b3a2e036";' }),
        ]),
        GUARDS,
      ),
    ).toEqual([]);
  });

  test("editing the constant without measuring it is not enough either", () => {
    // The declared contract is an AND. Typing a new hash without running the
    // command that produces one is a guess.
    const v = specHashViolations(
      dataFrom([edit(GUARDED_SPEC), edit("/repo/test/phase-5.test.ts", { new_string: "const SPEC_HASH = \"deadbeef\";" })]),
      GUARDS,
    );
    expect(v.length).toBeGreaterThan(0);
    expect(v.join(" ")).toContain("shasum");
  });

  test("no spec edit at all is exempt", () => {
    expect(specHashViolations(dataFrom([edit("/repo/lib/x.ts")]), GUARDS)).toEqual([]);
  });

  test("a Write counts the same as an Edit", () => {
    // `writes` was concatenated with `edits` in the original and that part
    // was right. Keeping it asserted so the rewrite does not drop it.
    const v = specHashViolations(
      dataFrom([{ name: "Write", input: { file_path: GUARDED_SPEC } }, bash("shasum README.md")]),
      GUARDS,
    );
    expect(v.length).toBeGreaterThan(0);
  });
});

describe("#287: the criterion and the declared checkMethod agree", () => {
  const declared = (() => {
    const j = JSON.parse(readFileSync(join(ROOT, "test", "compliance-tests.json"), "utf-8"));
    return j.tests.find((t: any) => t.id === "COMP-4");
  })();

  test("the declaration exists and names both sides of the AND", () => {
    expect(declared, "COMP-4 is not declared in test/compliance-tests.json").toBeTruthy();
    expect(declared.checkMethod).toContain("shasum");
    expect(declared.checkMethod).toContain("SPEC_HASH");
    expect(declared.checkMethod.toUpperCase()).toContain(" AND ");
  });

  test("the implementation actually requires both, one signal at a time", () => {
    // SC-758. Not a grep. The declaration says AND, so removing EITHER signal
    // from an otherwise-clean transcript must produce a violation — which is
    // the only form of "they agree" that a reworded comment cannot satisfy.
    const spec = "/repo/specs/BOOTSTRAP-DATA-FLOW-SPEC.md";
    const shasumCall = bash("shasum -a 256 specs/BOOTSTRAP-DATA-FLOW-SPEC.md");
    const constantCall = edit("/repo/test/phase-5.test.ts", { new_string: 'const SPEC_HASH = "x";' });

    expect(specHashViolations(dataFrom([edit(spec), shasumCall, constantCall]), GUARDS)).toEqual([]);
    expect(specHashViolations(dataFrom([edit(spec), constantCall]), GUARDS).length,
      "dropping the shasum left it clean — the AND is an OR again").toBeGreaterThan(0);
    expect(specHashViolations(dataFrom([edit(spec), shasumCall]), GUARDS).length,
      "dropping the constant edit left it clean — this is #287 verbatim").toBeGreaterThan(0);
  });

  test("the criterion wired into marcus's role reports what the function found", () => {
    // The unit cases above stay green if COMP-4 stops calling the function.
    const results = evaluateCriteria("marcus", dataFrom([
      edit("/repo/specs/BOOTSTRAP-DATA-FLOW-SPEC.md"), bash("shasum README.md"),
    ]));
    const r = results.find(x => x.id === "COMP-4");
    expect(r, "COMP-4 is not in marcus's criteria").toBeTruthy();
    expect(r!.verdict).toBe("IGNORED");
    expect(r!.evidence).toContain("BOOTSTRAP-DATA-FLOW-SPEC.md");

    const clean = evaluateCriteria("marcus", dataFrom([edit("/repo/specs/HARNESS-STANDARD.md")]));
    expect(clean.find(x => x.id === "COMP-4")!.verdict).toBe("FOLLOWED");
  });

  test("the criterion still carries its weight and source", () => {
    expect(comp4().weight).toBe(10);
    expect(comp4().source).toContain("COMP-4");
  });
});
