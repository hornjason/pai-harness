/**
 * The history keeps the evidence behind its verdicts (#116).
 *
 * Covers SC-1475, SC-1476, SC-1477, SC-1478 (INSTRUCTION-COMPLIANCE-SPEC.md).
 *
 * A grade file carries `{ id, rule, verdict, evidence, category }` per rule.
 * `compliance-history.jsonl` kept `id → verdict` and dropped the other three:
 *
 * ```
 * grade:   { id: "DIR-L29", verdict: "VIOLATED",
 *            rule: "Run the full suite at most TWICE…",
 *            evidence: "5 bun test runs (expected 1-2)", category: "quality" }
 * history: { "DIR-L29": "VIOLATED" }
 * ```
 *
 * The second cannot be re-checked, loses the rule text the moment the rule is
 * edited, and produces a trend that cannot explain itself. That is tier F by
 * the standard this repo applies to ACs.
 *
 * It had not bitten because the writer was never running (#69). All four
 * entries on disk when #116 was filed were synthetic, which is why the schema
 * changed rather than being migrated.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  COMPLIANCE_HISTORY_SCHEMA,
  appendComplianceHistory,
  loadComplianceHistory,
  entryVerdicts,
  ruleRecords,
  historySchema,
  recordedRuleText,
  evidenceFor,
  generateComplianceReport,
  type ComplianceEntry,
} from "../lib/compliance-report";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "rg-history-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const historyPath = () => join(root, "compliance-history.jsonl");

/** The record #116 quotes, verbatim. */
const DIR_L29 = {
  id: "DIR-L29",
  verdict: "VIOLATED",
  rule: "Run the full suite at most TWICE per 30 minutes",
  evidence: "5 bun test runs (expected 1-2)",
  category: "quality",
};

function v2(over: Partial<ComplianceEntry> = {}): ComplianceEntry {
  return {
    timestamp: "2026-10-15T00:00:00.000Z",
    issue: "#116",
    role: "marcus",
    schema: COMPLIANCE_HISTORY_SCHEMA,
    rules: [DIR_L29, { id: "COMP-7", verdict: "FOLLOWED", rule: "No cat/head via Bash", evidence: "0 piped reads", category: "process" }],
    total: 2,
    followed: 1,
    pct: 50,
    flagged: [],
    ...over,
  };
}

/** A line written before #116: a flat map and no version stamp. */
function v1(over: Partial<ComplianceEntry> = {}): ComplianceEntry {
  return {
    timestamp: "2026-09-30T00:00:00.000Z",
    issue: "#compliance-test-1",
    role: "marcus",
    scores: { "DIR-L29": "VIOLATED", "COMP-7": "FOLLOWED" },
    total: 2,
    followed: 1,
    pct: 50,
    flagged: [],
    ...over,
  };
}

// ── SC-1475 ─────────────────────────────────────────────────────────────────

describe("SC-1475: an entry retains rule, evidence and category for every graded rule", () => {
  test("the round trip keeps all three, not just the verdict", () => {
    appendComplianceHistory(historyPath(), v2());
    const [back] = loadComplianceHistory(historyPath());
    const dir = ruleRecords(back!).find(r => r.id === "DIR-L29")!;
    expect(dir.verdict).toBe("VIOLATED");
    expect(dir.rule, "the rule text did not survive").toBe(DIR_L29.rule);
    expect(dir.evidence, "the verdict is unsourced again").toBe(DIR_L29.evidence);
    expect(dir.category).toBe("quality");
  });

  test("every graded rule, not only the violated one", () => {
    // The control. A writer that kept records only for failures would satisfy
    // the case above and lose the baseline a trend is measured against.
    appendComplianceHistory(historyPath(), v2());
    const [back] = loadComplianceHistory(historyPath());
    expect(ruleRecords(back!).map(r => r.id)).toEqual(["DIR-L29", "COMP-7"]);
    expect(ruleRecords(back!).every(r => r.evidence)).toBe(true);
  });

  test("the evidence for one rule is recoverable across runs, newest first", () => {
    appendComplianceHistory(historyPath(), v2({ issue: "#1" }));
    appendComplianceHistory(historyPath(), v2({
      issue: "#2",
      rules: [{ ...DIR_L29, verdict: "FOLLOWED", evidence: "2 bun test runs" }],
    }));
    const found = evidenceFor(loadComplianceHistory(historyPath()), "DIR-L29");
    expect(found.map(r => r.evidence)).toEqual(["2 bun test runs", "5 bun test runs (expected 1-2)"]);
  });
});

