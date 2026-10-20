/**
 * Covers SC-2440, SC-2441, SC-2442, SC-2443, SC-2444, SC-2445
 * (HARNESS-STANDARD.md).
 *
 * A ship run spent 6,854 seconds and 1,580,869 subagent tokens across 24
 * agents, every one of them succeeding, and collected nothing. One agent
 * reported one path with a leading slash.
 *
 * `pathRefusal` was right to refuse it and is NOT loosened here. Stripping a
 * leading slash would turn `/etc/passwd` into a contributable `etc/passwd`,
 * and that is performed below rather than argued: `AC-3 / the stripped form
 * is ACCEPTED` runs both halves and watches the second one through.
 *
 * The defect is WHEN the question is asked. Reported paths met
 * `CONTRIBUTABLE_PATH_RULES` only at collection, after every agent had
 * finished, so a mistake the agent could have corrected in one second voided
 * the whole run's collection. Report-time validation already existed —
 * `filesChangedShapeRefusal`, #611 — and it applies `FILES_CHANGED_SHAPE_RULES`
 * (is this a path-like string) and not `CONTRIBUTABLE_PATH_RULES` (may this
 * path be contributed). Both guards were already at both points in time; one
 * simply did not ask the contributability question.
 *
 * ## Why this is not a second copy of `pathRefusal`
 *
 * It is not a copy at all. `reportedPathRefusal` CALLS `pathRefusal` — the
 * same table staging and the claim audit ask — so there is one decider for
 * contributability asked at two phases, not two deciders that agree
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape). What would
 * be a second decider is a report-time regex spelling `startsWith('/')` by
 * hand, and `AC-1 / every rule in the table is reachable at report time`
 * refuses that by reading the table's own rows and demanding each one be
 * reachable by name.
 *
 * It is also not a second copy of `filesChangedShapeRefusal`, and the two
 * have disjoint domains asserted below by name:
 *
 *   - only the shape guard: `lib/a.ts (modified)` — an annotation. Refused
 *     under #611's sentence, and `reportedPathRefusal` stays silent about it,
 *     or the operator gets "git add refuses the path" back, which is the
 *     sentence that cost #611 103 minutes.
 *   - only this one:        `/etc/passwd` — one token, shaped exactly like a
 *     path, and not contributable.
 *
 * ## The cheapest wrong fix, and whether these cases survive it
 *
 * The 5pm repair for "the run died on a leading slash" is **strip the leading
 * slash and retry** — somewhere upstream, and carry on. Two of the three
 * shapes of case here survive it and one does not, which is worth saying
 * precisely rather than claiming blanket protection:
 *
 *   - a direct call on `reportedPathRefusal("/etc/passwd")` survives it
 *     VACUOUSLY: a strip upstream of the guard leaves the guard refusing, and
 *     the case never changes verdict. It is not protection.
 *   - `AC-3 / the real decomposed run refuses it` survives it REALLY: the
 *     element goes in as the agent reported it, so a strip anywhere between
 *     the agent reply and the guard makes the run succeed and the case red.
 *   - `AC-3 / the claim audit refuses it, and does not normalise it away`
 *     survives it REALLY too, from the collection side: it asserts the
 *     violation still carries the leading slash.
 *
 * ## What was broken to prove it
 *
 * Recorded in `specs/HARNESS-STANDARD.md` beside SC-2440..SC-2445, and read
 * back as DATA by `AC-5` below rather than trusted as prose.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria (SC-2440..SC-2445)

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { structuralCut } from "../lib/source-slice";

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
const shipSource = readFileSync(SHIP_PATH, "utf-8");

/** Slice a marked block out of an arbitrary ship.js source. */
function blockOf(src: string, name: string): string {
  const start = src.indexOf(`// ──── ${name}-START ────`);
  const end = src.indexOf(`// ──── ${name}-END ────`);
  if (start < 0 || end < 0) throw new Error(`${name} markers not found`);
  const slice = src.slice(start, end);
  // A slice that failed to find its own section is an empty string, and an
  // empty string contains nothing — which is indistinguishable from a clean
  // result (checks-must-be-able-to-fail.md, "search the slice").
  if (slice.trim().length === 0) throw new Error(`${name} block is empty`);
  return slice;
}

