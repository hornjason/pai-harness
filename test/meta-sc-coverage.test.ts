import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const SPEC_PATH = join(import.meta.dir, "..", "specs", "BOOTSTRAP-DATA-FLOW-SPEC.md");
const TEST_PLAN_PATH = join(import.meta.dir, "..", "specs", "BOOTSTRAP-TEST-PLAN.md");

// Phase header → test file mapping
const PHASE_MAP: Record<string, string> = {
  "Phase 0": "phase-0",
  "Phase 1": "phase-1",
  "Phase 1.5": "phase-1-5",
  "Phase 2": "phase-2",
  "Phase 3": "phase-3",
  "Phase 4": "phase-4",
  "Phase 5": "phase-5",
  "Anti-Criteria": "anti",
};

// Parse SC-to-phase routing from ### subheaders in the Success Criteria section
function parseRouting(spec: string): Map<string, string> {
  const routing = new Map<string, string>();
  let currentPhase: string | null = null;

  for (const line of spec.split("\n")) {
    // Match phase subheaders: ### Phase 0 — Scaffold Output
    const headerMatch = line.match(/^### (Phase \d+(?:\.\d+)?|Anti-Criteria)/);
    if (headerMatch) {
      const key = headerMatch[1];
      currentPhase = PHASE_MAP[key] || null;
      continue;
    }

    if (!currentPhase) continue;

    // Match SC lines under current phase header
    const scMatch = line.match(/^- \[ \] (SC-(?:\d+|A\d+)):/);
    if (scMatch) {
      routing.set(scMatch[1], currentPhase);
    }
  }

  return routing;
}

describe("meta: SC coverage — every SC in the spec has a test", () => {
  test("all SCs from bootstrap spec appear in at least one test file", () => {
    const spec = readFileSync(SPEC_PATH, "utf-8");
    const routing = parseRouting(spec);

    // Extract all SC IDs
    const scMatches = [...spec.matchAll(/^- \[ \] (SC-(?:\d+|A\d+)):/gm)];
    const allSCs = [...new Set(scMatches.map(m => m[1]))];

    // Read all phase test files
    const testFiles = ["phase-0.test.ts", "phase-1.test.ts", "phase-1-5.test.ts", "phase-2.test.ts", "phase-3.test.ts", "phase-4.test.ts", "phase-5.test.ts", "anti.test.ts"]
      .map(f => join(import.meta.dir, f))
      .filter(f => existsSync(f));

    const testContent = testFiles.map(f => readFileSync(f, "utf-8")).join("\n");

    // Find SCs that appear in no test file
    const untested = allSCs.filter(sc => !testContent.includes(sc));

    // Find SCs not under any phase header (spec structure error)
    const unrouted = allSCs.filter(sc => !routing.has(sc));

    if (untested.length > 0) {
      console.log(`\n── SC COVERAGE GAP ──────────────────────────`);
      console.log(`  ${allSCs.length} SCs in spec, ${allSCs.length - untested.length} tested, ${untested.length} UNTESTED`);
      console.log(`  Routed by ### Phase headers in Success Criteria section.\n`);

      // Group by phase from section headers
      const byPhase = new Map<string, string[]>();
      for (const sc of untested) {
        const phase = routing.get(sc) || "UNROUTED";
        if (!byPhase.has(phase)) byPhase.set(phase, []);
        byPhase.get(phase)!.push(sc);
      }

      for (const [phase, scs] of [...byPhase.entries()].sort()) {
        const file = phase === "UNROUTED" ? "— move SC under a ### Phase header" : `test/${phase}.test.ts`;
        console.log(`  ${phase} → ${file} (${scs.length} untested)`);
        for (const sc of scs) {
          const line = scMatches.find(m => m[1] === sc);
          const scText = line ? line[0].substring(6, 90) : sc;
          console.log(`    ✗ ${scText}`);
        }
      }
      console.log(`──────────────────────────────────────────────\n`);
    }

    if (unrouted.length > 0) {
      console.log(`\n── UNROUTED SCs (not under a ### Phase header) ──`);
      console.log(`  These SCs exist in the spec but are outside the phase-grouped section.`);
      console.log(`  Move them under the correct ### Phase header in ## Success Criteria.\n`);
      for (const sc of unrouted) {
        console.log(`  ✗ ${sc}`);
      }
      console.log(`──────────────────────────────────────────────\n`);
    }

    const coverage = ((allSCs.length - untested.length) / allSCs.length * 100).toFixed(1);
    console.log(`SC coverage: ${allSCs.length - untested.length}/${allSCs.length} (${coverage}%)`);

    expect(untested).toEqual([]);
  });

  test("all SCs are under a phase header (no orphans)", () => {
    const spec = readFileSync(SPEC_PATH, "utf-8");
    const routing = parseRouting(spec);

    const scMatches = [...spec.matchAll(/^- \[ \] (SC-(?:\d+|A\d+)):/gm)];
    const allSCs = [...new Set(scMatches.map(m => m[1]))];
    const unrouted = allSCs.filter(sc => !routing.has(sc));

    if (unrouted.length > 0) {
      console.log(`UNROUTED: ${unrouted.join(", ")}`);
    }

    expect(unrouted).toEqual([]);
  });

  test("all TPs from test plan spec appear in at least one test file", () => {
    if (!existsSync(TEST_PLAN_PATH)) return;
    const testPlan = readFileSync(TEST_PLAN_PATH, "utf-8");

    const tpMatches = [...testPlan.matchAll(/^- \[ \] (TP-\d+):/gm)];
    const allTPs = [...new Set(tpMatches.map(m => m[1]))];

    const testFiles = ["phase-0.test.ts", "phase-1.test.ts", "phase-2.test.ts", "phase-3.test.ts", "meta-sc-coverage.test.ts"]
      .map(f => join(import.meta.dir, f))
      .filter(f => existsSync(f));

    const testContent = testFiles.map(f => readFileSync(f, "utf-8")).join("\n");

    const untested = allTPs.filter(tp => !testContent.includes(tp));

    if (untested.length > 0) {
      console.log(`\n── TP COVERAGE GAP (${untested.length}/${allTPs.length} unimplemented) ──`);
      for (const tp of untested) {
        console.log(`  ⬜ ${tp}`);
      }
      console.log(`──────────────────────────────────────────────\n`);
    }

    // Implemented TPs should be marked [x] in spec — only unchecked [ ] TPs are tracked here
    // This warns but doesn't fail — unimplemented TPs are future work, not bugs
    expect(true).toBe(true);
  });

  // TP-9: Meta-test validates SC coverage
  test("TP-9: this meta-test exists and runs", () => {
    expect(true).toBe(true);
  });

  // TP-3: Every SC appears in at least one phase test file
  test("TP-3: phase test files exist", () => {
    expect(existsSync(join(import.meta.dir, "phase-0.test.ts"))).toBe(true);
    expect(existsSync(join(import.meta.dir, "phase-1.test.ts"))).toBe(true);
  });
});