// ── SC-1476 ─────────────────────────────────────────────────────────────────

describe("SC-1476: the schema version distinguishes before from after", () => {
  test("a v2 entry is stamped and a v1 entry reads as 1", () => {
    appendComplianceHistory(historyPath(), v1());
    appendComplianceHistory(historyPath(), v2());
    const [old, recent] = loadComplianceHistory(historyPath());
    expect(historySchema(old!)).toBe(1);
    expect(historySchema(recent!)).toBe(COMPLIANCE_HISTORY_SCHEMA);
    expect(COMPLIANCE_HISTORY_SCHEMA).toBeGreaterThan(1);
  });

  test("the version is stamped, not inferred from the shape", () => {
    // "It has `rules`, so it must be v2" conflates "written after the change"
    // with "written after the change and carrying something", and those are
    // the two states a reader most needs to tell apart — a v2 entry for a
    // role graded on nothing has an empty `rules` and is still v2.
    const empty = v2({ rules: [], total: 0, followed: 0, pct: 0 });
    appendComplianceHistory(historyPath(), empty);
    const [back] = loadComplianceHistory(historyPath());
    expect(historySchema(back!)).toBe(COMPLIANCE_HISTORY_SCHEMA);
    expect(ruleRecords(back!)).toEqual([]);
  });

  test("a v2 entry does not also carry the flat map", () => {
    // Two copies of one fact in a record can disagree, and nothing would
    // notice which was right.
    appendComplianceHistory(historyPath(), v2());
    const [back] = loadComplianceHistory(historyPath());
    expect(back!.scores).toBeUndefined();
  });
});

// ── SC-1477 ─────────────────────────────────────────────────────────────────

describe("SC-1477: readers tolerate both shapes", () => {
  test("entryVerdicts reads a v1 map and a v2 record identically", () => {
    expect(entryVerdicts(v1())).toEqual({ "DIR-L29": "VIOLATED", "COMP-7": "FOLLOWED" });
    expect(entryVerdicts(v2())).toEqual({ "DIR-L29": "VIOLATED", "COMP-7": "FOLLOWED" });
  });

  test("a trend over a mixed history covers both and names them", () => {
    // The real compatibility case: the file on disk has four v1 lines in it.
    const history = [v1({ issue: "#a" }), v1({ issue: "#b" }), v2({ issue: "#c" })];
    const report = generateComplianceReport(v2({ issue: "#d" }), history, 80);
    const ids = report.compTrends.map(t => t.compId).sort();
    expect(ids, "a shape dropped out of the trend").toEqual(["COMP-7", "DIR-L29"]);
    const dir = report.compTrends.find(t => t.compId === "DIR-L29")!;
    expect(dir.lastN.length).toBe(4);
    expect(dir.lastN.every(v => v === "VIOLATED")).toBe(true);
  });

  test("the recorded rule text beats the hardcoded map", () => {
    // `COMP_RULES` goes stale the moment a rule is edited; the entry carries
    // what the rule said when the verdict was reached.
    const edited = v2({ rules: [{ id: "COMP-7", verdict: "FOLLOWED", rule: "the wording as it was then" }] });
    const report = generateComplianceReport(edited, [], 80);
    expect(report.compTrends.find(t => t.compId === "COMP-7")!.rule).toBe("the wording as it was then");
  });

  test("a v1-only id still gets a rule label, so nothing reads as blank", () => {
    // The control for the line above. A reader that only used recorded text
    // would leave every v1 trend line labelled with a bare id.
    const report = generateComplianceReport(v1(), [], 80);
    expect(report.compTrends.find(t => t.compId === "COMP-7")!.rule).toBe("No cat/head via Bash");
    expect(recordedRuleText([v1()], "COMP-7")).toBeNull();
  });

  test("an entry with neither shape does not throw", () => {
    const bare = { timestamp: "t", issue: "#x", role: "marcus", total: 0, followed: 0, pct: 0, flagged: [] };
    expect(entryVerdicts(bare as ComplianceEntry)).toEqual({});
    expect(() => generateComplianceReport(bare as ComplianceEntry, [], 80)).not.toThrow();
  });
});

