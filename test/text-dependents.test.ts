/**
 * #1054 — a file that lifts a region of a source file it does not import.
 *
 * ## The defect, and the premise that did not survive contact with the tree
 *
 * #1054 reports that 23% of one evening's merged PRs needed a second CI
 * round, blames a test-to-source relationship "neither affected-tests nor
 * census-routing can see", and names PR #1034 as the instance: a change to
 * `workflows/ship.js` reddened five files, every one of which slices a
 * marker-delimited region out of `ship.js` and executes it, and the fixing
 * agent's report says *"none has 'container' in its name, so my local grep
 * missed them."*
 *
 * Re-measured at that commit before any of this was written, the stated
 * premise is wrong and its consequence is right. `affectedTests` with
 * `workflows/ship.js` changed selects all five — it has a basename-literal
 * rule and each of the five writes `join(REPO_ROOT, "workflows",
 * "ship.js")`. It selects them inside **226 of 538** test files, with no
 * statement of why any one of them is there. Three answers existed that
 * night: a filename grep (1 file, 1 of 5), `grep -rl container test/` (46
 * files, 5 of 5) and the graph (226 files, 5 of 5). The narrow one missed and
 * the complete ones were unreadable, so the agent grepped.
 *
 * So the gap is attribution, not reach, and the measurement this file is
 * about is the one in `## The corpus` below.
 *
 * ## What is a witness here and what is a control
 *
 *   WITNESS  "a region lift is an edge" — the defect verbatim, in the shape
 *            of #1034: a marker-delimited region, a reader that imports
 *            nothing, and a change inside the markers.
 *   WITNESS  "the reader is named with its anchor and its line span" — the
 *            thing none of the three existing answers produced.
 *   WITNESS  "a helper that lifts is reported, and the tests that import it
 *            are what runs" — `test/helpers/consumer-ship-sites.ts` is not a
 *            test file, so naming it alone is not an answer.
 *   CONTROL  "a change OUTSIDE the lifted region is not a direct hit" — a
 *            router that flags every reader of a file on any change to it is
 *            the 226-file answer again, and the count goes UP under both.
 *   CONTROL  "an unrelated reader is not named" — otherwise the witness is
 *            satisfied by returning everything.
 *   CONTROL  "an anchor that is prose is not an anchor" — the filter that
 *            took the reading from 510 of 538 test files down to a usable
 *            one, and the one that can be wrong in the dangerous direction.
 *   CONTROL  "UNMEASURED is not an empty selection" — a missing target and a
 *            target with no dependents must not produce the same output.
 *   CONTROL  "coverage is reported" — `36/426` and `426/426` are the same
 *            PASS when only the verdict is printed (#492).
 *
 * ## The cheapest wrong fix, named
 *
 * Run the full suite on every PR. The symptom in #1054 disappears completely
 * — no PR ever needs a second round for this reason — and it costs exactly
 * the thing the issue is about. **Every case in this file survives it, and
 * none of them vacuously**, because not one asserts that a run was green or
 * that a PR did not rework. They assert which readers `textDependents`
 * NAMES for a given diff, which is a property of the selection and is
 * unchanged by how many tests someone later decides to run. The second
 * cheapest wrong fix — a row in `.claude/rules/self-referential-tests.md`
 * warning that some tests parse source files — is reached by the same cases
 * for the same reason: prose names nothing, and these cases are about names.
 *
 * ## The corpus
 *
 * #1034 is reproduced by shape here rather than by SHA. Its commits were
 * squash-merged, so `0016547f` is reachable from no ref on `origin` and a
 * case pinned to it would pass on the machine that measured it and fail
 * everywhere else. The real-tree measurement is recorded in the PR body with
 * the commands that produce it; the fixture below carries the same four
 * properties: a marker region, a reader that imports nothing, an anchor that
 * is not the file's basename, and a change inside the markers.
 *
 * ## What was broken to prove it, run and counted
 *
 * Over this file. Each count and the cases it would redden were written down
 * before the battery ran, and the baseline was read first — an instrument
 * that has stopped reporting takes the baseline with it.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 16 pass, 0 fail | **16 pass, 0 fail** | — |
 * | `regexAnchors` returns `[]` — the string-literal-only router | 1 | **1 of 16** | a reader anchoring with `/^const probeTarget = config\.probe \|\| null$/m`: the original names it and the helper's importer, the mutant names no reader at all |
 * | the sibling-name guard in `pairs` dropped, so any two adjacent sites pair | 1 | **1 of 16** | a change on line 11, between one reader's anchors on lines 2 and 16 and inside neither's block: the original leaves it unselected, the mutant makes it a direct hit |
 * | `direct` forced true — every anchor edge selects | 3 | **5 of 16** | a change far outside every lifted region: the original selects 0 readers, the mutant selects all four |
 * | a missing target treated as "no dependents" instead of UNMEASURED | 1 | **1 of 16** | a changed path that is not on disk: the original refuses with it named, the mutant returns MEASURED with an empty list |
 * | the prose filter dropped — length alone decides an anchor | 1 | **1 of 16** | a reader quoting `"the implementation"`, a phrase in the target's comments: the original ignores it, the mutant makes it a dependent |
 *
 * **The second row is the one worth keeping.** Run against the first draft
 * of this file it reddened NOTHING — 0 of 14 — while the real-tree
 * measurement said that same guard was the difference between 39 direct
 * readers and 13 on one diff. A rule carrying a third of the mechanism's
 * precision had no case, and the battery is the only reason that is known.
 * The two cases now paired around it refuse the guard in both directions,
 * so neither "never pair" nor "always pair" is green.
 *
 * None of the five is left in the tree. All were run and reverted, and
 * `lib/text-dependents.ts` was confirmed byte-identical to the measured
 * source afterwards by sha256 (`f723b7ca3b3650bb…`).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  literalRuns,
  regexAnchors,
  stringLiterals,
  textDependents,
  type ChangedFile,
} from "../lib/text-dependents";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function put(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

/**
 * `workflows/subject.js` in the shape of `ship.js`: a marker-delimited
 * region, a tier-gated block, and unrelated code on both sides.
 *
 * The region sits at lines 6 through 10 and the tier block at 13 through 17,
 * counted from 1, which is what the `hunks` in each case point into.
 */
