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
  receiptSignature,
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
  /** ship.js's own second implementation of the signature, for the parity matrix (#663). */
  recomputeReceiptSignature: (receipt: unknown) => string;
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
    `${body}\nreturn { PERSIST_RECEIPT_SCHEMA, persistReceiptLines, recomputeReceiptSignature }`,
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

/** The runtime type of a value, in the vocabulary a JSON schema uses. */
function runtimeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Every path the schema declares a `type` for, with the types it admits. */
function schemaTypes(schema: unknown, prefix = ""): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!isPlainObject(schema)) return out;
  if (prefix !== "" && schema.type !== undefined) {
    out.set(prefix, Array.isArray(schema.type) ? schema.type.map(String) : [String(schema.type)]);
  }
  const props = schema.properties;
  if (isPlainObject(props)) {
    for (const [key, sub] of Object.entries(props)) {
      const path = prefix ? `${prefix}.${key}` : key;
      for (const [p, t] of schemaTypes(sub, path)) out.set(p, t);
    }
  }
  if (schema.items !== undefined) {
    for (const [p, t] of schemaTypes(schema.items, `${prefix}[]`)) out.set(p, t);
  }
  return out;
}

/**
 * Every runtime type observed at every path, accumulated across receipts.
 *
 * A SET per path, not a single type, because one path legitimately carries
 * more than one: `compId` is a string for a COMP-level occurrence and null
 * for a role-level one, and a walk that kept only the last would report
 * whichever receipt happened to come last in the fixture list.
 */
function valueTypes(value: unknown, prefix = "", out = new Map<string, Set<string>>()): Map<string, Set<string>> {
  if (Array.isArray(value)) {
    for (const el of value) valueTypes(el, `${prefix}[]`, out);
    return out;
  }
  if (!isPlainObject(value)) return out;
  for (const [key, sub] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!out.has(path)) out.set(path, new Set());
    out.get(path)!.add(runtimeType(sub));
    valueTypes(sub, path, out);
  }
  return out;
}

/**
 * Every carried value whose runtime type the declaration does not admit (#663).
 *
 * The path walk above answers "is this field named in both shapes". That is
 * the question #646 asked, and `compId` passes it: it is present either side.
 * A structured-output schema is a FILTER, and a filter discriminates on TYPE
 * as well as on name — `{ type: 'string' }` over a value that is `null` is
 * the same silent drop one level down, in a field whose null is the whole
 * reason it exists.
 *
 * Separated from the path comparison so it can be mutated on its own: a
 * single function answering both questions would let either case be held up
 * by the other (`.claude/rules/checks-must-be-able-to-fail.md`, #484).
 */
function typeMismatches(schema: unknown, receipts: unknown[]): string[] {
  const declared = schemaTypes(schema);
  const observed = new Map<string, Set<string>>();
  for (const receipt of receipts) {
    for (const [path, types] of valueTypes(receipt)) {
      if (!observed.has(path)) observed.set(path, new Set());
      for (const t of types) observed.get(path)!.add(t);
    }
  }
  const out: string[] = [];
  for (const [path, types] of [...observed].sort(([a], [b]) => a.localeCompare(b))) {
    const admits = declared.get(path);
    // An undeclared path is the OTHER check's finding. Reporting it here too
    // would be two positions naming one defect, and the counts would then
    // move together under either mutation.
    if (admits === undefined) continue;
    for (const t of [...types].sort()) {
      if (!admits.includes(t)) {
        out.push(
          `the receipt carries \`${path}\` as \`${t}\` and the persist-compliance schema declares ` +
            `it as \`${admits.join(" | ")}\` — a structured-output schema filters on type as well ` +
            `as on name, so this value does not survive the relay in the shape it was produced (#663)`,
        );
      }
    }
  }
  return out;
}

/**
 * THE BINDING (AC-C2, #663).
 *
 * Every field the receipts carry that `workflows/ship.js`'s declared schema
 * would drop on the way back through the persist-compliance agent — by NAME,
 * because the schema does not declare the path, or by TYPE, because it
 * declares one the value is not. One place to mutate, so a case can watch the
 * refusal stop refusing.
 *
 * Declared-but-unused is deliberately NOT a violation: `error` only exists on
 * the failure path and a schema is allowed to be wider than any one reply.
 * The direction that costs something is the other one.
 */