// ── SC-1478 ─────────────────────────────────────────────────────────────────

describe("SC-1478: the writers produce the new shape from a real grade file", () => {
  test("a grade file round-trips through the backfill with its evidence intact", async () => {
    // Driven through `planComplianceBackfill`, which reads the same grade
    // files the live writer does and was lossy in exactly the same way.
    const { planComplianceBackfill } = await import("../lib/compliance-backfill");
    const work = join(root, ".rungate", "proj-116");
    const { mkdirSync } = await import("fs");
    mkdirSync(work, { recursive: true });
    writeFileSync(
      join(work, "compliance-grade.json"),
      JSON.stringify({ grades: [{ role: "marcus", total: 2, followed: 1, rules: [DIR_L29], flagged: [] }] }),
    );

    const plan = planComplianceBackfill(join(root, ".rungate"), []);
    expect(plan.added.length, "the grade file was not read").toBe(1);
    const entry = plan.added[0]!;
    expect(historySchema(entry)).toBe(COMPLIANCE_HISTORY_SCHEMA);
    expect(ruleRecords(entry)).toEqual([DIR_L29]);

    // And it survives the file, which is the half a direct comparison skips.
    appendComplianceHistory(historyPath(), entry);
    expect(ruleRecords(loadComplianceHistory(historyPath())[0]!)).toEqual([DIR_L29]);
  });

  test("a rule with no verdict is still recorded, as N/A", () => {
    const entry = v2({ rules: [{ id: "COMP-9", verdict: "" }] });
    appendComplianceHistory(historyPath(), { ...entry, rules: [{ id: "COMP-9", verdict: "N/A" }] });
    expect(entryVerdicts(loadComplianceHistory(historyPath())[0]!)).toEqual({ "COMP-9": "N/A" });
  });

  test("the LIVE writer carries all three from grade file to history file", async () => {
    // MEASURED: without this, deleting `rule`, `evidence` and `category` from
    // `scripts/persist-compliance.ts`'s entry builder scored ZERO — the whole
    // defect #116 is about, reintroduced, against a suite that only checked
    // hand-built fixtures and the verdict map. The round trip has to start at
    // the grade file the writer actually reads.
    const { persistCompliance } = await import("../scripts/persist-compliance");
    const { mkdirSync } = await import("fs");
    const work = join(root, "run");
    mkdirSync(work, { recursive: true });
    writeFileSync(
      join(work, "workflow-state.json"),
      JSON.stringify({ schemaVersion: 2, issue: 116, slug: "history-evidence", phase: "VERIFY", issueGoal: "keep the evidence", acs: [] }),
    );
    writeFileSync(
      join(work, "compliance-grade.json"),
      JSON.stringify({ grades: [{ role: "marcus", total: 1, followed: 0, flagged: ["DIR-L29"], rules: [DIR_L29] }] }),
    );

    persistCompliance(work, join(import.meta.dir, ".."), "116", () => {});

    const written = loadComplianceHistory(join(root, "compliance-history.jsonl"));
    expect(written.length, "the writer produced no history entry").toBe(1);
    const rec = ruleRecords(written[0]!).find(r => r.id === "DIR-L29");
    expect(rec, "the writer dropped the record").toBeDefined();
    expect(rec!.rule).toBe(DIR_L29.rule);
    expect(rec!.evidence, "the verdict reached the history unsourced").toBe(DIR_L29.evidence);
    expect(rec!.category).toBe("quality");
    expect(historySchema(written[0]!)).toBe(COMPLIANCE_HISTORY_SCHEMA);
  });

  test("the live writer is the one under test and not a copy of it", () => {
    // `scripts/persist-compliance.ts` builds the entry inline. Asserting the
    // shape here and leaving the writer unasserted would be a round-trip test
    // of this file's own fixtures — see test/unit/persist-compliance.test.ts
    // for the executed half, and this for the single-binding property.
    const src = require("fs").readFileSync(join(import.meta.dir, "..", "scripts", "persist-compliance.ts"), "utf-8");
    expect(src, "the writer still builds a flat scores map").not.toMatch(/scores\[r\.id\] = /);
    expect(src).toContain("schema: COMPLIANCE_HISTORY_SCHEMA");
  });
});