const SUBJECT = [
  "// line 1 — unrelated preamble", // 1
  "function unrelatedHelper() {", // 2
  "  return 'nothing to do with the region'", // 3
  "}", // 4
  "", // 5
  "// ──── PROBE-REGION-START ────", // 6
  "const probeTarget = config.probe || null", // 7
  "function runProbe() { return probeTarget }", // 8
  "// the implementation reads the probe target here", // 9
  "// ──── PROBE-REGION-END ────", // 10
  "", // 11
  "let tierResult = null", // 12
  "if (discovery.tier !== 'LIGHT' && probeTarget) {", // 13
  "  tierResult = runProbe()", // 14
  "} else {", // 15
  "  tierResult = 'SKIPPED'", // 16
  "}", // 17
  "", // 18
  "// line 19 — unrelated epilogue", // 19
  "",
].join("\n");

/**
 * A project with one subject and four readers.
 *
 * None of the readers imports the subject — that is the whole point — and
 * each one is a different way of naming a place in it.
 */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "text-dependents-"));
  made.push(root);

  put(root, "workflows/subject.js", SUBJECT);

  // A marker lift. Names the region and nothing else. #1034's shape.
  put(
    root,
    "test/marker-lift.test.ts",
    'import { readFileSync } from "fs";\n' +
      'const S = readFileSync("workflows/subject.js", "utf-8");\n' +
      'const START = "// ──── PROBE-REGION-START ────";\n' +
      'const END = "// ──── PROBE-REGION-END ────";\n' +
      "export const region = S.slice(S.indexOf(START), S.indexOf(END));\n",
  );

  // A regex lift, which is how most of this repository's lifters are
  // written. A string-literal-only router is blind to it.
  put(
    root,
    "test/helpers/regex-lift.ts",
    'import { readFileSync } from "fs";\n' +
      'const S = readFileSync("workflows/subject.js", "utf-8");\n' +
      "export const decl = /^const probeTarget = config\\.probe \\|\\| null$/m.exec(S);\n",
  );
  put(
    root,
    "test/imports-the-helper.test.ts",
    'import { decl } from "./helpers/regex-lift";\nexport const d = decl;\n',
  );

  // Anchors the tier block, which is OUTSIDE the marker region. The control
  // that stops "flag every reader of the file" from reading as a pass.
  put(
    root,
    "test/tier-block.test.ts",
    'import { readFileSync } from "fs";\n' +
      'const S = readFileSync("workflows/subject.js", "utf-8");\n' +
      "export const at = S.indexOf(\"if (discovery.tier !== 'LIGHT' && probeTarget) {\");\n",
  );

  // Two anchors with nothing in common, far apart, with unrelated code
  // between them. Whether the text between two of a reader's anchors is a
  // region depends on the anchors being siblings; without that, every
  // reader with two anchors claims everything between them.
  put(
    root,
    "test/two-unrelated-anchors.test.ts",
    'import { readFileSync } from "fs";\n' +
      'const S = readFileSync("workflows/subject.js", "utf-8");\n' +
      'export const a = S.indexOf("function unrelatedHelper() {");\n' +
      "export const b = S.indexOf(\"tierResult = 'SKIPPED'\");\n",
  );

  // Quotes a phrase that is in the subject's comments and is not a name.
  put(
    root,
    "test/prose-only.test.ts",
    'export const note = "the implementation";\nexport const other = "nothing to do with";\n',
  );

  return root;
}