const block = (name: string) => blockOf(shipSource, name);

type Refusal = (r: unknown, label: string) => string | null;
type PathRefusal = (p: string) => { rule: string; boundary: boolean } | null;
type RuleRow = [string, boolean, (p: string) => boolean];

/**
 * The report-time guards, over the REAL shared path table.
 *
 * SECURITY-HELPERS is prepended because `reportedPathRefusal` reaches into it
 * for `pathRefusal`. That is the structural evidence that the report-time
 * check really asks the collection-time table rather than keeping a second
 * copy of two of its rows — loading FILES-CHANGED-SHAPE alone throws, and
 * `AC-6` asserts exactly that.
 */
function loadReportGuards(): {
  reportedPathRefusal: Refusal;
  filesChangedShapeRefusal: Refusal;
  pathRefusal: PathRefusal;
  CONTRIBUTABLE_PATH_RULES: RuleRow[];
} {
  return new Function(
    "PROJECT_ROOT",
    "log",
    `${block("SECURITY-HELPERS")}\n${block("FILES-CHANGED-SHAPE")}\n` +
      `return { reportedPathRefusal, filesChangedShapeRefusal, pathRefusal, CONTRIBUTABLE_PATH_RULES }`,
  )("/repo", () => {}) as never;
}

const { reportedPathRefusal, filesChangedShapeRefusal, pathRefusal, CONTRIBUTABLE_PATH_RULES } =
  loadReportGuards();

/** The real claim audit, with the real shared path table beneath it. */
function loadClaimAudit(src: string = shipSource): (r: unknown) => {
  violations: Array<{ worktreePath: string; path: string; detail: string }>;
  candidates: Array<{ worktreePath: string; filesChanged: string[] }>;
} {
  return new Function(
    "PROJECT_ROOT",
    "log",
    `${blockOf(src, "SECURITY-HELPERS")}\n${blockOf(src, "COLLECT-CLAIM")}\nreturn auditWorktreeClaims`,
  )("/repo", () => {}) as never;
}

const auditWorktreeClaims = loadClaimAudit();

/** The element measured on the dead run, as the agent reported it. */
const MEASURED = "/.github/workflows/ai-review.yml";
/** The path that element would have been, relative to the worktree root. */
const MEASURED_RELATIVE = ".github/workflows/ai-review.yml";

/** The three paths AC-3 names, with the form a strip would produce. */
const AC3: Array<{ reported: string; stripped: string | null }> = [
  { reported: "/etc/passwd", stripped: "etc/passwd" },
  { reported: MEASURED, stripped: MEASURED_RELATIVE },
  { reported: "../x", stripped: null },
];

/**
 * One input per row of `CONTRIBUTABLE_PATH_RULES`, keyed by the rule it must
 * be refused UNDER. Read against the table rather than beside it, so a row
 * added to the table with no fixture here turns `AC-1` red instead of
 * silently going unchecked at report time.
 */
const RULE_FIXTURES: Record<string, string> = {
  "an absolute path": "/etc/passwd",
  "a `..` segment": "../x",
  "a segment ending in `..`": "lib/foo..",
  "a shell metacharacter": "lib/a;rm.ts",
  "a null byte": "lib/a\u0000.ts",
  "over 500 characters": `lib/${"b".repeat(520)}.ts`,
};

const ok = (filesChanged: unknown[]) => ({ success: true, filesChanged, taskSource: "brief" });

// ── AC-1 ─────────────────────────────────────────────────────
// SC-2440: the contributability question, asked at the phase that READ it.

