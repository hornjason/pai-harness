/**
 * Covers AC-C1, AC-C2, AC-C3 (#646).
 *
 * `scripts/persist-compliance.ts` now returns a receipt that names which of
 * the five hill-climb outcomes a run reached. Between that script and the
 * operator sits an AGENT: `workflows/ship.js` asks a model to run the command
 * and return the receipt, under a declared JSON schema. A structured-output
 * schema is not a description of the reply — it is a FILTER on it. Any field
 * the schema does not declare is dropped on the way back, silently, and the
 * run then logs a receipt that is missing exactly the part #646 added.
 *
 * So the producer and the consumer have to agree and nothing compared them,
 * which is `scripts/contract-parity.ts`'s subject (#626) and this repository's
 * most-shipped defect. The comparison lives here because the two positions it
 * reads are `workflows/ship.js`'s schema literal and the receipt
 * `persistCompliance` actually returns.
 *
 * TWO THINGS THIS FILE DELIBERATELY DOES NOT DO.
 *
 * It does not read the `PersistResult` interface as TEXT. A type annotation is
 * erased before anything runs, and a field the script stopped returning would
 * still be in the interface. Every receipt below is PRODUCED by driving the
 * real `persistCompliance` over a planted work directory, so the shape
 * compared is the shape that would travel.
 *
 * It does not ask the schema and the receipt the same question twice. There is
 * one exported binding, `persistReceiptRelayViolations`, and the operator-log
 * cases read `persistReceiptLines` out of ship.js itself rather than
 * re-deriving what the line should say — two deciders that agree are
 * behaviourally one (`.claude/rules/checks-must-be-able-to-fail.md`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  HILL_CLIMB_STATES,
  emptyHillClimbStates,
  hillClimbReceipt,
  persistCompliance,
  type PersistResult,
} from "../scripts/persist-compliance";
import { setComplianceProjectRoot, type ComplianceEntry } from "../lib/compliance-report";

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");
const SELF = readFileSync(join(import.meta.dir, "persist-receipt-relay.test.ts"), "utf-8");

// ── reading ship.js ─────────────────────────────────────────────────────────

/** The marked block carrying the declared schema and the operator-log lines. */
const BLOCK = "PERSIST-RECEIPT";

interface ReceiptBlock {
  PERSIST_RECEIPT_SCHEMA: Record<string, unknown>;
  persistReceiptLines: (receipt: unknown) => string[];
}

/**
 * Slice the block out and run it.
 *
 * A failure to find it THROWS rather than returning an empty schema: a
 * comparison that could not be performed is UNMEASURED and never a pass, and
 * zero declared properties against zero receipt fields is perfect agreement
 * (`.claude/rules/checks-must-be-able-to-fail.md`, third shape).
 */
function loadReceiptBlock(source: string): ReceiptBlock {
  const start = source.indexOf(`// ──── ${BLOCK}-START ────`);
  const end = source.indexOf(`// ──── ${BLOCK}-END ────`);
  if (start < 0 || end < 0) {
    throw new Error(
      `the ${BLOCK} block is not in the source handed to this check — the schema the ` +
        `persist-compliance relay declares could not be read, which is UNMEASURED, not agreement (#646)`,
    );
  }
  const body = source.slice(start, end);
  return new Function(
    `${body}\nreturn { PERSIST_RECEIPT_SCHEMA, persistReceiptLines }`,
  )() as ReceiptBlock;
}

// ── the two shapes, as path sets ────────────────────────────────────────────

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every field path a JSON-schema literal declares. `a.b` for objects, `a[]` for arrays. */
function schemaPaths(schema: unknown, prefix = ""): string[] {
  if (!isPlainObject(schema)) return [];
  const out: string[] = [];
  const props = schema.properties;
  if (isPlainObject(props)) {
    for (const [key, sub] of Object.entries(props)) {
      const path = prefix ? `${prefix}.${key}` : key;
      out.push(path);
      out.push(...schemaPaths(sub, path));
    }
  }
  if (schema.items !== undefined) out.push(...schemaPaths(schema.items, `${prefix}[]`));
  return out;
}

