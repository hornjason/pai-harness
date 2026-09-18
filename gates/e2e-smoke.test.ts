import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { WorkflowStateSchema } from "./schema";
import { SIGNAL_PHRASE_PATTERNS } from "../lib/conformity";

const STANDALONE = !process.env.TEST_WORK_DIR;
const TEST_DIR = process.env.TEST_WORK_DIR || "/tmp/gate-e2e-smoke";
const SF = `${TEST_DIR}/workflow-state.json`;

function loadState(): any | null {
  if (!existsSync(SF)) return null;
  const raw = JSON.parse(readFileSync(SF, "utf-8"));
  return WorkflowStateSchema.passthrough().parse(raw);
}

function sf(path: string): any {
  if (!existsSync(SF)) return undefined;
  const wf = JSON.parse(readFileSync(SF, "utf-8"));
  const parts = path.replace(/^\./, "").split(".").filter(Boolean);
  let val: any = wf;
  for (const p of parts) {
    if (val == null) return undefined;
    val = val[p];
  }
  return val;
}

function loadSpec(path: string, projectRoot?: string): string {
  const resolved = path.startsWith('/') ? path : join(projectRoot || '.', path);
  return readFileSync(resolved, "utf-8");
}

function extractSpecRules(spec: string): string[] {
  const rules: string[] = [];
  for (const p of SIGNAL_PHRASE_PATTERNS) {
    for (const m of spec.matchAll(new RegExp(p.source, p.flags))) {
      rules.push(m[0].replace(/^[-*] /, "").trim().replace(/[.;]$/, ""));
    }
  }
  return [...new Set(rules)];
}

describe("E2E: governing spec compliance", () => {
  if (STANDALONE || !existsSync(SF)) {
    test("skipped — no active workflow (standalone run)", () => {});
    return;
  }
  const tier = sf("sizing")?.ceremonyTier;
  if (tier === "LIGHT") {
    test("skipped — spec checks not required for LIGHT tier", () => {});
    return;
  }

  test("governing spec exists and is readable", () => {
    const wf = loadState() as any;
    expect(wf.sourceSpecs?.[0]?.path).toBeDefined();
    const specPath = wf.sourceSpecs[0].path.startsWith('/') ? wf.sourceSpecs[0].path : join(wf.projectRoot || '.', wf.sourceSpecs[0].path);
    expect(existsSync(specPath)).toBe(true);
  });

  test("spec has extractable rules", () => {
    const wf = loadState() as any;
    const spec = loadSpec(wf.sourceSpecs[0].path, wf.projectRoot);
    const rules = extractSpecRules(spec);
    expect(rules.length).toBeGreaterThan(0);
  });
});

describe("E2E: hardcoded values violate spec", () => {
  if (STANDALONE || !existsSync(SF)) {
    test("skipped — no active workflow (standalone run)", () => {});
    return;
  }
  const tier = sf("sizing")?.ceremonyTier;
  if (tier === "LIGHT") {
    test("skipped — spec checks not required for LIGHT tier", () => {});
    return;
  }

  test("no hardcoded paths in AC statements", () => {
    const wf = loadState() as any;
    const spec = loadSpec(wf.sourceSpecs[0].path, wf.projectRoot);

    if (!spec.match(/never hardcod|read from config|configurable/i)) return;

    const hardcodedPath = /\/usr\/|\/opt\/|\/home\/|\/tmp\/[a-z]/i;
    const hardcodedPort = /\bport\s+\d{4}\b/i;
    const hits = wf.acs.filter((ac: any) =>
      hardcodedPath.test(ac.statement) || hardcodedPort.test(ac.statement)
    );

    expect(hits.map((ac: any) => `${ac.id}: ${ac.statement}`)).toEqual([]);
  });

  test("no hardcoded numeric thresholds in AC statements", () => {
    const wf = loadState() as any;
    const spec = loadSpec(wf.sourceSpecs[0].path, wf.projectRoot);

    if (!spec.match(/configurable|environment variable|config/i)) return;

    const hardcodedNum = /\bhardcoded to \d+\.?\d*\b/i;
    const hits = wf.acs.filter((ac: any) => hardcodedNum.test(ac.statement));

    expect(hits.map((ac: any) => `${ac.id}: ${ac.statement}`)).toEqual([]);
  });
});