describe("AC-1 / SC-2440: every reported element is measured against CONTRIBUTABLE_PATH_RULES at report time", () => {
  test("the guard has exactly one definition, so there is one binding to mutate", () => {
    expect(shipSource.match(/function reportedPathRefusal\b/g) ?? []).toHaveLength(1);
    expect(typeof reportedPathRefusal).toBe("function");
  });

  test("the measured element is refused", () => {
    expect(reportedPathRefusal(ok([MEASURED]), "marcus")).not.toBeNull();
  });

  test("an ordinary list is NOT refused", () => {
    // The positive control. A guard that refuses every implement result
    // satisfies the case above and breaks the pipeline entirely.
    expect(
      reportedPathRefusal(ok(["lib/a.ts", "test/a.test.ts", "docs/adr/ADR-001.md"]), "marcus"),
    ).toBeNull();
  });

  test("an element at any index is checked, not just the first", () => {
    // "Every element" is the claim. A loop reading `filesChanged[0]` and
    // stopping satisfies the measured case above and misses the dead run,
    // where the absolute path was not first.
    const refusal = reportedPathRefusal(ok(["lib/a.ts", "test/a.test.ts", MEASURED]), "marcus");
    expect(refusal, "a trailing absolute element was accepted").not.toBeNull();
    expect(refusal).toContain("filesChanged[2]");
  });

  test("the label identifies WHICH agent, so a sub-issue is distinguishable", () => {
    expect(reportedPathRefusal(ok([MEASURED]), "marcus-sub-830001"))
      .toContain("marcus-sub-830001");
  });

  test("every rule in the table is reachable at report time, and named", () => {
    // Read off the table itself. A report-time check that spelled
    // `startsWith('/')` by hand would be a second decider for the one
    // question, and it would pass the measured case above while the other
    // five rows went unasked.
    const tableRules = CONTRIBUTABLE_PATH_RULES.map(r => r[0]);
    expect(tableRules.length, "the table came back empty").toBeGreaterThan(0);
    expect(
      tableRules.filter(r => !(r in RULE_FIXTURES)),
      "a rule was added to CONTRIBUTABLE_PATH_RULES with no report-time fixture here",
    ).toEqual([]);
    for (const rule of tableRules) {
      const refusal = reportedPathRefusal(ok([RULE_FIXTURES[rule]!]), "marcus");
      expect(refusal, `${rule} was accepted at report time`).not.toBeNull();
      expect(refusal, `${rule} was refused under the wrong rule`).toContain(rule);
    }
  });

  test("an already-failed result is left to its own handler", () => {
    // One question per guard. A `success: false` result is refused by the
    // caller's own branch with its own findings, and reporting it twice
    // under a different reason misattributes the failure.
    expect(reportedPathRefusal({ success: false, filesChanged: [MEASURED] }, "marcus")).toBeNull();
  });

  test("an empty or absent list is left to implementRefusal", () => {
    // Also one question per guard, from the other side: "changed no files"
    // is #181's refusal and it carries #181's explanation.
    expect(reportedPathRefusal(ok([]), "marcus")).toBeNull();
    expect(reportedPathRefusal({ success: true }, "marcus")).toBeNull();
    expect(reportedPathRefusal({ success: true, filesChanged: "lib/a.ts" }, "marcus")).toBeNull();
  });

  test("an annotated element is left to the shape guard, which owns that sentence", () => {
    // The input only #611 reaches. `lib/a.ts (modified)` carries `(` and
    // `)`, so `pathRefusal` refuses it too — and answering here would hand
    // the operator "cannot be staged" about a string that is not a path at
    // all, which is the sentence #611 exists to stop printing.
    const annotated = "lib/a.ts (modified)";
    expect(pathRefusal(annotated), "the premise moved: the path table now accepts it").not.toBeNull();
    expect(filesChangedShapeRefusal(ok([annotated]), "marcus")).not.toBeNull();
    expect(reportedPathRefusal(ok([annotated]), "marcus")).toBeNull();
  });

  test("an input ONLY this guard reaches: a bare absolute path", () => {
    // The other half of the pair, so neither can be deleted silently.
    expect(filesChangedShapeRefusal(ok([MEASURED]), "marcus")).toBeNull();
    expect(reportedPathRefusal(ok([MEASURED]), "marcus")).not.toBeNull();
  });

  test("both implement paths consult the guard, per sub-issue and before the union", () => {
    const body = structuralCut(shipSource, "async function runImplement()", { balanced: "{" });
    expect(body, "runImplement does not call the contributability guard")
      .toContain("reportedPathRefusal(buildResult, 'marcus')");

    const dec = block("DECOMPOSED-SHIP");
    expect(dec, "the decomposed path never calls the contributability guard")
      .toContain("reportedPathRefusal(buildResult, `marcus-sub-${subIssue.number}`)");
    // Before the union: `allFilesChanged` flattens every sub-issue's list
    // together, so one sub-issue's absolute element is invisible the moment
    // the lists are merged — #181 AC-3's trap, same place.
    expect(dec.indexOf("reportedPathRefusal("))
      .toBeLessThan(dec.indexOf("const allFilesChanged"));
  });

  test("the guard runs at the implement read, not at the collector", () => {
    expect(shipSource.indexOf("// ──── FILES-CHANGED-SHAPE-START ────"))
      .toBeLessThan(shipSource.indexOf("function auditWorktreeClaims"));
  });
});

