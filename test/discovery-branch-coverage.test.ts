/**
 * #523 — is the list of "fields that must be stable" still true?
 *
 * WHAT VARIES BETWEEN THE TWO READINGS, SAID FIRST.
 *
 * A determinism check that builds the same thing twice with the same code and
 * compares the two outputs is 0 red against the mutation it exists to catch.
 * This file is not that. Its two readings have different producers:
 *
 *   A — the DECLARATION: `STABLE_DISCOVERY_FIELDS`, `NOT_ASSERTED` and
 *       `BRANCHED_BUT_UNPERSISTED`, hand-written.
 *   B — the CODE: every discovery property read inside a condition in
 *       `workflows/ship.js`, parsed out with acorn.
 *
 * Editing either side alone changes the result. A branch added tomorrow on a
 * field nobody declared grows B; deleting an entry shrinks A; both are
 * reported, in both directions. The claim is (c): **a refusal when the two
 * readings disagree** — not a shape, not an order.
 *
 * NOTHING HERE CALLS A MODEL. The measurement of whether the model itself is
 * deterministic is `scripts/measure-discovery-stability.ts`, is a dated
 * report rather than a gate, and is still UNMEASURED pending a k >= 3 series.
 * This file checks the instrument's TARGET LIST, which is free, deterministic,
 * and the half that silently rots.
 *
 * THE VACUITY THIS FILE EXISTS TO CLOSE, NAMED.
 *
 * Every test in `test/discovery-stability.test.ts` reads the declared list,
 * the zod schema, or synthetic states — never the workflow. So adding
 * `if (discovery.riskTier === 'HIGH')` to ship.js leaves all of them green
 * while the measurement goes on reporting "0 varied" over a list that no
 * longer describes the run. `coversTheRealWorkflow` below is the only
 * assertion in the repository that would notice.
 *
 * THE CHEAPEST WRONG FIX, AND WHETHER THESE CASES SURVIVE IT.
 *
 * Cheapest: append the new field's name to the `readAs` of any existing
 * entry. These cases do NOT survive that — it goes green. That is deliberate
 * and worth stating rather than papering over: this check catches SILENCE, a
 * branch nobody classified, which is the failure mode the criterion comment
 * predicted. It does not catch a deliberate false declaration, and no
 * mechanical check can — `readAs` is a claim a reviewer reads.
 *
 * Second cheapest: delete the zero-branch-point refusal so a broken walk
 * returns `[]`, at which point "no undeclared field" is true of nothing. The
 * FLOOR case survives that non-vacuously: it asserts a minimum census against
 * the real file, which an empty walk fails.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { WorkflowStateSchema } from "../gates/schema";
import { NOT_ASSERTED, STABLE_DISCOVERY_FIELDS } from "../lib/discovery-stability";
import {
  auditBranchCoverage,
  BRANCHED_BUT_UNPERSISTED,
  BranchCensusRefusal,
  coveredFields,
  DISCOVERY_ROOTS,
  extractDiscoveryBranchPoints,
  formatCoverageReport,
  type SourceMapped,
} from "../lib/discovery-branch-points";

const MODULE_PATH = join(import.meta.dir, "..", "lib", "discovery-branch-points.ts");
const WORKFLOW_PATH = join(import.meta.dir, "..", "workflows", "ship.js");
const workflowSource = readFileSync(WORKFLOW_PATH, "utf8");

/* ───────────────────────────── the mutant ───────────────────────────────── */
//
// Same idiom as test/reachability-refusals.test.ts: the module with its single
// refusal constant zeroed, written outside the repo. Both import rewrites fail
// closed, because a mutant that dies on module resolution throws, and a throw
// reads as "the mutation was rejected on the merits" when the mutant never ran.

type Mutant = {
  extractDiscoveryBranchPoints: typeof extractDiscoveryBranchPoints;
  auditBranchCoverage: typeof auditBranchCoverage;
};

let MUTANT_DIR = "";
let mutant: Mutant;