export function persistReceiptRelayViolations(shipSource: string, receipts: unknown[]): string[] {
  const schema = loadReceiptBlock(shipSource).PERSIST_RECEIPT_SCHEMA;
  const declared = new Set(schemaPaths(schema));
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
  return [
    ...[...carried]
      .filter((path) => !declared.has(path))
      .sort()
      .map(
        (path) =>
          `the receipt carries \`${path}\` and the persist-compliance schema does not declare it — ` +
          `the agent relay drops undeclared fields, so it would never reach the operator (#646)`,
      ),
    ...typeMismatches(schema, receipts),
  ];
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

// ── #663: the declaration admits the type, not only the name ────────────────

/** Narrow `compId` back to the pre-#663 declaration, by name. */
function withCompIdNotNullable(): string {
  const pattern = /compId: \{ type: \['string', 'null'\] \}/;
  if (!pattern.test(SHIP)) {
    throw new Error(
      "the schema declaration has no nullable `compId` to narrow — nothing was mutated, and a " +
        "mutation that was never applied measures the code twice rather than once (#485)",
    );
  }
  return SHIP.replace(pattern, "compId: { type: 'string' }");
}

describe("#663 AC-1: the declared schema admits every type the producing side carries", () => {
  test("`compId` is declared nullable in the declaration itself, not inferred from a reply", () => {
    // Over the DECLARATION, as the criterion asks. A case reading a sample
    // reply would pass on any receipt whose occurrences all happened to carry
    // a string, which is every receipt with no role-level outcome in it.
    const occurrence = loadReceiptBlock(SHIP).PERSIST_RECEIPT_SCHEMA as any;
    const compId = occurrence.properties.hillClimb.properties.states
      .properties.NO_ACTIONS_DETECTED.items.properties.compId;
    expect(compId.type).toEqual(["string", "null"]);
  });

  test("the fixtures really carry a null `compId`, so the case below is not vacuous", () => {
    // `string | null` is only a distinction if a null travels. Without this,
    // a declaration of `{ type: 'string' }` would agree with every fixture
    // and the mutation case would be green over the defect.
    const observed = new Set<string>();
    for (const receipt of allReceipts()) {
      for (const [path, types] of valueTypes(receipt)) {
        if (path.endsWith("[].compId")) for (const t of types) observed.add(t);
      }
    }
    expect(observed.has("null")).toBe(true);
    expect(observed.has("string")).toBe(true);
  });
});

describe("#663 AC-2: the comparison reads runtime types, not only paths", () => {
  test("narrowing `compId` to a bare string turns the binding red", () => {
    const receipts = allReceipts();
    // Both directions in one case: "the real source agrees" and "the mutant
    // does not" are one claim, and asserting only the second passes over a
    // binding that refuses everything.
    expect(persistReceiptRelayViolations(SHIP, receipts)).toEqual([]);
    const violations = persistReceiptRelayViolations(withCompIdNotNullable(), receipts);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join("\n")).toContain("compId");
  });

  test("each mismatch names both the declared type and the observed one", () => {
    const text = persistReceiptRelayViolations(withCompIdNotNullable(), allReceipts()).join("\n");
    expect(text).toContain("as `null`");
    expect(text).toContain("declares it as `string`");
  });

  test("the path walk alone cannot see it, which is why the type walk exists", () => {
    // The finding this issue is about: `compId` is present in BOTH shapes, so
    // #646's path comparison agreed while the filter disagreed. Asserted here
    // rather than argued, so a later simplification that folds the type walk
    // back into the path walk has something to go red.
    const narrowed = withCompIdNotNullable();
    const declaredPaths = new Set(
      schemaPaths(loadReceiptBlock(narrowed).PERSIST_RECEIPT_SCHEMA),
    );
    const carried = new Set(allReceipts().flatMap((r) => valuePaths(r)));
    const droppedByName = [...carried].filter((p) => !declaredPaths.has(p));
    expect(droppedByName).toEqual([]);
    expect(declaredPaths.has("hillClimb.states.NO_ACTIONS_DETECTED[].compId")).toBe(true);
  });
});

// ── #663: the relayed receipt is compared against what the script computed ──

/**
 * The matrix both signature implementations are driven over.
 *
 * It has to VARY, or a parity test is two functions agreeing on one input.
 * The spread is asserted below rather than assumed.
 */
