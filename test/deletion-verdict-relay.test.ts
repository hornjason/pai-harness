/**
 * The deleted-tests verdict crosses an AGENT, and nothing compared the two
 * sides of the crossing (#684).
 *
 * `workflows/ship.js` hands the verify repair round a command —
 * `scripts/verify-no-deleted-cases.ts --out ${WORK_DIR}/deleted-cases.json` —
 * and then reads the verdict off the agent's REPLY. The artefact the command
 * wrote is opened by nothing: before this change, `grep -rn "deleted-cases"`
 * over the tree returned the `--out` path inside the prompt and a fixture,
 * and `grep -rn "deletionVerdict"` returned only reply-side reads in ship.js.
 *
 * The agent whose verdict is being read is the agent the check exists to
 * catch. #659's whole subject is a repair round that deleted eight passing
 * tests to make a gate go green.
 *
 * WHY THIS IS A SIGNATURE AND NOT A FILE READ, which is what the issue asks
 * for in as many words. `ship.js` CANNOT read a file — it runs in a sandbox
 * with no filesystem and no module loading (#69), and every `readFileSync` in
 * it is inside a prompt string or a `bun -e` subprocess. Routing the read
 * through a second agent would make the comparison itself a restatement,
 * which is the defect wearing a fix. So this follows #663: the script emits a
 * canonical token over the fields it wrote, the agent copies it verbatim,
 * `ship.js` recomputes it from the structured fields it was handed, and a
 * disagreement is UNMEASURED.
 *
 * WHAT THAT CLOSES, stated rather than left for a reader to discover. The
 * issue enumerates three doors:
 *
 *   1. report CLEAN and never run the command        — NOT closed
 *   2. run it, read DELETED, report CLEAN            — CLOSED
 *   3. re-run it with --accept per case (#661)       — made VISIBLE, not closed
 *
 * Door 2 is closed because the reply now carries both the artefact's own
 * verdict and the agent's one-word restatement of it, and a signature over
 * the artefact's fields: altering the verdict breaks the signature, copying
 * the signature and altering the restatement breaks the comparison. Door 1
 * requires fabricating a consistent signature, which means reimplementing
 * `deletionSignature`, and no in-process check can do better while #69 holds.
 * Door 3 was never a hole — a waived CLEAN now logs as a waived CLEAN.
 *
 * THREE THINGS THIS FILE DELIBERATELY DOES NOT DO.
 *
 * It does not read the artefact's TypeScript interface as text. A type is
 * erased before anything runs, so a field the script stopped writing would
 * still be in the interface. Every artefact below is PRODUCED by driving the
 * real `deletionReading` and `deletionArtefact`.
 *
 * It does not re-derive what the operator line should say. The log cases run
 * `deletionVerdictReading` out of `workflows/ship.js` itself — two deciders
 * that agree are behaviourally one
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 *
 * It does not assert the verdict the fixture typed in. Every artefact's
 * verdict comes back from `deletionReading`, so a case about DELETED is about
 * a reading that measured a deletion.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  WAIVER_SEPARATOR,
  deletionArtefact,
  deletionReading,
  deletionSignature,
  type DeletionArtefact,
  type PassLedger,
} from "../lib/test-case-deletion";

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");
const SELF = readFileSync(join(import.meta.dir, "deletion-verdict-relay.test.ts"), "utf-8");

// ── reading ship.js ─────────────────────────────────────────────────────────

/** The marked block carrying the declared schema and the one reading binding. */
const BLOCK = "DELETION-VERDICT";

interface VerdictBlock {
  DELETION_VERDICT_SCHEMA: Record<string, unknown>;
  /** ship.js's own second implementation of the signature, for the parity matrix. */
  recomputeDeletionSignature: (artefact: unknown) => string;
  /** THE binding the run's verdict comes out of. */
  deletionVerdictReading: (reply: unknown) => { verdict: string; lines: string[] };
}

/**
 * Slice the block out and run it.
 *
 * A failure to find it THROWS rather than returning an empty schema: a
 * comparison that could not be performed is UNMEASURED and never a pass, and
 * zero declared properties against zero carried fields is perfect agreement
 * (`.claude/rules/checks-must-be-able-to-fail.md`, third shape).
 */