/** A change to `workflows/subject.js` touching `lines`, as the caller gives it. */
const touching = (...lines: number[]): ChangedFile[] => [
  { path: "workflows/subject.js", hunks: lines.map(start => ({ start, lines: 1 })) },
];

const readersOf = (r: { edges: { reader: string; direct: boolean }[] }): string[] =>
  [...new Set(r.edges.filter(e => e.direct).map(e => e.reader))].sort();

describe("#1054: a region lift is a dependency the import graph has no edge for", () => {
  // WITNESS. The defect verbatim: the change lands between two markers, and
  // the only file that names them imports nothing.
  test("a change inside the marker region names the marker lifter", () => {
    const root = project();
    const r = textDependents(root, touching(8));

    expect(r.reading, r.unmeasuredReasons.join("; ")).toBe("MEASURED");
    expect(
      readersOf(r),
      "the file that lifts the region the change landed in was not named",
    ).toContain("test/marker-lift.test.ts");
    expect(r.tests).toContain("test/marker-lift.test.ts");
  });

  // WITNESS. The attribution is the product — a path with no reason is what
  // the author already had from `grep`.
  test("the edge carries the anchor and the span that put it there", () => {
    const root = project();
    const r = textDependents(root, touching(8));

    const e = r.edges.find(x => x.reader === "test/marker-lift.test.ts" && x.direct);
    expect(e, `no direct edge: ${JSON.stringify(r.edges.slice(0, 4))}`).toBeDefined();
    expect(e!.target).toBe("workflows/subject.js");
    expect(e!.anchor, "the anchor is not the one the reader actually wrote").toContain(
      "PROBE-REGION",
    );
    expect(e!.scope).toBe("marker-pair");
    expect(e!.from, `span starts at ${e!.from}, the START marker is line 6`).toBe(6);
    expect(e!.to, `span ends at ${e!.to}, the END marker is line 10`).toBe(10);
  });

  // WITNESS. Most lifters in this tree anchor with a regex, and the anchor
  // is a run of literal text inside it.
  test("a regex anchor is an anchor, and a helper that lifts is reported", () => {
    const root = project();
    const r = textDependents(root, touching(7));

    expect(readersOf(r), "a regex-anchored lift was invisible").toContain(
      "test/helpers/regex-lift.ts",
    );
    expect(r.helpers, "the helper was not reported as a non-runnable reader").toContain(
      "test/helpers/regex-lift.ts",
    );
    expect(
      r.tests,
      "a helper is not a test file, so the tests that import it are what runs",
    ).toContain("test/imports-the-helper.test.ts");
    expect(r.tests, "the helper itself was handed to bun test").not.toContain(
      "test/helpers/regex-lift.ts",
    );
  });

  // CONTROL against a router that flags every reader of a changed file. The
  // count goes up under that one too, which is why this case exists.
  test("a change outside the region does not name the region's lifter", () => {
    const root = project();
    const r = textDependents(root, touching(14));

    expect(r.reading).toBe("MEASURED");
    expect(
      readersOf(r),
      "a change in the tier block was attributed to the marker region",
    ).not.toContain("test/marker-lift.test.ts");
    expect(readersOf(r), "the reader that anchors the tier block was missed").toContain(
      "test/tier-block.test.ts",
    );
    expect(r.tests).not.toContain("test/marker-lift.test.ts");
  });

  // CONTROL. A change in neither region selects neither reader. Without
  // this, "names the right one" is satisfied by naming both every time.
  test("a change in neither region selects no reader at all", () => {
    const root = project();
    const r = textDependents(root, touching(19));

    expect(r.reading, "an empty result was dressed up as a refusal").toBe("MEASURED");
    expect(readersOf(r), "an unrelated edit selected a lifter").toEqual([]);
    expect(r.tests).toEqual([]);
  });

  // CONTROL for the pairing rule, which is what keeps a region a region.
  // Line 11 lies between this reader's two anchors — line 2 and line 16 —
  // and inside neither of their blocks. A router that pairs any two
  // adjacent sites hands that reader everything in between, which on the
  // real tree was a `ship.js` 497-7000 "region" and three times the direct
  // readers.
  test("two anchors that are not siblings do not make the text between them a region", () => {
    const root = project();
    const r = textDependents(root, touching(11));

    expect(
      readersOf(r),
      "the gap between two unrelated anchors was treated as a lifted region",
    ).not.toContain("test/two-unrelated-anchors.test.ts");
    expect(r.tests).toEqual([]);
  });

  // The other half of the same rule: siblings DO pair, and the paired span
  // is what a change between the markers lands in. Without this, the guard
  // above could be satisfied by never pairing anything.
  test("two sibling anchors do make the text between them a region", () => {
    const root = project();
    const e = textDependents(root, touching(8)).edges.find(
      x => x.reader === "test/marker-lift.test.ts" && x.direct,
    );

    expect(e, "a START/END pair stopped delimiting anything").toBeDefined();
    expect(e!.scope).toBe("marker-pair");
    expect(e!.to - e!.from, "the pair span collapsed to one line").toBeGreaterThan(0);
  });

  // CONTROL for the filter that can be wrong in the dangerous direction.
  test("a prose phrase present in the subject is not an anchor", () => {
    const root = project();
    const r = textDependents(root, touching(9));

    expect(
      r.edges.some(e => e.reader === "test/prose-only.test.ts"),
      '"the implementation" is a phrase in the subject and was treated as a name',
    ).toBe(false);
  });
});