beforeAll(async () => {
  const source = readFileSync(MODULE_PATH, "utf8");
  const neutralised = source.replace(/BRANCH_CENSUS_REFUSE = 1\b/, "BRANCH_CENSUS_REFUSE = 0");
  if (neutralised === source) {
    throw new Error(
      "could not build the mutant: no `BRANCH_CENSUS_REFUSE = 1` in lib/discovery-branch-points.ts",
    );
  }
  const acorn = import.meta.resolve("acorn");
  const relocated = neutralised
    .replace(/ from "acorn"/g, ` from ${JSON.stringify(acorn)}`)
    .replace(
      / from "\.\/discovery-stability"/g,
      ` from ${JSON.stringify(join(import.meta.dir, "..", "lib", "discovery-stability.ts"))}`,
    );
  if (relocated.includes(' from "acorn"') || relocated.includes(' from "./discovery-stability"')) {
    throw new Error("could not build the mutant: an import was left unrelocated");
  }

  MUTANT_DIR = mkdtempSync(join(tmpdir(), "branch-census-mutant-"));
  const file = join(MUTANT_DIR, "discovery-branch-points.ts");
  writeFileSync(file, relocated);
  mutant = (await import(file)) as Mutant;
});

afterAll(() => {
  if (MUTANT_DIR) rmSync(MUTANT_DIR, { recursive: true, force: true });
});

/* ───────────────────── A: the dispatch, on the real file ────────────────── */

describe("#523: the declared stable set still describes workflows/ship.js", () => {
  /**
   * Extracted per test rather than in a `beforeAll`, so a census that starts
   * refusing reddens the assertion it breaks BY NAME instead of collapsing the
   * whole group into one unnamed hook failure.
   */
  const census = () => extractDiscoveryBranchPoints(workflowSource);

  /**
   * THE FLOOR. Without it, every other assertion in this group is true of an
   * empty census — the exact shape of the "generator determinism" test that
   * compared two arrays that were always empty. The numbers are a floor, not
   * a snapshot: the real file censuses 24 reads over 8 fields today, and a
   * floor well under that does not red on ordinary workflow edits while still
   * reddening on a walk that has stopped walking.
   */
  test("FLOOR — the census actually reads the real workflow", () => {
    const points = census();
    expect(points.length, "the walk found almost nothing in a 9,900-line workflow").toBeGreaterThan(
      9,
    );
    expect(new Set(points.map(p => p.field)).size).toBeGreaterThan(4);
    // Reading from the file on disk, not from a fixture, is the whole point.
    expect(workflowSource.length).toBeGreaterThan(100_000);
  });

  /**
   * THE DISPATCH. The branch-point criterion from #523, enforced rather than
   * documented: a field a condition reads must be classified by one of the
   * three registers.
   */
  test("no branched field is unclassified", () => {
    const report = auditBranchCoverage(census());
    expect(
      report.undeclared.map(u => u.field),
      `a condition in workflows/ship.js decides the run on a field no register covers. ` +
        `Classify it: STABLE_DISCOVERY_FIELDS if the run must be repeatable on it, ` +
        `NOT_ASSERTED with a reason if it is allowed to vary, or BRANCHED_BUT_UNPERSISTED ` +
        `if WorkflowStateSchema cannot carry it.\n\n${formatCoverageReport(report)}`,
    ).toEqual([]);
  });

  /**
   * The other direction of the same rot. Every `STABLE_DISCOVERY_FIELDS` entry
   * justifies itself with `branchedOnBy`; when the branch goes away the
   * justification is no longer true and the entry is asserting stability on
   * prose, which is the thing the criterion exists to prevent.
   */
  test("no declared stable field has lost its branch", () => {
    const report = auditBranchCoverage(census());
    expect(
      report.staleJustification,
      "declared stable, but no condition in the workflow reads it any more — the " +
        "`branchedOnBy` justification has gone stale",
    ).toEqual([]);
  });

  test("the report names the fields it could not measure rather than omitting them", () => {
    const text = formatCoverageReport(auditBranchCoverage(census()));
    expect(text).toContain("UNMEASURED");
    expect(text).toContain("it is the absence of one");
  });
});

/* ─────────────── B: the extractor can find a field nobody declared ───────── */