// ── AC-2 ─────────────────────────────────────────────────────
// SC-2441: two sentences, split exactly where the table's own column splits.

describe("AC-2 / SC-2441: a boundary rule and a non-boundary rule get different sentences", () => {
  const BOUNDARY_SENTENCE = "does not name a location inside your worktree";
  const INSIDE_SENTENCE = "is inside your worktree and still cannot be staged";

  test("the split follows the table's boundary column, row by row", () => {
    // Not two sentences chosen by hand: the column is read, and each row's
    // fixture is asserted against the sentence that column selects. A guard
    // that printed one sentence for everything satisfies every other case
    // in this file.
    for (const [rule, boundary] of CONTRIBUTABLE_PATH_RULES) {
      const refusal = reportedPathRefusal(ok([RULE_FIXTURES[rule]!]), "marcus")!;
      expect(refusal, `${rule} produced no refusal`).not.toBeNull();
      expect(refusal, `${rule} (boundary=${boundary}) got the wrong sentence`)
        .toContain(boundary ? BOUNDARY_SENTENCE : INSIDE_SENTENCE);
      expect(refusal, `${rule} (boundary=${boundary}) got BOTH sentences`)
        .not.toContain(boundary ? INSIDE_SENTENCE : BOUNDARY_SENTENCE);
    }
  });

  test("both sentences are actually produced by this tree's table", () => {
    // The vacuity guard for the loop above. A table whose rows were all
    // boundary=true would satisfy it while half the behaviour went unseen.
    const boundaries = new Set(CONTRIBUTABLE_PATH_RULES.map(r => r[1]));
    expect([...boundaries].sort()).toEqual([false, true]);
  });

  test("a leading-slash path quotes the worktree-relative path it should have been", () => {
    const refusal = reportedPathRefusal(ok([MEASURED]), "marcus")!;
    expect(refusal, "the refusal said only that it is absolute").toContain(
      JSON.stringify(MEASURED_RELATIVE),
    );
    expect(refusal).toContain("an absolute path");
  });

  test("the quoted path is a suggestion, not a repair", () => {
    // #114: a sanitised path is a path the agent did not report. The
    // sentence names the relative form AND the element is still refused,
    // and the refusal says the slash is not dropped on the agent's behalf.
    const refusal = reportedPathRefusal(ok(["/etc/passwd"]), "marcus")!;
    expect(refusal).toContain(JSON.stringify("etc/passwd"));
    expect(refusal.toLowerCase()).toMatch(/nothing is stripped|not stripped/);
  });

  test("a path from which no relative form can be recovered says so", () => {
    // SC-2047's lesson, same shape: an empty quote spliced into the
    // sentence reads as a truncated report.
    const refusal = reportedPathRefusal(ok(["../x"]), "marcus")!;
    expect(refusal).toContain("a `..` segment");
    expect(refusal, "an empty quotation was spliced into the sentence").not.toContain('""');
  });

  test("it does not borrow the collection-time sentence", () => {
    // The two phases print different sentences on purpose: an operator who
    // reads "git add refuses the path" at the implement read goes looking
    // for a quoting bug in the stager, which is #611's cost exactly.
    const refusal = reportedPathRefusal(ok([MEASURED]), "marcus")!;
    expect(refusal).not.toContain("git add refuses the path");
    expect(refusal).not.toContain("a worktree may only contribute files");
  });
});

// ── AC-3 ─────────────────────────────────────────────────────
// SC-2442: refused at report time and again at collection time.