describe("#1054: UNMEASURED is a refusal, not an empty selection", () => {
  test("a changed path that is not on disk refuses, and names itself", () => {
    const root = project();
    const r = textDependents(root, [{ path: "workflows/deleted.js", hunks: [] }]);

    expect(r.reading, "a file nobody could read came back as a file with no dependents").toBe(
      "UNMEASURED",
    );
    expect(r.unmeasuredReasons.join(" ")).toContain("workflows/deleted.js");
    expect(r.tests, "an unmeasured reading still produced a selection").toEqual([]);
  });

  test("an empty change set refuses rather than returning nothing", () => {
    const r = textDependents(project(), []);
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons[0]).toContain("no changed files");
  });

  // A caller with no line numbers cannot narrow, so nothing is narrowed.
  // The alternative — an empty set — is the `0`-reads-as-success shape in
  // the one position where it costs a red `main`.
  test("a change with no hunks selects every anchor, not none", () => {
    const root = project();
    const r = textDependents(root, [{ path: "workflows/subject.js" }]);

    expect(r.reading).toBe("MEASURED");
    expect(readersOf(r).length, "unknown line numbers resolved to an empty selection").toBeGreaterThan(
      1,
    );
    expect(readersOf(r)).toContain("test/marker-lift.test.ts");
    expect(readersOf(r)).toContain("test/tier-block.test.ts");
  });

  // #492: a scan that read 36 of 426 files and one that read all of them
  // return the same verdict unless the denominator is printed.
  test("the reading states how many candidate readers it read of how many it saw", () => {
    const root = project();
    const r = textDependents(root, touching(8));

    expect(r.filesSeen, "the walk saw nothing and still reported a result").toBeGreaterThan(0);
    expect(r.filesRead, "coverage was not reported").toBe(r.filesSeen);
    expect(r.unreadable).toEqual([]);
  });

  // The declared scope boundary, stated by name rather than by silence.
  test("a target outside the router's scope is listed, not silently dropped", () => {
    const root = project();
    put(root, "specs/X.md", "# a spec\n");
    const r = textDependents(root, [
      { path: "workflows/subject.js", hunks: [{ start: 8, lines: 1 }] },
      { path: "specs/X.md", hunks: [{ start: 1, lines: 1 }] },
    ]);

    expect(r.reading).toBe("MEASURED");
    expect(r.notAnchorable, "a declined target vanished from the report").toEqual(["specs/X.md"]);
  });
});

describe("#1054: the anchor extractors", () => {
  test("a template that interpolates is not a literal, and one that does not is", () => {
    expect(stringLiterals("const a = `a plain template`")).toContain("a plain template");
    expect(stringLiterals("const a = `a ${x} template`")).toEqual([]);
  });

  test("a regex body yields its literal runs, with the escapes unescaped", () => {
    expect(literalRuns("^const containerConfig = projectConfig\\.container$")).toContain(
      "const containerConfig = projectConfig.container",
    );
    // A class escape ends a run — `\s` is not the letter s.
    expect(literalRuns("abcdefgh\\sijklmnop")).toEqual(["abcdefgh", "ijklmnop"]);
  });

  test("a division is not a regex", () => {
    expect(regexAnchors("const r = total / countOfThings / 2")).toEqual([]);
  });
});
