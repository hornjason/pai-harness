import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { THRESHOLD_OPS, EVIDENCE_METHOD_TYPES, SUITE_MEASUREMENT_FIELDS } from "./schema";
import { parseTestResults } from "./run-gate";
import { stripJsComments } from "../lib/strip-js-comments";

const GATES_DIR = __dirname;
const V2_SCHEMA_PATH = join(GATES_DIR, "..", "config", "workflow-schema.json");
const V3_SCHEMA_PATH = join(GATES_DIR, "schema.ts");

function extractJsonSchemaPaths(obj: any, prefix = ""): string[] {
  const paths: string[] = [];
  if (!obj || typeof obj !== "object") return paths;

  if (obj.properties) {
    for (const [key, val] of Object.entries(obj.properties)) {
      const path = prefix ? `${prefix}.${key}` : key;
      paths.push(path);
      if ((val as any).properties) {
        paths.push(...extractJsonSchemaPaths(val, path));
      }
      if ((val as any).items?.properties) {
        paths.push(...extractJsonSchemaPaths((val as any).items, `${path}[]`));
      }
    }
  }
  return paths;
}

function extractZodFields(source: string): string[] {
  const fields: string[] = [];
  const patterns = [
    /(\w+):\s*z\./g,
    /(\w+):\s*(?:Agent|Environment|GateResult|SourceSpec|Threshold|EvidenceMethod|Evidence|ContextFile|Changelog|PhaseTiming)/g,
  ];
  for (const p of patterns) {
    for (const m of source.matchAll(p)) {
      fields.push(m[1]);
    }
  }
  return [...new Set(fields)];
}

describe("schema parity: v2 JSON Schema vs v3 Zod", () => {
  const v2 = JSON.parse(readFileSync(V2_SCHEMA_PATH, "utf-8"));
  const v3Source = readFileSync(V3_SCHEMA_PATH, "utf-8");

  const v2Paths = extractJsonSchemaPaths(v2);
  const v3Fields = extractZodFields(v3Source);

  const V2_TOP_LEVEL = [
    "schemaVersion", "issue", "repo", "issueRepo", "projectRoot", "slug", "phase",
    "issueGoal", "sourceSpecs", "sizing", "acs", "agents", "environments", "gates",
    "iterationCount", "startTs", "updatedTs", "phaseTimings",
    "gateContract", "changelog",
  ];

  for (const field of V2_TOP_LEVEL) {
    test(`v2 top-level field "${field}" exists in v3 Zod schema`, () => {
      expect(v3Source).toContain(field);
    });
  }

  const V2_SIZING = ["predicted", "ceremonyTier", "actualFiles", "actualMinutes"];
  for (const field of V2_SIZING) {
    test(`v2 sizing.${field} exists in v3`, () => {
      expect(v3Source).toContain(field);
    });
  }

  const V2_AC_FIELDS = ["id", "type", "statement", "specElement", "threshold", "evidenceMethod", "contextFiles", "evidence", "verdict"];
  for (const field of V2_AC_FIELDS) {
    test(`v2 acs[].${field} exists in v3 ACSchema`, () => {
      expect(v3Source).toContain(field);
    });
  }

  const V2_AGENT_FIELDS = ["spawned", "verdict", "branch", "iterations", "comparedToSpec", "screenshots", "findings"];
  for (const field of V2_AGENT_FIELDS) {
    test(`v2 agents.*.${field} exists in v3 AgentSchema`, () => {
      expect(v3Source).toContain(field);
    });
  }

  const V2_ENV_LOCAL = ["api", "apiSkipReason", "ui", "uiSkipReason", "tests"];
  for (const field of V2_ENV_LOCAL) {
    test(`v2 environments.local.${field} exists in v3`, () => {
      expect(v3Source).toContain(field);
    });
  }

  const V2_ENV_PROD = ["rebuild", "rebuildSkipReason", "smoke", "smokeSkipReason", "quinn", "quinnSkipReason", "quinnSpot", "quinnSpotSkipReason"];
  for (const field of V2_ENV_PROD) {
    test(`v2 environments.prod.${field} exists in v3`, () => {
      expect(v3Source).toContain(field);
    });
  }

  const V2_GATE = ["result", "attempt", "failures", "ts"];
  for (const field of V2_GATE) {
    test(`v2 gates.*.${field} exists in v3 GateResultSchema`, () => {
      expect(v3Source).toContain(field);
    });
  }

  const V2_EVIDENCE_METHOD_TYPES = ["GREP_CHECK", "FILE_EXISTS", "CURL_CHECK", "BUN_TEST", "SCREENSHOT", "PLAYWRIGHT", "COMMAND", "MANUAL"];
  for (const t of V2_EVIDENCE_METHOD_TYPES) {
    test(`v2 evidenceMethod.type "${t}" in v3 enum`, () => {
      expect(v3Source).toContain(t);
    });
  }

  const V2_THRESHOLD_OPS = ["==", ">=", "<=", ">", "<", "!=", "contains", "exists"];
  for (const op of V2_THRESHOLD_OPS) {
    test(`v2 threshold.op "${op}" in v3 enum`, () => {
      expect(v3Source).toContain(`"${op}"`);
    });
  }

  test("v2 phase CIRCUIT_BREAK in v3 enum", () => {
    expect(v3Source).toContain("CIRCUIT_BREAK");
  });

  test("v2 verdict PENDING in v3 ACSchema", () => {
    expect(v3Source).toContain("PENDING");
  });

  const V2_BASELINES = ["testBaseline", "tscBaseline"];
  for (const field of V2_BASELINES) {
    test(`v2 gateContract.baselines.${field} exists in v3`, () => {
      expect(v3Source).toContain(field);
    });
  }

  const V2_CHANGELOG = ["event", "detail", "actor"];
  for (const field of V2_CHANGELOG) {
    test(`v2 changelog[].${field} exists in v3`, () => {
      expect(v3Source).toContain(field);
    });
  }

  test("v2 phaseTimings entry fields in v3", () => {
    expect(v3Source).toContain("enteredTs");
    expect(v3Source).toContain("exitedTs");
    expect(v3Source).toContain("iteration");
  });
});