function loadVerdictBlock(source: string): VerdictBlock {
  const start = source.indexOf(`// ──── ${BLOCK}-START ────`);
  const end = source.indexOf(`// ──── ${BLOCK}-END ────`);
  if (start < 0 || end < 0) {
    throw new Error(
      `the ${BLOCK} block is not in the source handed to this check — the schema the ` +
        `deleted-tests relay declares could not be read, which is UNMEASURED, not agreement (#684)`,
    );
  }
  const body = source.slice(start, end);
  return new Function(
    `${body}\nreturn { DELETION_VERDICT_SCHEMA, recomputeDeletionSignature, deletionVerdictReading }`,
  )() as VerdictBlock;
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
 * Every runtime type observed at every path, accumulated across artefacts.
 *
 * A SET per path, not a single type: `reason` is a string on an UNMEASURED
 * reading and null on the other two, and a walk that kept only the last would
 * report whichever artefact came last in the fixture list.
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
 * Every carried value whose runtime type the declaration does not admit.
 *
 * The path walk answers "is this field named in both shapes". A
 * structured-output schema is a FILTER, and a filter discriminates on TYPE as
 * well as on name — `{ type: 'string' }` over a value that is `null` is the
 * same silent drop one level down.
 *
 * Separated from the path comparison so it can be mutated on its own.
 */
function typeMismatches(schema: unknown, artefacts: unknown[]): string[] {
  const declared = schemaTypes(schema);
  const observed = new Map<string, Set<string>>();
  for (const artefact of artefacts) {
    for (const [path, types] of valueTypes(artefact)) {
      if (!observed.has(path)) observed.set(path, new Set());
      for (const t of types) observed.get(path)!.add(t);
    }
  }
  const out: string[] = [];
  for (const [path, types] of [...observed].sort(([a], [b]) => a.localeCompare(b))) {
    const admits = declared.get(path);
    // An undeclared path is the OTHER check's finding. Reporting it here too
    // would be two positions naming one defect, and the counts would then move
    // together under either mutation.
    if (admits === undefined) continue;
    for (const t of [...types].sort()) {
      if (!admits.includes(t)) {
        out.push(
          `the artefact carries \`${path}\` as \`${t}\` and the recommit-verify schema declares ` +
            `it as \`${admits.join(" | ")}\` — a structured-output schema filters on type as well ` +
            `as on name, so this value does not survive the relay (#684)`,
        );
      }
    }
  }
  return out;
}

/**
 * THE BINDING.
 *
 * Every field `scripts/verify-no-deleted-cases.ts` writes into
 * `deleted-cases.json` that `workflows/ship.js`'s declared reply schema would
 * drop on the way back through the recommit-verify agent — by NAME, because
 * the schema does not declare the path under `deletion`, or by TYPE, because
 * it declares one the value is not. One place to mutate, so a case can watch
 * the refusal stop refusing.
 *
 * Declared-but-unused is deliberately NOT a violation: `waived` and
 * `unusedWaivers` only exist on some readings and a schema is allowed to be
 * wider than any one reply. The direction that costs something is the other
 * one.
 */
export function deletionRelayViolations(shipSource: string, artefacts: unknown[]): string[] {
  const schema = loadVerdictBlock(shipSource).DELETION_VERDICT_SCHEMA as any;
  const declaredAll = schemaPaths(schema);
  if (declaredAll.length === 0) {
    throw new Error(
      "the recommit-verify schema declares no properties at all — nothing could be " +
        "compared, and zero against zero is agreement by vacuity (#684)",
    );
  }
  // The artefact travels under `deletion`, so the comparison is against that
  // sub-object's declaration and not against the whole reply. Searching the
  // whole document would let `commitSha` satisfy a claim about the artefact
  // (`.claude/rules/checks-must-be-able-to-fail.md`: search the slice).
  const deletionSchema = schema?.properties?.deletion;
  const declared = new Set(schemaPaths(deletionSchema));
  if (declared.size === 0) {
    throw new Error(
      "the recommit-verify schema declares no `deletion` object — the artefact the command " +
        "wrote has no position in the reply at all, which is the whole of #684",
    );
  }
  const carried = new Set<string>();
  for (const artefact of artefacts) for (const path of valuePaths(artefact)) carried.add(path);
  if (carried.size === 0) {
    throw new Error(
      "no artefact field was read — the fixtures produced nothing, so this measured the " +
        "instrument and not the relay (#684)",
    );
  }
  return [
    ...[...carried]
      .filter((path) => !declared.has(path))
      .sort()
      .map(
        (path) =>
          `the artefact carries \`${path}\` and the recommit-verify schema does not declare it — ` +
          `the agent relay drops undeclared fields, so it would never reach the operator (#684)`,
      ),
    ...typeMismatches(deletionSchema, artefacts),
  ];
}

// ── fixtures: artefacts produced by the real library ────────────────────────

const PREV = "1111111111111111111111111111111111111111";
const CUR = "2222222222222222222222222222222222222222";

const A = { file: "test/alpha.test.ts", name: "the baseline" };
const B = { file: "test/beta.test.ts", name: "the mutation row" };

const ledgerSaying = (passed: string[], failed: string[] = []): PassLedger => ({
  status: "MEASURED",
  passed,
  failed,
});
const UNREADABLE_LEDGER: PassLedger = {
  status: "UNMEASURED",
  reason: "no --ledger was given",
};

const artefactOf = (
  deleted: Array<{ file: string; name: string }>,
  ledger: PassLedger,
  waivers?: { cases: string[]; reason: string },
): DeletionArtefact =>
  deletionArtefact(deletionReading(deleted, ledger, waivers ?? { cases: [], reason: "" }), PREV, CUR);

/** Nothing was deleted at all. */
const cleanArtefact = (): DeletionArtefact => artefactOf([], ledgerSaying([A.name]));

/** A case the previous build commit proved green is gone. This is the defect. */
const deletedArtefact = (): DeletionArtefact => artefactOf([A], ledgerSaying([A.name]));

/** A deletion the operator accepted, over a case the ledger proved green. */
const waivedArtefact = (): DeletionArtefact =>
  artefactOf([A], ledgerSaying([A.name]), {
    cases: [`${A.file}${WAIVER_SEPARATOR}${A.name}`],
    reason: "the case moved to an integration suite",
  });

/** A waived deletion the ledger could never judge — the third state (SC-4). */
const waivedUnjudgedArtefact = (): DeletionArtefact =>
  artefactOf([A], UNREADABLE_LEDGER, {
    cases: [`${A.file}${WAIVER_SEPARATOR}${A.name}`],
    reason: "the case moved to an integration suite",
  });

/** A waiver that matched no deleted case. */
const staleWaiverArtefact = (): DeletionArtefact =>
  artefactOf([A], ledgerSaying([], [A.name]), {
    cases: [`${B.file}${WAIVER_SEPARATOR}${B.name}`],
    reason: "a deletion that is no longer there",
  });

/** The ledger could not say, so nothing establishes what left. */
const unmeasuredArtefact = (): DeletionArtefact => artefactOf([A, B], UNREADABLE_LEDGER);

function allArtefacts(): DeletionArtefact[] {
  return [
    cleanArtefact(),
    deletedArtefact(),
    waivedArtefact(),
    waivedUnjudgedArtefact(),
    staleWaiverArtefact(),
    unmeasuredArtefact(),
  ];
}

/** A whole reply, as the recommit-verify agent would return it. */
function replyFor(artefact: DeletionArtefact, restatement = artefact.verdict): Record<string, unknown> {
  return {
    commitSha: CUR,
    parentSha: PREV,
    stateRecorded: true,
    deletionVerdict: restatement,
    deletion: artefact,
  };
}

const read = (reply: unknown, source = SHIP) => loadVerdictBlock(source).deletionVerdictReading(reply);
const textOf = (reply: unknown, source = SHIP) => read(reply, source).lines.join("\n");

// ── the fixtures are real readings, not typed-in verdicts ───────────────────

describe("#684: every fixture's verdict came back from the real reading", () => {
  test("the artefacts carry the three verdicts and the three waiver states", () => {
    // Without this the cases below could all be about hand-written strings,
    // and a battery whose fixtures never reached a state measures nothing
    // past it.
    expect(cleanArtefact().verdict).toBe("CLEAN");
    expect(deletedArtefact().verdict).toBe("DELETED");
    expect(unmeasuredArtefact().verdict).toBe("UNMEASURED");

    const waived = waivedArtefact();
    expect(waived.verdict).toBe("CLEAN");
    expect(waived.waived?.map((w) => w.ledgerReading)).toEqual(["green"]);

    const unjudged = waivedUnjudgedArtefact();
    expect(unjudged.verdict).toBe("CLEAN");
    expect(unjudged.waived?.map((w) => w.ledgerReading)).toEqual(["unjudged"]);

    expect(staleWaiverArtefact().unusedWaivers?.length).toBe(1);
  });

  test("the script writes the artefact through the one composing binding", () => {
    // A second composition in the script would survive any mutation of the
    // library's and the signature would be computed over a different object
    // from the one on disk.
    const script = readFileSync(join(REPO_ROOT, "scripts", "verify-no-deleted-cases.ts"), "utf-8");
    expect((script.match(/deletionArtefact\(/g) ?? []).length).toBe(1);
    expect(script).toContain("--out");
  });
});

// ── one binding, and it is the only one ─────────────────────────────────────

describe("#684 SC-1: one binding turns the reply into the run's verdict", () => {
  test("the binding's definition appears exactly once in ship.js", () => {
    // A second reader would survive any mutation of the first and hold every
    // case below up while the real comparison was dead.
    expect((SHIP.match(/function deletionVerdictReading\(/g) ?? []).length).toBe(1);
    expect((SHIP.match(/function recomputeDeletionSignature\(/g) ?? []).length).toBe(1);
  });

  test("nothing else in ship.js reads the verdict off the reply", () => {
    // The pre-#684 line was `reCommit?.deletionVerdict || 'UNMEASURED'`. Any
    // surviving read of that field outside the binding is the defect, still
    // there, with a fix beside it.
    const block = SHIP.slice(
      SHIP.indexOf(`// ──── ${BLOCK}-START ────`),
      SHIP.indexOf(`// ──── ${BLOCK}-END ────`),
    );
    expect(block.length).toBeGreaterThan(0);
    const outside = SHIP.split(block).join("");
    expect(outside).not.toContain("deletionVerdict ||");
    expect(outside).not.toContain("reCommit?.deletionVerdict");
    expect(outside).not.toContain("reCommit.deletedCases");
  });

  test("the declared schema is the schema the agent call is handed", () => {
    // The schema could be declared perfectly and the call site could still
    // pass a second literal (#530).
    const callSite = SHIP.slice(SHIP.indexOf("label: 'recommit-verify'"));
    expect(callSite.slice(0, 400)).toContain("schema: DELETION_VERDICT_SCHEMA");
    expect((SHIP.match(/label: 'recommit-verify'/g) ?? []).length).toBe(1);
    expect((SHIP.match(/const DELETION_VERDICT_SCHEMA = /g) ?? []).length).toBe(1);
  });

  test("the binding's definition appears exactly once in this file", () => {
    expect((SELF.match(/export function deletionRelayViolations\(/g) ?? []).length).toBe(1);
    expect((SELF.match(/^export /gm) ?? []).length).toBe(1);
  });

  test("a source with no verdict block refuses rather than reporting agreement", () => {
    expect(() => deletionRelayViolations("// nothing here", allArtefacts())).toThrow(
      /UNMEASURED, not agreement/,
    );
  });

  test("an empty artefact set refuses rather than reporting agreement", () => {
    expect(() => deletionRelayViolations(SHIP, [])).toThrow(/measured the instrument/);
  });
});

// ── SC-1/SC-3: every artefact field survives the relay ──────────────────────

describe("#684 SC-1: the schema declares every field the artefact carries", () => {
  test("no field of any real artefact is dropped by the relay", () => {
    expect(deletionRelayViolations(SHIP, allArtefacts())).toEqual([]);
  });

  test("the fixtures really reach the waiver fields, so the case above is not vacuous", () => {
    const carried = new Set(allArtefacts().flatMap((a) => valuePaths(a)));
    for (const field of ["file", "name", "ledgerReading", "acceptedReason"]) {
      expect(carried.has(`waived[].${field}`)).toBe(true);
    }
    for (const field of ["file", "name"]) expect(carried.has(`cases[].${field}`)).toBe(true);
    expect(carried.has("unusedWaivers")).toBe(true);
    expect(carried.has("signature")).toBe(true);
    expect(carried.has("reason")).toBe(true);
  });

  for (const field of ["verdict", "cases", "waived", "unusedWaivers", "signature", "reason"]) {
    test(`removing \`${field}\` from the declaration turns this red`, () => {
      const artefacts = allArtefacts();
      // Both halves in one case: "the real source agrees" and "the mutant does
      // not" are the same claim read in two directions, and a case asserting
      // only the second passes over a binding that refuses everything.
      expect(deletionRelayViolations(SHIP, artefacts)).toEqual([]);
      const mutant = withoutDeletionField(field);
      expect(deletionRelayViolations(mutant, artefacts).join("\n")).toContain(`\`${field}\``);
    });
  }

  test("`reason` is declared nullable, and a null really travels", () => {
    // `string | null` is only a distinction if a null travels. A declaration
    // of `{ type: 'string' }` would agree with every artefact whose reading
    // happened to be UNMEASURED.
    const observed = new Set<string>();
    for (const a of allArtefacts()) for (const t of valueTypes(a).get("reason") ?? []) observed.add(t);
    expect(observed.has("null")).toBe(true);
    expect(observed.has("string")).toBe(true);

    const narrowed = SHIP.replace(
      /reason: \{ type: \['string', 'null'\] \}/,
      "reason: { type: 'string' }",
    );
    expect(narrowed).not.toBe(SHIP);
    const violations = deletionRelayViolations(narrowed, allArtefacts());
    expect(violations.join("\n")).toContain("as `null`");
  });
});

/** Drop one declared property line from the `deletion` object, by name. */
function withoutDeletionField(field: string): string {
  const start = SHIP.indexOf("const DELETION_VERDICT_SCHEMA = ");
  const end = SHIP.indexOf(`// ──── ${BLOCK}-END ────`);
  if (start < 0 || end < 0) throw new Error("the schema literal is not in ship.js — nothing was mutated");
  const region = SHIP.slice(start, end);
  // The back-reference closes the property at its OWN indentation, so the
  // first deeper `}` inside it cannot end the match and leave a half-deleted
  // literal — a mutant that does not parse measures that the file still
  // parses (#485).
  const block = new RegExp(`^([ \\t]*)${field}: \\{[\\s\\S]*?^\\1\\},?\\n`, "m");
  const oneLine = new RegExp(`^ *${field}: .*\\n`, "m");
  const pattern = block.test(region) ? block : oneLine;
  if (!pattern.test(region)) {
    throw new Error(`the schema declaration has no \`${field}\` to remove — nothing was mutated (#485)`);
  }
  return SHIP.slice(0, start) + region.replace(pattern, "") + SHIP.slice(end);
}

// ── SC-3: the two signature implementations are compared, not assumed ───────

describe("#684 SC-3: ship.js's recomputation agrees with the script's", () => {
  test("the matrix varies, so the parity below is over more than one shape", () => {
    const signatures = new Set(allArtefacts().map((a) => a.signature));
    expect(signatures.size).toBe(allArtefacts().length);
  });

  test("the script really emits a non-empty signature, so agreement is not two silences", () => {
    for (const a of allArtefacts()) {
      expect(typeof a.signature).toBe("string");
      expect(a.signature.startsWith("v1:")).toBe(true);
    }
  });

  test("ship.js agrees with the library over every shape", () => {
    // `workflows/ship.js` cannot import (#69), so the signature is computed in
    // two positions. This is the comparison that makes that safe — the shape
    // #171 uses for `rookScopeCommand` and #663 for `receiptSignature`.
    const recompute = loadVerdictBlock(SHIP).recomputeDeletionSignature;
    for (const a of allArtefacts()) expect(recompute(a)).toBe(deletionSignature(a));
  });

  test("every field the operator line prints is covered by the signature", () => {
    // The rule, driven rather than written down: anything printed as evidence
    // is in the signature, or it is not printed as evidence.
    const base = deletedArtefact();
    const recompute = loadVerdictBlock(SHIP).recomputeDeletionSignature;
    const perturbations: Array<[string, DeletionArtefact]> = [
      ["verdict", { ...base, verdict: "CLEAN" }],
      ["cases (membership)", { ...base, cases: [B] }],
      ["cases (count)", { ...base, cases: [A, B] }],
      ["reason", { ...base, reason: "something else entirely" }],
      [
        "waived",
        { ...base, waived: [{ ...A, acceptedReason: "because", ledgerReading: "green" }] },
      ],
      [
        "waived.ledgerReading",
        { ...base, waived: [{ ...A, acceptedReason: "because", ledgerReading: "unjudged" }] },
      ],
      [
        "waived.acceptedReason",
        { ...base, waived: [{ ...A, acceptedReason: "a different reason", ledgerReading: "green" }] },
      ],
      ["unusedWaivers", { ...base, unusedWaivers: [`${B.file}${WAIVER_SEPARATOR}${B.name}`] }],
    ];
    const baseline = deletionSignature(base);
    for (const [field, perturbed] of perturbations) {
      expect(deletionSignature(perturbed), `altering ${field} left the signature unchanged`)
        .not.toBe(baseline);
      expect(recompute(perturbed), `ship.js disagrees about ${field}`).toBe(deletionSignature(perturbed));
    }
  });

  test("a swapped member changes the signature, not just a different count", () => {
    // `cases` and `unusedWaivers` are lists the operator line prints by name,
    // and a count-based signature calls these two artefacts identical
    // (`.claude/rules/checks-must-be-able-to-fail.md` on #532).
    const base = deletedArtefact();
    expect(deletionSignature({ ...base, cases: [A] })).not.toBe(
      deletionSignature({ ...base, cases: [B] }),
    );
  });
});

// ── SC-3: THE DISTINGUISHING INPUT ──────────────────────────────────────────

describe("#684 SC-3: a reply claiming CLEAN beside an artefact saying DELETED", () => {
  test("the reading is UNMEASURED and the disagreement is named with both values", () => {
    // THE case. Before #684 this reply produced `CLEAN` and the run walked on:
    // `const deletionVerdict = reCommit?.deletionVerdict || 'UNMEASURED'`.
    // A fixture where the two AGREE is satisfied by the old reader and the new
    // one alike and measures nothing.
    const artefact = deletedArtefact();
    expect(artefact.verdict).toBe("DELETED");
    const reading = read(replyFor(artefact, "CLEAN"));
    expect(reading.verdict).toBe("UNMEASURED");
    const text = reading.lines.join("\n");
    expect(text).toContain("DELETION_VERDICT_DISAGREEMENT");
    // BOTH values, by name. A message naming only one of them asserts which
    // side is right, and that is not knowable from here.
    expect(text).toContain("CLEAN");
    expect(text).toContain("DELETED");
  });

  test("the same reply with the restatement honest is DELETED, not UNMEASURED", () => {
    // The control. Without it the case above is satisfied by a binding that
    // reports UNMEASURED for everything.
    const reading = read(replyFor(deletedArtefact()));
    expect(reading.verdict).toBe("DELETED");
    expect(reading.lines.join("\n")).not.toContain("DISAGREEMENT");
    expect(reading.lines.join("\n")).toContain("REPAIR_DELETED_TESTS");
  });

  test("an artefact edited to say CLEAN while the token is copied verbatim is UNMEASURED", () => {
    // Door 2 from the other side: the agent runs the command, reads DELETED,
    // and rewrites the artefact fields rather than the one-word restatement.
    // The signature it copied was computed over what the script wrote.
    const real = deletedArtefact();
    const forged = { ...real, verdict: "CLEAN" as const, cases: [] };
    const reading = read(replyFor(forged, "CLEAN"));
    expect(reading.verdict).toBe("UNMEASURED");
    const text = reading.lines.join("\n");
    expect(text).toContain("DELETION_SIGNATURE_DISAGREEMENT");
    expect(text).toContain(real.signature);
    expect(text).toContain(loadVerdictBlock(SHIP).recomputeDeletionSignature(forged));
  });

  test("the disagreement is resolved in favour of NEITHER side", () => {
    // Preferring the relayed value is the defect; preferring the recomputed
    // one asserts the fields are right and only the token is wrong, which is
    // the same assumption pointed the other way.
    const real = deletedArtefact();
    const forged = { ...real, verdict: "CLEAN" as const, cases: [] };
    const reading = read(replyFor(forged, "CLEAN"));
    expect(reading.verdict).not.toBe("CLEAN");
    expect(reading.verdict).not.toBe("DELETED");
    expect(reading.verdict).toBe("UNMEASURED");
  });
});

// ── SC-2: absent or unparseable is UNMEASURED and never CLEAN ───────────────

describe("#684 SC-2: an absent or unreadable artefact reading is UNMEASURED", () => {
  const neverClean = (reply: unknown, fragment: string) => {
    const reading = read(reply);
    expect(reading.verdict).toBe("UNMEASURED");
    expect(reading.lines.join("\n")).toContain(fragment);
  };

  test("a reply carrying no deletion object at all", () => {
    // Exactly what a relay that dropped the field delivers, and exactly what a
    // step that never ran the command produces.
    neverClean({ commitSha: CUR, parentSha: PREV, stateRecorded: true }, "no deleted-cases reading");
  });

  test("a reply whose deletion object carries no signature", () => {
    const { signature: _dropped, ...stripped } = deletedArtefact();
    expect(_dropped).toBeTruthy();
    neverClean(
      { ...replyFor(deletedArtefact()), deletion: stripped },
      "carried no signature",
    );
  });

  test("a reply whose verdict is a word the script cannot emit", () => {
    const real = cleanArtefact();
    neverClean(replyFor({ ...real, verdict: "PARTIAL" as any }, "PARTIAL" as any), "PARTIAL");
  });

  test("a reply that is null", () => {
    neverClean(null, "no deleted-cases reading");
  });

  test("the empty reply is not reported as a clean round", () => {
    // The sentence the pre-#684 code produced for an absent verdict was the
    // same one it produced for a measured UNMEASURED, so an operator could not
    // tell "nothing ran" from "something ran and could not judge".
    const absent = textOf({ commitSha: CUR, parentSha: PREV, stateRecorded: true });
    const measured = textOf(replyFor(unmeasuredArtefact()));
    expect(absent).not.toBe(measured);
    expect(absent).not.toContain("DELETION_CLEAN");
  });
});

// ── SC-4: the three waiver states log distinctly ────────────────────────────

describe("#684 SC-4: CLEAN, CLEAN-by-waiver and waived-unjudged are different records", () => {
  test("a CLEAN reached by deleting nothing says so and names no waiver", () => {
    const reading = read(replyFor(cleanArtefact()));
    expect(reading.verdict).toBe("CLEAN");
    expect(reading.lines.join("\n")).toContain("DELETION_CLEAN");
    expect(reading.lines.join("\n")).not.toContain("WAIVER");
  });

  test("a CLEAN reached by waiving logs distinctly, with the reason and the ledger", () => {
    const reading = read(replyFor(waivedArtefact()));
    expect(reading.verdict).toBe("CLEAN");
    const text = reading.lines.join("\n");
    expect(text).toContain("DELETION_CLEAN_BY_WAIVER");
    expect(text).toContain("the case moved to an integration suite");
    expect(text).toContain("green");
    expect(text).not.toContain("DELETION_WAIVED_UNJUDGED");
  });

  test("a waived case the ledger could not judge logs distinctly again", () => {
    const text = textOf(replyFor(waivedUnjudgedArtefact()));
    expect(text).toContain("DELETION_CLEAN_BY_WAIVER");
    expect(text).toContain("DELETION_WAIVED_UNJUDGED");
  });

  test("the three CLEANs are three different records", () => {
    // The pre-#684 run printed nothing at all for any of them: the only branch
    // was `if (deletionVerdict !== 'CLEAN')`. Asserted as a set so a later
    // simplification that folds two of them together has something to go red.
    const records = new Set([
      textOf(replyFor(cleanArtefact())),
      textOf(replyFor(waivedArtefact())),
      textOf(replyFor(waivedUnjudgedArtefact())),
    ]);
    expect(records.size).toBe(3);
  });

  test("a waiver that matched nothing is reported, and does not make the round clean", () => {
    const text = textOf(replyFor(staleWaiverArtefact()));
    expect(text).toContain("DELETION_STALE_WAIVER");
    expect(text).toContain(B.name);
  });

  test("a measured UNMEASURED names the cases and the reason the ledger gave", () => {
    const artefact = unmeasuredArtefact();
    const reading = read(replyFor(artefact));
    expect(reading.verdict).toBe("UNMEASURED");
    const text = reading.lines.join("\n");
    expect(text).toContain("REPAIR_DELETED_TESTS");
    expect(text).toContain(A.name);
    expect(text).toContain(B.name);
  });
});