describe("AC-3 / SC-2442: refused at report time and again at collection time", () => {
  for (const { reported, stripped } of AC3) {
    test(`${reported} is refused at report time`, () => {
      expect(reportedPathRefusal(ok([reported]), "marcus")).not.toBeNull();
    });

    test(`${reported} is refused by the claim audit, and not normalised away`, () => {
      const audit = auditWorktreeClaims([
        { worktreePath: "/wt/a", filesChanged: [reported], claimedFiles: [reported] },
        { worktreePath: "/wt/b", filesChanged: ["lib/b.ts"], claimedFiles: ["lib/b.ts"] },
      ]);
      const hit = audit.violations.filter(v => v.worktreePath === "/wt/a");
      expect(hit, "the collection-time check did not refuse it").toHaveLength(1);
      // The normalisation question, asked of the thing that normalises:
      // `claimKey` must hand `pathRefusal` the path as reported.
      expect(hit[0]!.path, "the audit normalised the path before refusing it").toBe(reported);
      expect(
        audit.candidates.filter(c => c.worktreePath === "/wt/a"),
        "a refused path was still offered to the collector",
      ).toHaveLength(0);
      if (stripped) {
        expect(
          JSON.stringify(audit.candidates),
          "the stripped form reached the collector",
        ).not.toContain(stripped);
      }
    });
  }

  test("the real decomposed run refuses it, and forwards nothing", async () => {
    // The case that does NOT survive "strip the leading slash and retry":
    // the element enters as the agent reported it, so a strip anywhere
    // between the reply and the guard turns this green run red.
    for (const { reported } of AC3) {
      const { run, logs } = loadRunDecomposedShip(async (p: string) => ({
        success: true,
        worktreePath: "/wt/a",
        worktreeRepo: "git@github.com:owner/project.git",
        taskSource: "brief",
        filesChanged: p.includes("beta") ? [reported] : ["lib/alpha.ts"],
        testOutput: "2 pass",
      }));
      const result: any = await run(SUBS);
      expect(result.success, `${reported} shipped anyway`).toBe(false);
      expect(logs.join("\n")).toMatch(/Sub-issue FAILED: beta/);
      const forwarded: string[] = Array.isArray(result?.buildResult?.filesChanged)
        ? result.buildResult.filesChanged
        : [];
      expect(forwarded, `${reported} reached the collection audit`).not.toContain(reported);
    }
  });

  test("the stripped form is ACCEPTED, which is why nothing strips it", () => {
    // The wrong fix, performed rather than described. Both halves run:
    // the reported form is refused at both phases, and the form a strip
    // would produce sails through both. `/etc/passwd` becoming a
    // contributable `etc/passwd` is not a hypothetical about the repair —
    // it is this assertion.
    for (const { reported, stripped } of AC3) {
      if (!stripped) continue;
      expect(reportedPathRefusal(ok([reported]), "marcus"), reported).not.toBeNull();
      expect(reportedPathRefusal(ok([stripped]), "marcus"), stripped).toBeNull();
      expect(pathRefusal(stripped), `${stripped} is refused — the premise moved`).toBeNull();
    }
  });

  test("a batch where every element is a bare relative path still ships", async () => {
    // The positive control for the run, not just for the predicate.
    const { run } = loadRunDecomposedShip(async (_p: string, o: { label: string }) => ({
      success: true,
      worktreePath: "/wt/a",
      worktreeRepo: "git@github.com:owner/project.git",
      taskSource: "brief",
      filesChanged: [`lib/${o.label}.ts`],
      testOutput: "2 pass",
    }));
    const result: any = await run(SUBS);
    expect(result.success).toBe(true);
    expect(result.buildResult.filesChanged).toHaveLength(2);
  });
});

// ── AC-4 ─────────────────────────────────────────────────────
// SC-2443: an addition, not a replacement.

/** The one binding the mutation removes. */
const GUARD_ANCHOR = "function reportedPathRefusal(buildResult, label) {";

/**
 * The pre-#830 source, rebuilt: the guard still exists, is still called from
 * both paths, and answers null for every result — which is exactly what a
 * pipeline that asks the contributability question only at collection does.
 */