describe("#523: a new branch on an undeclared field is caught", () => {
  test("a toy condition on an unknown field reports it", () => {
    const source = `if (discovery.riskTier === 'HIGH') { log('x') }\n`;
    const report = auditBranchCoverage(extractDiscoveryBranchPoints(source));
    expect(report.undeclared.map(u => u.field)).toEqual(["riskTier"]);
    expect(report.undeclared[0].points[0].construct).toBe("IfStatement.test");
    expect(report.undeclared[0].points[0].line).toBe(1);
  });

  /**
   * The toy case above passes for a census that reports every `discovery.X`
   * anywhere, which would drown the real list in prompt interpolations. This
   * is the input on which that mutant and the original differ.
   */
  test("a read OUTSIDE a condition is not a branch", () => {
    const branching = `if (discovery.riskTier) { x() }\nlog(\`tier \${discovery.other}\`)\n`;
    const report = auditBranchCoverage(extractDiscoveryBranchPoints(branching));
    expect(report.branchedFields).toEqual(["riskTier"]);
    expect(report.branchedFields).not.toContain("other");
  });

  /**
   * And on the real file, because a check proven only against toy fixtures has
   * been proven against toy fixtures. One line is appended to the real 9,900
   * lines and the census picks it out of the other 24.
   */
  test("INJECTED — one new branch in the real workflow is found among the rest", () => {
    const injected = `${workflowSource}\nif (discovery.blastRadiusTier === 'WIDE') { log('x') }\n`;
    const report = auditBranchCoverage(extractDiscoveryBranchPoints(injected));
    expect(report.undeclared.map(u => u.field)).toEqual(["blastRadiusTier"]);
    // The real file's own fields are still classified — the injection is the
    // only difference between this reading and the clean one.
    expect(report.branchedFields.length).toBe(
      auditBranchCoverage(extractDiscoveryBranchPoints(workflowSource)).branchedFields.length + 1,
    );
  });

  test("both discovery roots are walked, not just the long one", () => {
    for (const root of DISCOVERY_ROOTS) {
      const report = auditBranchCoverage(extractDiscoveryBranchPoints(`if (${root}.novel) { x() }`));
      expect(report.undeclared.map(u => u.field), `root \`${root}\` was not walked`).toEqual([
        "novel",
      ]);
    }
  });
});

/* ─────────────── C: deleting a declaration reddens, in both lists ────────── */

describe("#523: the declaration side is load-bearing", () => {
  const census = () => extractDiscoveryBranchPoints(workflowSource);

  test("dropping a `readAs` makes its field undeclared", () => {
    const weakened: SourceMapped[] = STABLE_DISCOVERY_FIELDS.map(f =>
      f.path === "sizing.ceremonyTier" ? { path: f.path } : { path: f.path, readAs: f.readAs },
    );
    const report = auditBranchCoverage(census(), weakened);
    expect(report.undeclared.map(u => u.field)).toContain("ceremonyTier");
  });

  test("a TYPO'd `readAs` reddens twice — undeclared and stale", () => {
    const typo: SourceMapped[] = STABLE_DISCOVERY_FIELDS.map(f =>
      f.path === "sizing.ceremonyTier"
        ? { path: f.path, readAs: ["ceremonyTeir"] }
        : { path: f.path, readAs: f.readAs },
    );
    const report = auditBranchCoverage(census(), typo);
    expect(report.undeclared.map(u => u.field)).toContain("ceremonyTier");
    expect(report.staleJustification).toContain("ceremonyTeir");
  });

  test("removing the `priorWork` exclusion resurfaces it as a finding", () => {
    const without = NOT_ASSERTED.filter(n => n.path !== "priorWork").map(n => ({
      path: n.path,
      readAs: n.readAs,
    }));
    const report = auditBranchCoverage(census(), STABLE_DISCOVERY_FIELDS, without);
    expect(report.undeclared.map(u => u.field)).toContain("priorWork");
  });

  test("emptying the unpersisted register resurfaces both of its fields", () => {
    const report = auditBranchCoverage(census(), STABLE_DISCOVERY_FIELDS, NOT_ASSERTED, []);
    expect(report.undeclared.map(u => u.field).sort()).toEqual(["filesToModify", "scopeOut"]);
  });
});

/* ────────── D: the "we could not measure it" excuse is itself checked ────── */