function signatureMatrix(): PersistResult[] {
  const clean = cleanReceipt();
  const noSection = noSectionReceipt();
  const unclassified = unclassifiedReceipt(clean);
  const applied: PersistResult = { ...clean, hillClimbApplied: 3 };
  const multi: PersistResult = {
    ...clean,
    hillClimb: hillClimbReceipt(
      {
        ...emptyHillClimbStates(),
        NO_BRIEF_REGISTERED: [
          { role: ROLE, compId: null, detail: "no brief registered" },
          { role: "quinn", compId: null, detail: "no brief registered" },
        ],
        OUTCOMES_UNACCOUNTED: [{ role: ROLE, compId: null, detail: "2 in, 1 out" }],
      },
      [],
    ),
  };
  // One row per field the operator line prints, so the matrix varies every
  // dimension the signature claims to cover rather than only the hill-climb
  // ones (found by the commit security review of `4cf80f0f`).
  const notPersisted: PersistResult = { ...clean, persisted: !clean.persisted };
  const regraded: PersistResult = { ...clean, graded: clean.graded + 2 };
  const verifiedOne: PersistResult = { ...clean, verified: [ROLE] };
  // Same LENGTH, different member — a count would call these two equal, and
  // `verified` is the list the operator line prints by name.
  const verifiedOther: PersistResult = { ...clean, verified: ["quinn"] };
  // Same again for the reasons, which are the sentences an UNMEASURED run is
  // explained by.
  const reasonsSwapped: PersistResult = {
    ...noSection,
    hillClimb: { ...noSection.hillClimb, unmeasuredReasons: ["a different reason entirely"] },
  };
  return [
    clean, noSection, unclassified, applied, multi,
    notPersisted, regraded, verifiedOne, verifiedOther, reasonsSwapped,
  ];
}