export function buildReportCheckRemovalMutant(src: string = shipSource): string {
  const hits = src.split(GUARD_ANCHOR).length - 1;
  if (hits !== 1) {
    throw new Error(
      `could not build the mutant: the guard anchor appears ${hits} times in workflows/ship.js, ` +
        `expected exactly 1. Either it was renamed, or a second copy exists and short-circuiting ` +
        `one would leave the other refusing.`,
    );
  }
  const out = src.replace(
    GUARD_ANCHOR,
    `${GUARD_ANCHOR}\n  return null // MUTANT: #830's report-time check removed`,
  );
  if (out === src) throw new Error("could not build the mutant: the replacement changed nothing");
  return out;
}

describe("AC-4 / SC-2443: the collection-time check still refuses when the report-time check is short-circuited", () => {
  const mutantSource = buildReportCheckRemovalMutant();

  test("the builder ABORTS when the guard is renamed", () => {
    const renamed = shipSource.replace(GUARD_ANCHOR, "function reportedRefusal(buildResult, label) {");
    expect(renamed).not.toBe(shipSource);
    expect(() => buildReportCheckRemovalMutant(renamed)).toThrow(/could not build the mutant/);
  });

  test("mutant and original differ on a NAMED input, run rather than argued", () => {
    // Before believing anything below. A fixture both sources handle
    // identically is not a mutation, it is the code run twice (#485, #297).
    const guardOf = (src: string): Refusal =>
      new Function(
        "PROJECT_ROOT",
        "log",
        `${blockOf(src, "SECURITY-HELPERS")}\n${blockOf(src, "FILES-CHANGED-SHAPE")}\nreturn reportedPathRefusal`,
      )("/repo", () => {}) as never;
    const before = guardOf(shipSource)(ok([MEASURED]), "marcus");
    const after = guardOf(mutantSource)(ok([MEASURED]), "marcus");
    expect(typeof before, "the real guard did not refuse the measured element").toBe("string");
    expect(after, "the mutant still refuses it — the mutation was not applied").toBeNull();
  });

  test("the mutant forwards the absolute path, and the REAL audit refuses it", async () => {
    const forwarded = await forwardedUnder(mutantSource, MEASURED);
    expect(forwarded, "the mutant did not forward the absolute element").toContain(MEASURED);

    const violations = auditWorktreeClaims([
      { worktreePath: "/wt/a", filesChanged: forwarded, claimedFiles: forwarded },
      { worktreePath: "/wt/b", filesChanged: ["lib/b.ts"], claimedFiles: ["lib/b.ts"] },
    ]).violations.filter(v => v.path === MEASURED);
    expect(violations.length, "the pre-#830 failure did not reproduce").toBe(1);
    expect(violations[0]!.detail).toContain("an absolute path");
  });

  test("the real source forwards nothing absolute, so the audit has nothing to refuse", async () => {
    // The baseline beside the row above: without it, "the audit refused it"
    // is satisfied by an audit that refuses everything.
    const forwarded = await forwardedUnder(shipSource, MEASURED);
    expect(forwarded).not.toContain(MEASURED);
    expect(auditWorktreeClaims([
      { worktreePath: "/wt/a", filesChanged: forwarded, claimedFiles: forwarded },
    ]).violations).toHaveLength(0);
  });
});

// ── AC-5 ─────────────────────────────────────────────────────
// SC-2444: the battery record, read back as data.