/** Every field path a real value carries. Same notation, so the two sets compare. */
function valuePaths(value: unknown, prefix = ""): string[] {
  const out: string[] = [];
  if (Array.isArray(value)) {
    for (const el of value) out.push(...valuePaths(el, `${prefix}[]`));
    return out;
  }
  if (!isPlainObject(value)) return out;
  for (const [key, sub] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.push(path);
    // `null` is a value, not a sub-object: `compId` is `string | null` and a
    // run in which it is null must still report the field as carried.
    out.push(...valuePaths(sub, path));
  }
  return out;
}

/**
 * THE BINDING (AC-C2).
 *
 * Every field the receipts carry that `workflows/ship.js`'s declared schema
 * would drop on the way back through the persist-compliance agent. One place
 * to mutate, so a case can watch the refusal stop refusing.
 *
 * Declared-but-unused is deliberately NOT a violation: `error` only exists on
 * the failure path and a schema is allowed to be wider than any one reply.
 * The direction that costs something is the other one.
 */
export function persistReceiptRelayViolations(shipSource: string, receipts: unknown[]): string[] {
  const declared = new Set(schemaPaths(loadReceiptBlock(shipSource).PERSIST_RECEIPT_SCHEMA));
  if (declared.size === 0) {
    throw new Error(
      "the persist-compliance schema declares no properties at all — nothing could be " +
        "compared, and zero against zero is agreement by vacuity (#646)",
    );
  }
  const carried = new Set<string>();
  for (const receipt of receipts) for (const path of valuePaths(receipt)) carried.add(path);
  if (carried.size === 0) {
    throw new Error(
      "no receipt field was read — the fixtures produced nothing, so this measured the " +
        "instrument and not the relay (#646)",
    );
  }
  return [...carried]
    .filter((path) => !declared.has(path))
    .sort()
    .map(
      (path) =>
        `the receipt carries \`${path}\` and the persist-compliance schema does not declare it — ` +
        `the agent relay drops undeclared fields, so it would never reach the operator (#646)`,
    );
}

// ── fixtures: receipts produced by the real script ──────────────────────────

const ROLE = "marcus";
/** COMP-13 carries both a reinforcement and a tier-2 promotion in the fallback maps. */
const COMP = "COMP-13";

let root: string;
let workDir: string;
let harnessRoot: string;
let briefPath: string;

const BRIEF_WITH_SECTION = `# Marcus\n\n## Efficiency Rules\n\n- Batch related reads.\n`;
const BRIEF_WITHOUT_SECTION = `# Marcus\n\n## Context\n\n- Read the brief.\n`;

function seedHistory(runs: Array<Record<string, string>>): void {
  const lines = runs.map((verdicts, i) => {
    const rules = Object.entries(verdicts).map(([id, verdict]) => ({ id, verdict }));
    const entry: ComplianceEntry = {
      timestamp: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      issue: `#${600 + i}`,
      role: ROLE,
      schema: 2,
      rules,
      total: rules.length,
      followed: rules.filter((r) => r.verdict === "FOLLOWED").length,
      pct: 0,
      flagged: [],
    };
    return JSON.stringify(entry);
  });
  writeFileSync(join(root, "compliance-history.jsonl"), lines.length ? lines.join("\n") + "\n" : "");
}

function writeGrade(verdicts: Record<string, string>): void {
  const rules = Object.entries(verdicts).map(([id, verdict]) => ({ id, verdict }));
  writeFileSync(
    join(workDir, "compliance-grade.json"),
    JSON.stringify({
      grades: [
        {
          role: ROLE,
          total: rules.length,
          followed: rules.filter((r) => r.verdict === "FOLLOWED").length,
          flagged: [],
          rules,
        },
      ],
    }),
  );
}

const run = (issue = "646"): PersistResult => persistCompliance(workDir, harnessRoot, issue, () => {});

/** A clean grade: an action was never detected. */
function cleanReceipt(): PersistResult {
  seedHistory([]);
  writeGrade({ [COMP]: "FOLLOWED" });
  return run();
}

/** A detected action whose brief has no heading to write under — UNMEASURED. */
function noSectionReceipt(): PersistResult {
  seedHistory([{ [COMP]: "IGNORED" }, { [COMP]: "IGNORED" }]);
  writeGrade({ [COMP]: "IGNORED" });
  writeFileSync(briefPath, BRIEF_WITHOUT_SECTION);
  return run();
}

/**
 * The `unclassified` list, which no fixture can reach through the script
 * without rewording `applyHillClimb` — so it is composed through the real
 * `hillClimbReceipt` and grafted onto a real receipt. The alternative is a
 * path the relay drops and no case can see.
 */
