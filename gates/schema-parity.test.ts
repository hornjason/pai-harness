import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

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
    "daDirectEdits", "iterationCount", "startTs", "updatedTs", "phaseTimings",
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