describe("#663 AC-3: the two signature implementations are compared, not assumed", () => {
  test("the matrix varies, so the parity below is over more than one shape", () => {
    const signatures = new Set(
      signatureMatrix().map((r) => receiptSignature(r)),
    );
    expect(signatures.size).toBe(signatureMatrix().length);
  });

  test("ship.js's recomputation agrees with the script's over every shape", () => {
    // `workflows/ship.js` cannot import (#69), so the signature is computed in
    // two positions. This is the comparison that makes that safe — the same
    // shape #171 uses for `rookScopeCommand`. Adding a state to
    // HILL_CLIMB_STATES and not to PERSIST_SIGNATURE_STATES is red here.
    const recompute = loadReceiptBlock(SHIP).recomputeReceiptSignature;
    for (const receipt of signatureMatrix()) {
      expect(recompute(receipt)).toBe(receiptSignature(receipt));
    }
  });

  test("every field the operator line prints is covered by the signature", () => {
    // The rule, driven rather than written down: anything printed as evidence
    // is in the signature, or it is not printed as evidence.
    //
    // The first version of this change covered only the hill-climb fields,
    // and `persisted`, `graded` and `verified` are printed too — so a
    // restatement that flipped `persisted` to true passed the comparison in
    // silence, which is the Silent Default Substitution this receipt exists
    // to remove, reintroduced by the fix for it. A per-field case rather than
    // one happy-path assertion, because the defect is per field.
    const base = cleanReceipt();
    const perturbations: Array<[string, PersistResult]> = [
      ["persisted", { ...base, persisted: !base.persisted }],
      ["graded", { ...base, graded: base.graded + 1 }],
      ["hillClimbApplied", { ...base, hillClimbApplied: base.hillClimbApplied + 1 }],
      ["verified", { ...base, verified: [...base.verified, "quinn"] }],
      ["hillClimb.reading", { ...base, hillClimb: { ...base.hillClimb, reading: "UNMEASURED" } }],
      [
        "hillClimb.unmeasuredReasons",
        { ...base, hillClimb: { ...base.hillClimb, unmeasuredReasons: ["invented"] } },
      ],
      [
        "hillClimb.states",
        {
          ...base,
          hillClimb: {
            ...base.hillClimb,
            states: {
              ...base.hillClimb.states,
              GRADER_ACCURACY_DROP: [{ role: ROLE, compId: null, detail: "x" }],
            },
          },
        },
      ],
      [
        "hillClimb.unclassified",
        {
          ...base,
          hillClimb: { ...base.hillClimb, unclassified: [{ role: ROLE, compId: null, detail: "x" }] },
        },
      ],
    ];
    const recompute = loadReceiptBlock(SHIP).recomputeReceiptSignature;
    const baseline = receiptSignature(base);
    for (const [field, perturbed] of perturbations) {
      expect(receiptSignature(perturbed), `altering ${field} left the script's signature unchanged`)
        .not.toBe(baseline);
      // And ship.js agrees about each one, so the coverage is not one-sided.
      expect(recompute(perturbed), `ship.js disagrees about ${field}`)
        .toBe(receiptSignature(perturbed));
    }
  });

  test("a swapped list member changes the signature, not just a different length", () => {
    // `verified` and `unmeasuredReasons` are lists of strings. A count-based
    // signature calls these two receipts identical, and the operator line
    // prints the names (`.claude/rules/checks-must-be-able-to-fail.md` on
    // #532: ask whether the defect changes the number or the membership).
    const base = cleanReceipt();
    const one = receiptSignature({ ...base, verified: ["marcus"] });
    const other = receiptSignature({ ...base, verified: ["quinn"] });
    expect(one).not.toBe(other);
  });

  test("the script really emits a non-empty signature, so agreement is not two silences", () => {
    // The non-vacuity criterion. An absent signature on both sides compares
    // equal, and `undefined === undefined` is the agreement this whole check
    // exists to refuse.
    const receipt = cleanReceipt();
    expect(typeof receipt.receiptSignature).toBe("string");
    expect(receipt.receiptSignature.length).toBeGreaterThan(0);
    expect(receipt.receiptSignature).toContain("v1:");
  });

  test("a receipt whose signature matches its fields reports no relay problem", () => {
    // The agreeing direction, as the criterion asks for explicitly.
    const text = loadReceiptBlock(SHIP).persistReceiptLines(cleanReceipt()).join("\n");
    expect(text).not.toContain("UNMEASURED relay");
  });

  test("a restatement that altered a field no longer agrees, and says so", () => {
    // The disagreeing direction: the agent copied the token and changed the
    // verdict, which is the realistic failure — normalising a field you
    // understand and copying one you do not are what a summariser does.
    const real = noSectionReceipt();
    expect(real.hillClimb.reading).toBe("UNMEASURED");
    const drifted = { ...real, hillClimb: { ...real.hillClimb, reading: "MEASURED" } };
    const text = loadReceiptBlock(SHIP).persistReceiptLines(drifted).join("\n");
    expect(text).toContain("UNMEASURED relay");
    expect(text).toContain(real.receiptSignature);
  });

  test("the disagreement is resolved in favour of NEITHER side", () => {
    // Preferring the relayed value is the defect. Preferring the recomputed
    // one asserts the fields are right and only the token is wrong, which is
    // the same assumption pointed the other way. What is known is that they
    // disagree, so both are printed and neither is adopted.
    const real = noSectionReceipt();
    const drifted = { ...real, hillClimb: { ...real.hillClimb, reading: "MEASURED" } };
    const text = loadReceiptBlock(SHIP).persistReceiptLines(drifted).join("\n");
    const recomputed = loadReceiptBlock(SHIP).recomputeReceiptSignature(drifted);
    expect(text).toContain(real.receiptSignature);
    expect(text).toContain(recomputed);
    expect(text).not.toContain("treating");
  });

  test("an absent signature is UNMEASURED, not agreement", () => {
    const { receiptSignature: _dropped, ...stripped } = cleanReceipt();
    expect(_dropped).toBeTruthy();
    const text = loadReceiptBlock(SHIP).persistReceiptLines(stripped).join("\n");
    expect(text).toContain("UNMEASURED relay");
    expect(text).toContain("no receiptSignature");
  });
});

describe("#663 AC-4: `reading` is validated against the two literals", () => {
  test("a third string is UNMEASURED and the value it received is named", () => {
    const real = cleanReceipt();
    const odd = { ...real, hillClimb: { ...real.hillClimb, reading: "PARTIAL" } };
    const text = loadReceiptBlock(SHIP).persistReceiptLines(odd).join("\n");
    expect(text).toContain("UNMEASURED hill-climb");
    expect(text).toContain('"PARTIAL"');
  });

  test("both legal values are accepted, so the check is not refusing everything", () => {
    // A validator that refused every reading would make the case above pass
    // for a reason that has nothing to do with the third string.
    const clean = loadReceiptBlock(SHIP).persistReceiptLines(cleanReceipt()).join("\n");
    expect(clean).not.toContain("neither MEASURED nor UNMEASURED");
    const unmeasured = loadReceiptBlock(SHIP).persistReceiptLines(noSectionReceipt()).join("\n");
    expect(unmeasured).not.toContain("neither MEASURED nor UNMEASURED");
    expect(unmeasured).toContain("UNMEASURED hill-climb");
  });
});