const v3SourceForSuite = readFileSync(V3_SCHEMA_PATH, "utf-8");

describe("#224: suiteMeasurement — schema and SCHEMA-GUIDE.md describe the same shape", () => {
  const guide = readFileSync(join(GATES_DIR, "SCHEMA-GUIDE.md"), "utf-8");

  /** The field names in the guide's `## suiteMeasurement` table. */
  const documented = (() => {
    const start = guide.indexOf("## suiteMeasurement");
    const body = start === -1 ? "" : guide.slice(start, guide.indexOf("\n## ", start + 1));
    return body
      .split("\n")
      .filter(line => /^\|\s*`/.test(line))
      .map(line => line.match(/^\|\s*`([^`]+)`/)![1]);
  })();

  test("the guide has a suiteMeasurement section with a field table", () => {
    expect(guide).toContain("## suiteMeasurement");
    expect(documented.length, "no `field` rows found under ## suiteMeasurement").toBeGreaterThan(0);
  });

  // Both directions. A field added to the Zod schema and left undocumented
  // turns the first list red; a field documented but never implemented turns
  // the second red. One direction alone is a check that passes because of
  // what it never looked at.
  test("every schema field is documented", () => {
    expect([...SUITE_MEASUREMENT_FIELDS].sort()).toEqual([...documented].sort());
  });

  test("the guide states the rule the schema enforces: absent means UNMEASURED", () => {
    expect(guide).toContain("UNMEASURED");
    expect(guide).toMatch(/measuredSha/);
  });

  test("the v3 Zod schema carries the measurement on the workflow state", () => {
    expect(v3SourceForSuite).toContain("suiteMeasurement: SuiteMeasurementSchema");
    // UNMEASURED is the reader's answer to an absent record, not a writable
    // verdict — a schema that accepted it would give a caller a way to park an
    // unmeasured run in the field that proves the suite ran.
    // PARTIAL joined it in #673 and is not a third result: it says the
    // reading was taken over less than the suite, and readSuiteMeasurement
    // turns it into UNMEASURED for every consumer.
    expect(v3SourceForSuite).toContain('verdict: z.enum(["PASS", "FAIL", "PARTIAL"])');
  });
});

describe("GI-1: gate failure detail includes Zod error paths", () => {
  // Fixture corrected 2026-10-11 (#314). It previously placed the Zod errors
  // AFTER the `(fail)` line, which is not how bun prints: the source excerpt,
  // error and stack all precede their own marker. Probed against bun 1.3.14.
  // The test's intent is unchanged and still the point — the detail must carry
  // the Zod path, not the literal string "failed". Only the ordering was wrong,
  // and it was wrong in the same direction as the parser it was testing, so the
  // two agreed with each other and not with bun.
  test("parseTestResults captures a failure's own Zod error paths as its detail", () => {
    const bunOutput = [
      "(pass) schema validation > acs-exist: at least one AC",
      "  acs.0.threshold.op: Invalid enum value. Expected '==' | '>=' | '<=' | '>' | '<' | '!=' | 'contains' | 'exists', received 'equals'",
      "  acs.1.statement: AC-2: statement too short (3 words, min 5)",
      "(fail) schema validation > workflow-state.json validates (includes threshold + behavioral superRefine)",
      "(pass) scope checks > sizing-declared",
    ].join("\n");
    const results = parseTestResults(bunOutput);
    const fail = results.find(r => r.result === "FAIL");
    expect(fail).toBeTruthy();
    expect(fail!.detail).toContain("Invalid enum value");
    expect(fail!.detail).toContain("acs.0.threshold.op");
    expect(fail!.detail).not.toBe("failed");
  });

  test("SC-1860: a failure the parser cannot explain says so, and names the parser", () => {
    // Revised from "falls back to 'failed'" (#550). That case documented the
    // fallback as acceptable, and it is not: `detail: "failed"` is a refusal
    // with no reason, in the field a heal prompt reads. It also reads like
    // data the runner produced rather than like the parser giving up, which
    // is the distinction that sent #530's first pass to the wrong file.
    //
    // The behaviour is unchanged — the parser still has nothing to say here.
    // What changed is that it says which component had nothing to say.
    const bunOutput = [
      "(fail) some-check",
      "(pass) another-check",
    ].join("\n");
    const results = parseTestResults(bunOutput);
    const fail = results.find(r => r.result === "FAIL");
    expect(fail!.detail, "a bare 'failed' is a refusal with no reason").not.toBe("failed");
    expect(fail!.detail).toContain("parseTestResults");
    // Named so a reader goes to the parser rather than to the check.
    expect(fail!.detail).toContain("no explanation");
  });
});

// ── #550: bun prints a timeout's reason AFTER its marker ──────────────────

/**
 * Covers SC-1858, SC-1859 (HARNESS-STANDARD.md), #550.
 *
 * Every other failure bun prints puts its excerpt, error and stack BEFORE the
 * `(fail)` line, which is why #314 made the detail scan backward. A TIMEOUT
 * is the exception: the marker comes first and the explanation follows it. So
 * the backward scan from the NEXT failure walks straight over it, and the
 * timed-out test is left with nothing.
 *
 * Observed on `/Users/jhorn/.rungate/.../workflow-state.json`: `tsc-pass`
 * recorded `detail: "failed"` while the following check's detail OPENED with
 * `^ this test timed out after 5000ms.` — a diagnosis of a different check,
 * which is how it was first read.
 */
describe("#550: a timed-out failure keeps its own explanation", () => {
  // CAPTURED, not imagined. Run on bun 1.3.14 over a file with one test given
  // a 300ms budget and a 2000ms body, followed by an ordinary failure. The
  // literal below is that run's output with the temp paths shortened; the
  // ORDER — marker, timeout line, then the next failure's excerpt — is the
  // whole subject and is reproduced exactly.
  const CAPTURED = [
    "bun test v1.3.14 (d1632b29)",
    "",
    "x.test.ts:",
    "(fail) a slow one [302.03ms]",
    "  ^ this test timed out after 300ms.",
    '1 | import { test, expect } from "bun:test";',
    '2 | test("a slow one", async () => { await new Promise(r => setTimeout(r, 2000)); }, 300);',
    '3 | test("an ordinary failure", () => { expect(1).toBe(2); });',
    "                                                  ^",
    "error: expect(received).toBe(expected)",
    "",
    "Expected: 2",
    "Received: 1",
    "",
    "      at <anonymous> (/tmp/x.test.ts:3:47)",
    "(fail) an ordinary failure [0.47ms]",
  ].join("\n");

  test("SC-1858: the timed-out test's detail is its own timeout line", () => {
    const results = parseTestResults(CAPTURED);
    const timedOut = results.find(r => r.check === "a slow one");
    expect(timedOut, "the timed-out failure was not parsed at all").toBeTruthy();
    expect(timedOut!.result).toBe("FAIL");
    expect(timedOut!.detail, "the timed-out check still records a refusal with no reason")
      .toContain("timed out after 300ms");
  });

  test("SC-1859: the following failure does not acquire it", () => {
    // The half that cost the time. A detail opening with another check's
    // timeout reads like a diagnosis of this one.
    const results = parseTestResults(CAPTURED);
    const next = results.find(r => r.check === "an ordinary failure");
    expect(next, "the following failure was not parsed").toBeTruthy();
    expect(next!.detail, "the next failure inherited the previous one's timeout line")
      .not.toContain("timed out after");
    // And it keeps its own, so the fix is a reattribution rather than a
    // deletion — without this a parser that dropped every timeout line
    // satisfies the assertion above.
    expect(next!.detail).toContain("expect(received).toBe(expected)");
    expect(next!.detail).toContain("Expected: 2");
  });

  test("SC-1863: no other producer assigns a bare failed as a detail", () => {
    // SC-1860 is about the one producer this repo has today. This is the
    // reintroduction guard: a second place writing `detail: "failed"` would
    // put a reasonless refusal back in the state file while SC-1860 stayed
    // green, because SC-1860 only ever drives `parseTestResults`.
    //
    // Comments are stripped first — this file and gate-executor.ts both
    // DISCUSS the old string on purpose, and a comment reciting what was
    // removed is not evidence it is still there.
    // THIS FILE is the one exclusion, and it is not an exemption list: the
    // instrument below has to quote the forbidden string to prove the
    // pattern still matches, and on the first run the check caught itself
    // doing so. The exclusion is one named file — the scanner — rather than
    // a list anybody can add to, and `workflow.test.ts` and every other
    // file in gates/ stay in scope.
    const SELF = "schema-parity.test.ts";
    const offenders: string[] = [];
    for (const name of readdirSync(GATES_DIR).filter(f => f.endsWith(".ts") && f !== SELF)) {
      const code = stripJsComments(readFileSync(join(GATES_DIR, name), "utf-8"));
      code.split("\n").forEach((line, i) => {
        if (/\bdetail:\s*["'`]failed["'`]/.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, `a reasonless refusal detail is back:\n${offenders.join("\n")}`).toEqual([]);

    // The instrument, twice over: the pattern matches when the string is
    // there, and the scan really did read the files rather than skipping
    // them all.
    expect(/\bdetail:\s*["'`]failed["'`]/.test('  results.push({ detail: "failed" })')).toBe(true);
    expect(
      readdirSync(GATES_DIR).filter(f => f.endsWith(".ts") && f !== SELF).length,
      "the scan found no files to read",
    ).toBeGreaterThan(3);
  });

  test("SC-1861: an ordinary failure's backward scan is unchanged", () => {
    // The control for the control. The timeout line is a new stopping
    // condition in the backward scan, and a stopping condition that fires too
    // eagerly truncates every ordinary detail — which would be invisible,
    // because a shorter detail is still a detail.
    const ordinary = [
      "(pass) first-check",
      "  acs.0.threshold.op: Invalid enum value",
      "  acs.1.statement: AC-2: statement too short",
      "(fail) second-check",
    ].join("\n");
    const fail = parseTestResults(ordinary).find(r => r.result === "FAIL");
    expect(fail!.detail).toContain("Invalid enum value");
    expect(fail!.detail).toContain("statement too short");
  });
});

describe("GI-5: DISCOVERY_SCHEMA enum parity with schema.ts", () => {
  const shipSource = readFileSync(join(GATES_DIR, "..", "workflows", "ship.js"), "utf-8");

  test("DISCOVERY_SCHEMA threshold.op has enum matching THRESHOLD_OPS", () => {
    const opEnumMatch = shipSource.match(/op:\s*\{\s*type:\s*'string'\s*,\s*enum:\s*\[([^\]]+)\]/);
    expect(opEnumMatch, "threshold.op must have enum constraint in DISCOVERY_SCHEMA").toBeTruthy();
    const ops = opEnumMatch![1].split(",").map(s => s.trim().replace(/'/g, ""));
    expect(ops.sort()).toEqual([...THRESHOLD_OPS].sort());
  });

  test("DISCOVERY_SCHEMA evidenceMethod.type has enum matching EVIDENCE_METHOD_TYPES", () => {
    const discoveryBlock = shipSource.slice(
      shipSource.indexOf("const DISCOVERY_SCHEMA"),
      shipSource.indexOf("const DISCOVERY_SCHEMA") + 3000
    );
    const evidenceMethodMatch = discoveryBlock.match(/evidenceMethod:\s*\{[^}]*properties:\s*\{[^}]*type:\s*\{\s*type:\s*'string'\s*,\s*enum:\s*\[([^\]]+)\]/s);
    expect(evidenceMethodMatch, "evidenceMethod.type must have enum constraint in DISCOVERY_SCHEMA").toBeTruthy();
    const types = evidenceMethodMatch![1].split(",").map(s => s.trim().replace(/'/g, ""));
    expect(types.sort()).toEqual([...EVIDENCE_METHOD_TYPES].sort());
  });
});