function unclassifiedReceipt(base: PersistResult): PersistResult {
  return {
    ...base,
    hillClimb: hillClimbReceipt(emptyHillClimbStates(), [
      { role: ROLE, compId: COMP, detail: `${COMP}: a phrase this classifier has never seen` },
    ]),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "persist-receipt-relay-"));
  workDir = join(root, "run");
  harnessRoot = join(root, "harness");
  briefPath = join(harnessRoot, ".claude", "agents", `${ROLE}.md`);
  mkdirSync(workDir, { recursive: true });
  mkdirSync(join(harnessRoot, ".claude", "rungate"), { recursive: true });
  mkdirSync(join(harnessRoot, ".claude", "agents"), { recursive: true });
  writeFileSync(
    join(harnessRoot, ".claude", "rungate", "config.json"),
    JSON.stringify({ project: "fixture" }),
  );
  writeFileSync(
    join(harnessRoot, ".claude", "rungate", "roles.json"),
    JSON.stringify({ [ROLE]: { brief: join(".claude", "agents", `${ROLE}.md`) } }),
  );
  writeFileSync(
    join(workDir, "workflow-state.json"),
    JSON.stringify({
      schemaVersion: 2,
      issue: 646,
      slug: "persist-receipt-relay",
      phase: "VERIFY",
      issueGoal: "the skip-state receipt survives the agent relay",
      acs: [],
    }),
  );
  writeFileSync(briefPath, BRIEF_WITH_SECTION);
  setComplianceProjectRoot("");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  setComplianceProjectRoot("");
});

/** Every receipt shape the relay has to carry, as one set of paths. */
function allReceipts(): PersistResult[] {
  const clean = cleanReceipt();
  const noSection = noSectionReceipt();
  return [clean, noSection, unclassifiedReceipt(clean)];
}

/** Drop one declared property line from the schema literal, by name. */
function withoutSchemaField(field: string): string {
  const pattern = new RegExp(`^ *${field}: .*\\n`, "m");
  if (!pattern.test(SHIP)) {
    throw new Error(`the schema declaration has no \`${field}\` line to remove — nothing was mutated`);
  }
  return SHIP.replace(pattern, "");
}

// ── AC-C2: one binding, and it is the only one ──────────────────────────────