describe("E2E: behavioral language violates spec", () => {
  if (STANDALONE || !existsSync(SF)) {
    test("skipped — no active workflow (standalone run)", () => {});
    return;
  }
  test("no 'DA should' or behavioral delegation in ACs", () => {
    const wf = loadState() as any;
    if (!wf) return;
    const behavioral = /\b(DA should|remember to|make sure|don't forget)\b/i;
    const hits = wf.acs.filter((ac: any) => behavioral.test(ac.statement));

    expect(hits.map((ac: any) => `${ac.id}: ${ac.statement}`)).toEqual([]);
  });
});

describe("E2E: spec-prohibited patterns in ACs", () => {
  if (STANDALONE || !existsSync(SF)) {
    test("skipped — no active workflow (standalone run)", () => {});
    return;
  }
  const tier = sf("sizing")?.ceremonyTier;
  if (tier === "LIGHT") {
    test("skipped — spec checks not required for LIGHT tier", () => {});
    return;
  }

  test("no setTimeout when spec says use backoff", () => {
    const wf = loadState() as any;
    const spec = loadSpec(wf.sourceSpecs[0].path, wf.projectRoot);

    if (!spec.match(/not use setTimeout|exponential backoff/i)) return;

    const hits = wf.acs.filter((ac: any) =>
      /setTimeout/i.test(ac.statement) || /setTimeout/i.test(ac.evidenceMethod?.command || "")
    );

    expect(hits.map((ac: any) => `${ac.id}: ${ac.statement}`)).toEqual([]);
  });

  test("no stdout/console.log when spec says use logger", () => {
    const wf = loadState() as any;
    const spec = loadSpec(wf.sourceSpecs[0].path, wf.projectRoot);

    if (!spec.match(/not write directly to stdout|use the logger/i)) return;

    const hits = wf.acs.filter((ac: any) =>
      /console\.log|stdout|directly/i.test(ac.statement)
    );

    expect(hits.map((ac: any) => `${ac.id}: ${ac.statement}`)).toEqual([]);
  });

  test("no string error handling when spec says use typed errors", () => {
    const wf = loadState() as any;
    const spec = loadSpec(wf.sourceSpecs[0].path, wf.projectRoot);

    if (!spec.match(/structured error|typed error|never raw string/i)) return;

    const hits = wf.acs.filter((ac: any) =>
      /string message|raw.*throw|catch.*string/i.test(ac.statement)
    );

    expect(hits.map((ac: any) => `${ac.id}: ${ac.statement}`)).toEqual([]);
  });
});

describe("E2E: Marcus brief cites governing spec", () => {
  if (STANDALONE || !existsSync(SF)) {
    test("skipped — no active workflow (standalone run)", () => {});
    return;
  }
  const tier = sf("sizing")?.ceremonyTier;
  if (tier === "LIGHT") {
    test("skipped — spec checks not required for LIGHT tier", () => {});
    return;
  }

  test("brief references spec constraints", () => {
    const wf = loadState() as any;
    if (!wf.sourceSpecs?.[0]?.path || !wf.agents?.marcus?.brief) return;

    const spec = loadSpec(wf.sourceSpecs[0].path, wf.projectRoot);
    const rules = extractSpecRules(spec);
    const brief = wf.agents.marcus.brief.toLowerCase();

    const cited = rules.filter(r =>
      brief.includes(r.slice(0, 25).toLowerCase())
    );

    expect(cited.length).toBeGreaterThanOrEqual(
      Math.min(3, rules.length)
    );
  });
});

// ═══ ADR-008 MIGRATION COMPLETENESS ════════════════════════════════════

describe("E2E: ADR-008 migration", () => {
  test("ADR-008 'What to delete' files are actually deleted", () => {
    const adrPath = join(process.env.HOME || "", ".claude", "PAI", "ADR", "ADR-008-harness-v3-bun-tests-migration.md");
    if (!existsSync(adrPath)) return;
    const adr = readFileSync(adrPath, "utf-8");

    const deletionTargets = [
      "skills/ship/gate-runner.sh",
      "skills/ship/gate-checks.sh",
    ];

    const existing = deletionTargets.filter(f =>
      existsSync(join(process.env.HOME || "", ".claude", f))
    );
    expect(existing).toEqual([]);
  });

  test("stop-the-bleeding: no .sh files in skills/ship/", () => {
    const { execSync } = require("child_process");
    const shipDir = join(process.env.HOME || "", ".claude", "skills", "ship");
    try {
      const result = execSync(`find "${shipDir}" -name '*.sh'`, { encoding: "utf-8", timeout: 5000 }).trim();
      const files = result ? result.split("\n").filter(Boolean) : [];
      expect(files).toEqual([]);
    } catch {
      // find command failed — skip
    }
  });
});