describe("#523: an unmeasurable field stops being excused the moment it is persisted", () => {
  /**
   * The independent witness is the zod object that EMITS the state, never the
   * register being checked. Sourcing the fixture from the list under test is
   * the shape that lets a list agree with itself forever.
   */
  const stateShape = () => (WorkflowStateSchema as any)._def.shape() as Record<string, unknown>;

  test("every entry is genuinely absent from WorkflowStateSchema", () => {
    const shape = stateShape();
    const nowPresent = BRANCHED_BUT_UNPERSISTED.filter(u => shape[u.field] !== undefined);
    expect(
      nowPresent.map(u => u.field),
      "this field IS in WorkflowStateSchema now, so a series CAN read it. " +
        "The excuse is stale — move it into STABLE_DISCOVERY_FIELDS with a declared equality.",
    ).toEqual([]);
  });

  /**
   * The negative control for the assertion above: if `stateShape` resolved to
   * an empty object, every field would read as absent and the check would
   * pass forever. A field known to be in the schema must be seen.
   */
  test("NEGATIVE CONTROL — the schema witness can see a field that IS present", () => {
    const shape = stateShape();
    expect(shape["sizing"]).toBeDefined();
    expect(shape["priorWork"]).toBeDefined();
    expect(Object.keys(shape).length).toBeGreaterThan(20);
  });

  test("every entry is actually branched on — a dead excuse is deleted, not kept", () => {
    const branched = new Set(extractDiscoveryBranchPoints(workflowSource).map(p => p.field));
    const dead = BRANCHED_BUT_UNPERSISTED.filter(u => !branched.has(u.field));
    expect(dead.map(u => u.field), "excused as unmeasurable, but nothing branches on it").toEqual(
      [],
    );
  });

  test("no field is classified twice", () => {
    const stable = coveredFields(STABLE_DISCOVERY_FIELDS);
    const excluded = coveredFields(NOT_ASSERTED);
    const unpersisted = new Set(BRANCHED_BUT_UNPERSISTED.map(u => u.field));
    const overlaps = [...stable].filter(f => excluded.has(f) || unpersisted.has(f));
    for (const f of excluded) if (unpersisted.has(f)) overlaps.push(f);
    expect(overlaps, "a field cannot be both asserted and excused").toEqual([]);
  });

  test("every entry carries a reason that cites where it branches", () => {
    for (const entry of BRANCHED_BUT_UNPERSISTED) {
      expect(entry.reason, `${entry.field} has no cited branch site`).toMatch(/ship\.js:\d+/);
    }
  });
});

/* ───────────────────── E: the refusals, against the mutant ──────────────── */

describe("#523: a census that measured nothing refuses instead of agreeing", () => {
  /**
   * Both halves are required: the real module refuses, and the same code with
   * the single refusal constant zeroed does not. Without the second half a
   * case can pass because of something other than the refusal under test.
   */
  function refuses(run: (m: Pick<Mutant, "extractDiscoveryBranchPoints">) => unknown) {
    expect(() => run({ extractDiscoveryBranchPoints })).toThrow(BranchCensusRefusal);
    expect(
      () => run(mutant),
      "the mutant (BRANCH_CENSUS_REFUSE = 0) still threw — this case is not being " +
        "caught by the refusal under test",
    ).not.toThrow();
  }

  test("a source with no discovery condition is UNMEASURED, not clean", () => {
    refuses(m => m.extractDiscoveryBranchPoints(`const x = 1\nif (other.thing) { y() }\n`));
  });

  test("a source that does not parse is UNMEASURED, not clean", () => {
    refuses(m => m.extractDiscoveryBranchPoints(`if (discovery.x { `));
  });

  test("a declaration that maps to nothing is a broken mapping, not a catastrophe", () => {
    const points = extractDiscoveryBranchPoints(workflowSource);
    expect(() => auditBranchCoverage(points, [{ path: "a" }], [{ path: "b" }])).toThrow(
      BranchCensusRefusal,
    );
    expect(() =>
      mutant.auditBranchCoverage(points, [{ path: "a" }], [{ path: "b" }]),
    ).not.toThrow();
  });

  /**
   * POSITIVE CONTROL. Without it, a module whose every entry point is
   * `refuse(...)` passes every case above.
   */
  test("POSITIVE CONTROL — the real workflow is accepted, not refused", () => {
    expect(() => auditBranchCoverage(extractDiscoveryBranchPoints(workflowSource))).not.toThrow();
  });
});

/* ──────────────────── F: the census is actually dispatched ──────────────── */

/**
 * An unwired control is byte-identical to no control (#530). The census above
 * is enforced by this file every suite run, and it is also printed in the
 * dated measurement itself — because the reader of "0 varied" is the person
 * who needs to know the list that produced it is verified, and which branched
 * fields produced no reading at all.
 */
describe("#523: the census reaches the dated measurement, not only the suite", () => {
  test("the report prints the census, under a HOME with no corpus at all", () => {
    const emptyHome = mkdtempSync(join(tmpdir(), "no-corpus-"));
    try {
      const run = Bun.spawnSync({
        cmd: ["bun", join(import.meta.dir, "..", "scripts", "measure-discovery-stability.ts")],
        env: { ...process.env, HOME: emptyHome, RUNGATE_WORK_DIR: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = new TextDecoder().decode(run.stdout);
      expect(run.exitCode, "a finding is not an error — this script never gates").toBe(0);
      expect(out).toContain("Discovery branch-point census (#523)");
      expect(out).toContain("branch read(s) over");
      // The corpus is absent, so the series half must still say so plainly.
      expect(out).toContain("This is not a clean result");
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});