describe("AC-5 / SC-2444: the mutation battery record names a differing input beside every row", () => {
  const RECORD_FILE = "specs/HARNESS-STANDARD.md";
  const HEADING = "#### What was broken to prove it (SC-2440..SC-2445)";

  /** The record section, refused rather than returned empty. */
  function recordSection(): string {
    const doc = readFileSync(join(REPO_ROOT, RECORD_FILE), "utf-8");
    const from = doc.indexOf(HEADING);
    if (from < 0) {
      throw new Error(
        `${RECORD_FILE} no longer carries ${JSON.stringify(HEADING)} — a measurement dropped ` +
          `from a record file is silent everywhere else`,
      );
    }
    const rest = doc.slice(from + HEADING.length);
    const end = rest.search(/\n#{1,4} /);
    const cut = HEADING + (end < 0 ? rest : rest.slice(0, end));
    if (cut.trim().length === HEADING.trim().length) {
      throw new Error(`${JSON.stringify(HEADING)} carries no body`);
    }
    return cut;
  }

  /** Body rows of the markdown table in `section`, as cell arrays. */
  function tableRows(section: string): string[][] {
    const rows: string[][] = [];
    for (const line of section.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("|") || !t.endsWith("|")) continue;
      const cells = t.slice(1, -1).split("|").map(c => c.trim());
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;
      rows.push(cells);
    }
    if (rows.length === 0) throw new Error("the record section carries no table rows");
    return rows;
  }

  test("the parser fires on a planted table and refuses one with no rows", () => {
    // Without this, narrowing the row matcher to something unmatchable buys
    // a green file: every assertion below is quantified over rows, and
    // there would be none.
    expect(tableRows("| a | b |\n|---|---|\n| 1 | 2 |\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(() => tableRows("no table here at all\n")).toThrow(/no table rows/);
  });

  test("the record exists and is a table of at least a baseline and a mutation", () => {
    const rows = tableRows(recordSection());
    expect(rows.length, "a record with no mutation row beside its header").toBeGreaterThan(2);
  });

  test("the BASELINE row is stated before any mutation row", () => {
    // `.claude/rules/checks-must-be-able-to-fail.md`: an instrument that
    // stopped reporting takes the baseline down with it, and that is the
    // row nobody mutates anything to produce.
    const rows = tableRows(recordSection());
    const baselineAt = rows.findIndex(r => r[0]!.toLowerCase().includes("baseline"));
    expect(baselineAt, "the record carries no baseline row").toBeGreaterThan(-1);
    expect(baselineAt, "a mutation row is recorded above the baseline").toBe(1);
  });

  test("every mutation row names an input on which mutant and original differ", () => {
    const rows = tableRows(recordSection());
    const header = rows[0]!;
    const inputColumn = header.findIndex(c => c.toLowerCase().includes("differ"));
    expect(inputColumn, "the table has no differing-input column").toBeGreaterThan(-1);
    const body = rows.slice(1);
    expect(body.length).toBeGreaterThan(1);
    for (const row of body) {
      expect(row.length, `a row with ${row.length} cells against ${header.length} headers`)
        .toBe(header.length);
      const cell = row[inputColumn] ?? "";
      if (row[0]!.toLowerCase().includes("baseline")) {
        // A baseline is not a mutation and has no differing input; it says
        // so with a dash rather than being allowed to be blank, because a
        // blank cell and an unwritten one are the same bytes.
        expect(cell, "the baseline's input cell is blank").not.toBe("");
        continue;
      }
      expect(cell.length, `the row "${row[0]}" names no differing input`).toBeGreaterThan(20);
    }
  });

  test("the cheapest wrong fix is named, and so is the case that refuses it", () => {
    const section = recordSection();
    expect(section, "the record does not name the cheapest wrong fix")
      .toContain("strip the leading slash and retry");
    expect(section, "the record does not say which case refuses it")
      .toContain("/etc/passwd");
  });
});

// ── AC-6 ─────────────────────────────────────────────────────
// SC-2445: the loaders that build the block in isolation.

describe("AC-6 / SC-2445: the shape block alone throws ReferenceError until SECURITY-HELPERS is prepended", () => {
  const SUITES = [
    "test/files-changed-path-shape.test.ts",
    "test/files-changed-shape-mutation.test.ts",
  ];

  test("the block alone cannot answer the contributability question", () => {
    // The reason the two suites had to change, performed. This is also the
    // structural proof that `reportedPathRefusal` reaches the shared table
    // rather than carrying a second copy of two of its rows: a guard with
    // its own regexes would answer here without complaint.
    const alone = new Function(
      `${block("FILES-CHANGED-SHAPE")}\nreturn reportedPathRefusal`,
    )() as Refusal;
    expect(() => alone(ok([MEASURED]), "marcus")).toThrow(ReferenceError);
  });

  test("the same block with SECURITY-HELPERS beneath it answers", () => {
    expect(reportedPathRefusal(ok([MEASURED]), "marcus")).not.toBeNull();
  });

  test("every loader in both suites that executes the block prepends SECURITY-HELPERS", () => {
    for (const suite of SUITES) {
      const src = readFileSync(join(REPO_ROOT, suite), "utf-8");
      const bodies = [...src.matchAll(/new Function\(([\s\S]*?)\n\s*\)/g)].map(m => m[1]!);
      expect(bodies.length, `${suite} builds nothing with new Function`).toBeGreaterThan(0);
      const shapeLoaders = bodies.filter(b => b.includes("FILES-CHANGED-SHAPE"));
      expect(shapeLoaders.length, `${suite} no longer loads FILES-CHANGED-SHAPE`)
        .toBeGreaterThan(0);
      for (const body of shapeLoaders) {
        expect(body, `${suite} loads FILES-CHANGED-SHAPE without SECURITY-HELPERS`)
          .toContain("SECURITY-HELPERS");
        expect(
          body.indexOf("SECURITY-HELPERS"),
          `${suite} loads SECURITY-HELPERS after the block that needs it`,
        ).toBeLessThan(body.indexOf("FILES-CHANGED-SHAPE"));
      }
    }
  });
});

// ── the decomposed-ship harness ──────────────────────────────
// Modelled on test/files-changed-path-shape.test.ts, which runs the real
// block rather than grepping it: grepping proves the guard is called, not
// that its answer changes anything.

const SUBS = [
  { number: 1, title: "alpha", acs: ["a1"], filesToModify: ["lib/alpha.ts"], size: "S" },
  { number: 2, title: "beta", acs: ["b1"], filesToModify: ["lib/beta.ts"], size: "S" },
];

function loadRunDecomposedShip(
  agent: (p: string, o: { label: string }) => Promise<unknown>,
  src: string = shipSource,
) {
  const marked = (name: string) => blockOf(src, name);
  const logs: string[] = [];
  // The shape block is EVALUATED INTO the decomposed block's scope rather
  // than injected as a parameter, and SECURITY-HELPERS beneath it for the
  // same reason: a stub would let this suite and the real block disagree
  // about what a contributable path is, and nothing would notice.
  const factory = new Function(
    "log", "briefedAgent", "parallel", "WORK_DIR", "ISSUE", "PROJECT_ROOT",
    "BUILD_RESULT_SCHEMA", "runImplement", "implementRefusal",
    "worktreeIdentity", "REPO", "taskSourceRefusal",
    "establishRunRef", "integrateWave", "waveNeedsIntegration",
    "measureLaunchBase",
    `${marked("SECURITY-HELPERS")}\n${marked("FILES-CHANGED-SHAPE")}\n` +
      `${marked("DECOMPOSED-SHIP")}\nreturn runDecomposedShip;`,
  );
  const run = factory(
    (m: string) => logs.push(String(m)),
    agent,
    (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map(t => t())),
    "/tmp/work", 830, REPO_ROOT, {},
    async () => ({ success: true, buildResult: {} }),
    new Function(`${marked("IMPLEMENT-RESULT")}\nreturn implementRefusal;`)(),
    new Function(`${marked("WORKTREE-IDENTITY")}\nreturn worktreeIdentity;`)(),
    "owner/project",
    new Function(`${marked("BRIEF-PRECEDENCE")}\nreturn taskSourceRefusal;`)(),
    async () => ({ branch: "rungate/run-830", refusal: null }),
    async () => ({ ok: true, integrated: 0 }),
    new Function(`${marked("RUN-REF")}\nreturn waveNeedsIntegration;`)(),
    async () => ({ reading: "SAME_CHECKOUT", refusal: null }),
  );
  return { run, logs };
}

/** What a run over `src` forwards when one sub-issue reports `reported`. */
async function forwardedUnder(src: string, reported: string): Promise<string[]> {
  const { run } = loadRunDecomposedShip(async (p: string) => ({
    success: true,
    worktreePath: "/wt/a",
    worktreeRepo: "git@github.com:owner/project.git",
    taskSource: "brief",
    filesChanged: p.includes("beta") ? [reported] : ["lib/alpha.ts"],
    testOutput: "2 pass",
  }), src);
  const result: any = await run(SUBS);
  return Array.isArray(result?.buildResult?.filesChanged) ? result.buildResult.filesChanged : [];
}