describe("#646 AC-C2: one binding compares the declared schema against the receipt", () => {
  test("the binding's definition appears exactly once in this file", () => {
    // A second copy would survive any mutation of the first and hold the cases
    // below up while the real comparison was dead.
    const definitions = SELF.match(/export function persistReceiptRelayViolations\(/g) ?? [];
    expect(definitions.length).toBe(1);
    // …and it is the only export, so there is no second comparator wearing
    // another name.
    expect((SELF.match(/^export /gm) ?? []).length).toBe(1);
  });

  test("the declared schema is the schema the agent call is handed", () => {
    // The schema could be declared perfectly and the call site could still
    // pass a second literal. #530: the position that has a producer is the
    // contract, not an artefact that agrees with whatever you ask it.
    const callSite = SHIP.slice(SHIP.indexOf("label: 'persist-compliance'"));
    expect(callSite.slice(0, 400)).toContain("schema: PERSIST_RECEIPT_SCHEMA");
    expect((SHIP.match(/label: 'persist-compliance'/g) ?? []).length).toBe(1);
    expect((SHIP.match(/const PERSIST_RECEIPT_SCHEMA = /g) ?? []).length).toBe(1);
  });

  test("a source with no schema block refuses rather than reporting agreement", () => {
    // Zero declared properties against N carried fields is not a clean run —
    // it is an instrument that stopped reporting.
    expect(() => persistReceiptRelayViolations("// nothing here", allReceipts())).toThrow(
      /UNMEASURED, not agreement/,
    );
  });

  test("an empty receipt set refuses rather than reporting agreement", () => {
    expect(() => persistReceiptRelayViolations(SHIP, [])).toThrow(/measured the instrument/);
  });
});

// ── AC-C1: every skip-state field is declared ───────────────────────────────

describe("#646 AC-C1: the schema declares every field the receipt returns", () => {
  test("no field of any real receipt is dropped by the relay", () => {
    const violations = persistReceiptRelayViolations(SHIP, allReceipts());
    expect(violations).toEqual([]);
  });

  test("the fixtures really reach the skip-state fields, so the case above is not vacuous", () => {
    // A receipt set that never produced an occurrence would agree with a
    // schema that declared none of them.
    const carried = new Set(allReceipts().flatMap((r) => valuePaths(r)));
    for (const state of HILL_CLIMB_STATES) {
      expect(carried.has(`hillClimb.states.${state}`)).toBe(true);
    }
    for (const field of ["role", "compId", "detail"]) {
      expect(carried.has(`hillClimb.states.NO_SUITABLE_SECTION[].${field}`)).toBe(true);
      expect(carried.has(`hillClimb.unclassified[].${field}`)).toBe(true);
    }
    expect(carried.has("hillClimb.reading")).toBe(true);
    expect(carried.has("hillClimb.unmeasuredReasons")).toBe(true);
  });
});

// ── AC-C3: the refusal fires ────────────────────────────────────────────────

describe("#646 AC-C3: a field removed from the declaration is caught", () => {
  for (const state of HILL_CLIMB_STATES) {
    test(`removing \`${state}\` from the schema turns this red`, () => {
      const receipts = allReceipts();
      // Both halves in one case, deliberately: "the real source agrees" and
      // "the mutant does not" are the same claim read in two directions, and a
      // case asserting only the second passes over a binding that refuses
      // everything.
      expect(persistReceiptRelayViolations(SHIP, receipts)).toEqual([]);
      const violations = persistReceiptRelayViolations(withoutSchemaField(state), receipts);
      expect(violations.join("\n")).toContain(`hillClimb.states.${state}`);
    });
  }

  test("removing the whole hillClimb declaration names every field it carried", () => {
    const receipts = allReceipts();
    // The back-reference closes the property at its OWN indentation, so the
    // first deeper `},` inside it cannot end the match and leave a half-
    // deleted literal — a mutant that does not parse measures that the file
    // still parses (#485).
    const mutant = SHIP.replace(new RegExp("^([ \\t]*)hillClimb: \\{[\\s\\S]*?^\\1\\},\\n", "m"), "");
    expect(mutant).not.toBe(SHIP);
    const violations = persistReceiptRelayViolations(mutant, receipts);
    expect(violations.join("\n")).toContain("`hillClimb`");
    expect(violations.join("\n")).toContain("hillClimb.unclassified[].detail");
  });
});

// ── AC-C1: the operator log names the states ────────────────────────────────

describe("#646 AC-C1: the log line names each non-zero state", () => {
  const lines = (receipt: unknown): string => loadReceiptBlock(SHIP).persistReceiptLines(receipt).join("\n");

  test("a run whose only action had nowhere to go says so by name", () => {
    const text = lines(noSectionReceipt());
    expect(text).toContain("NO_SUITABLE_SECTION=1");
    expect(text).toContain("UNMEASURED hill-climb");
  });

  test("a run with nothing to do says THAT by name, and the two do not read alike", () => {
    // The pre-#646 operator line printed `hill-climb reinforcements=0` for
    // both. One varies: both receipts applied nothing.
    const clean = lines(cleanReceipt());
    expect(clean).toContain("NO_ACTIONS_DETECTED=1");
    expect(clean).not.toContain("UNMEASURED hill-climb");
    expect(clean).not.toBe(lines(noSectionReceipt()));
  });

  test("an unclassified skip is named in the line and raises the reading", () => {
    const text = lines(unclassifiedReceipt(cleanReceipt()));
    expect(text).toContain("UNCLASSIFIED_SKIP=1");
    expect(text).toContain("UNMEASURED hill-climb");
  });

  test("a receipt that arrived with no hillClimb at all is UNMEASURED, not clean", () => {
    // This is exactly what a relay that dropped the field would deliver, and
    // it must not read as a role with nothing wrong with it.
    const { hillClimb, ...stripped } = cleanReceipt();
    expect(hillClimb).toBeDefined();
    const text = lines(stripped);
    expect(text).toContain("UNMEASURED hill-climb");
    expect(text).toContain("#646");
  });

  test("a failed persist still reports the failure rather than a clean line", () => {
    const text = lines({ ok: false, error: "exit 1: boom" });
    expect(text).toContain("compliance persistence FAILED");
    expect(text).toContain("exit 1: boom");
  });
});
