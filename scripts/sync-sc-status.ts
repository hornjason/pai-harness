#!/usr/bin/env bun
/**
 * Sync SC checkbox status: test passes → spec checkbox flips from [ ] to [x].
 *
 * 1. Scans spec files for unchecked SCs: - [ ] SC-NNN: ...
 * 2. Scans test files for matching SC-NNN references
 * 3. Runs only the test files that contain unchecked SCs
 * 4. For SCs without hand-written tests, runs matchPattern() conformity assertions
 * 5. If assertions pass, flips matching checkboxes to [x]
 *
 * Usage:
 *   bun scripts/sync-sc-status.ts           # Run targeted tests and flip checkboxes
 *   bun scripts/sync-sc-status.ts --dry-run # Show what would flip without changing files
 *   bun scripts/sync-sc-status.ts --report  # Output per-spec coverage report
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { matchPattern, isBehavioralSC, type ParsedSC } from "../lib/conformity";
import { readFreshCache } from "../lib/behavioral-cache";
import { detectDrift } from "./detect-sc-drift";

const ROOT = join(import.meta.dir, "..");
const SPECS_DIR = join(ROOT, "specs");
const TEST_DIR = join(ROOT, "test");
const dryRun = process.argv.includes("--dry-run");
const reportMode = process.argv.includes("--report");

export interface UncheckedSC {
  id: string;
  statement?: string;
  specFile: string;
}

export function findUncheckedSCs(specsDir?: string): UncheckedSC[] {
  const dir = specsDir || SPECS_DIR;
  const unchecked: UncheckedSC[] = [];
  if (!existsSync(dir)) return unchecked;

  for (const file of new Bun.Glob("**/*.md").scanSync({ cwd: dir, absolute: false })) {
    const content = readFileSync(join(dir, file), "utf-8");
    for (const match of content.matchAll(/^- \[ \] (SC-\d+):\s*(.+)$/gm)) {
      unchecked.push({ id: match[1], statement: match[2].trim(), specFile: file });
    }
  }
  return unchecked;
}

export function findTestFilesForSCs(scIds: Set<string>, testDir?: string): Map<string, string[]> {
  const dir = testDir || TEST_DIR;
  const testFileToSCs = new Map<string, string[]>();
  if (!existsSync(dir)) return testFileToSCs;

  for (const file of readdirSync(dir).filter(f => f.endsWith(".test.ts"))) {
    const content = readFileSync(join(dir, file), "utf-8");
    const foundSCs: string[] = [];
    for (const id of scIds) {
      if (content.includes(id)) foundSCs.push(id);
    }
    if (foundSCs.length > 0) {
      testFileToSCs.set(file, foundSCs);
    }
  }
  return testFileToSCs;
}

function runTestFile(file: string): boolean {
  try {
    execSync(`bun test test/${file}`, {
      cwd: ROOT, timeout: 120000, stdio: ["ignore", "pipe", "pipe"]
    });
    return true;
  } catch (e: any) {
    const out = (e.stdout || "") + (e.stderr || "");
    const failMatch = out.match(/(\d+) fail/);
    return failMatch ? parseInt(failMatch[1]) === 0 : false;
  }
}

export interface ConformityResult {
  passing: Set<string>;
  failing: Set<string>;
  unmatchable: Set<string>;
}

/**
 * Composite key scoped to spec file — prevents cross-spec ID collisions.
 */
export function scopedKey(specFile: string, id: string): string {
  return `${specFile}::${id}`;
}

/**
 * Detect duplicate SC IDs across specs.
 */
export function findDuplicateSCIds(scs: UncheckedSC[]): Map<string, string[]> {
  const idToSpecs = new Map<string, string[]>();
  for (const sc of scs) {
    if (sc.specFile.includes("SPEC-TEMPLATE")) continue;
    const specs = idToSpecs.get(sc.id) || [];
    if (!specs.includes(sc.specFile)) specs.push(sc.specFile);
    idToSpecs.set(sc.id, specs);
  }
  const duplicates = new Map<string, string[]>();
  for (const [id, specs] of idToSpecs) {
    if (specs.length > 1) duplicates.set(id, specs);
  }
  return duplicates;
}

/**
 * AC-2: For each unchecked SC without a hand-written test, runs matchPattern()
 * and executes the returned assertion against the project root.
 * Results are scoped by spec file to prevent cross-spec ID collisions.
 *
 * Behavioral SCs are checked against the behavioral-results cache first.
 * If a fresh cached result exists, it's used instead of matchPattern.
 */
export function checkConformitySCs(uncheckedSCs: UncheckedSC[], root: string): ConformityResult {
  const passing = new Set<string>();
  const failing = new Set<string>();
  const unmatchable = new Set<string>();

  // Read behavioral cache for behavioral SCs
  const cachePath = join(root, ".rungate", "behavioral-results.json");
  const behavioralCache = readFreshCache(cachePath);

  for (const sc of uncheckedSCs) {
    const statement = sc.statement || "";
    const key = scopedKey(sc.specFile, sc.id);
    const parsed: ParsedSC = { id: sc.id, statement, specFile: sc.specFile };

    // Check behavioral cache first for behavioral SCs
    if (isBehavioralSC(parsed) && behavioralCache[sc.id]) {
      if (behavioralCache[sc.id].passed) {
        passing.add(key);
      } else {
        failing.add(key);
      }
      continue;
    }

    const assertion = matchPattern(parsed);

    if (!assertion) {
      unmatchable.add(key);
      continue;
    }

    try {
      assertion(root);
      passing.add(key);
    } catch {
      failing.add(key);
    }
  }

  return { passing, failing, unmatchable };
}

export function flipCheckboxes(specFile: string, scIds: string[], specsDir?: string, isDryRun?: boolean): number {
  const dir = specsDir || SPECS_DIR;
  const filePath = join(dir, specFile);
  let content = readFileSync(filePath, "utf-8");
  let flipped = 0;

  for (const id of scIds) {
    const pattern = `- [ ] ${id}:`;
    if (content.includes(pattern)) {
      content = content.replace(pattern, `- [x] ${id}:`);
      flipped++;
    }
  }

  // Write unless dry-run: use explicit isDryRun param if provided, else module-level flag
  const shouldSkipWrite = isDryRun !== undefined ? isDryRun : dryRun;
  if (flipped > 0 && !shouldSkipWrite) {
    writeFileSync(filePath, content);
  }
  return flipped;
}

export interface SpecCoverage {
  testedPassing: string[];
  testedFailing: string[];
  conformityPassing: string[];
  conformityFailing: string[];
  unmatchable: string[];
}

/**
 * AC-4: --report flag outputs per-spec coverage showing
 * tested-passing, tested-failing, and unmatchable SCs.
 */
export function generateReport(specCoverage: Map<string, SpecCoverage>): string {
  const lines: string[] = [];
  lines.push("=== SC Coverage Report ===\n");

  for (const [specFile, coverage] of specCoverage) {
    lines.push(`${specFile}:`);
    if (coverage.testedPassing.length > 0)
      lines.push(`  tested-passing (${coverage.testedPassing.length}): ${coverage.testedPassing.join(", ")}`);
    if (coverage.testedFailing.length > 0)
      lines.push(`  tested-failing (${coverage.testedFailing.length}): ${coverage.testedFailing.join(", ")}`);
    if (coverage.conformityPassing.length > 0)
      lines.push(`  conformity-passing (${coverage.conformityPassing.length}): ${coverage.conformityPassing.join(", ")}`);
    if (coverage.conformityFailing.length > 0)
      lines.push(`  conformity-failing (${coverage.conformityFailing.length}): ${coverage.conformityFailing.join(", ")}`);
    if (coverage.unmatchable.length > 0)
      lines.push(`  unmatchable (${coverage.unmatchable.length}): ${coverage.unmatchable.join(", ")}`);
    lines.push("");
  }

  return lines.join("\n");
}

// --- Main (only runs when executed directly) ---
const isDirectExecution = import.meta.main;

if (isDirectExecution) {
  const unchecked = findUncheckedSCs();
  if (unchecked.length === 0) {
    console.log("All SCs are already checked off");
    process.exit(0);
  }

  const scIds = new Set(unchecked.map(s => s.id));
  console.log(`Found ${unchecked.length} unchecked SCs across specs`);

  // Step 0: Check for drift and staleness
  const driftResult = detectDrift(SPECS_DIR, ROOT);
  const driftedSCs = new Set<string>();
  const staleSCs = new Set<string>();

  if (driftResult.drifted.size > 0 || driftResult.stale.size > 0) {
    console.log(`\n⚠️  SC drift/staleness detected:`);

    for (const [specFile, details] of driftResult.drifted) {
      for (const detail of details) {
        console.log(`  DRIFT: ${detail.scId} in ${specFile} references ${detail.path} but file does not exist`);
        driftedSCs.add(scopedKey(specFile, detail.scId));
      }
    }

    for (const [specFile, details] of driftResult.stale) {
      for (const detail of details) {
        console.log(`  STALE: ${detail.scId} in ${specFile} expects [${detail.keyword}] in ${detail.path} but it's missing`);
        staleSCs.add(scopedKey(specFile, detail.scId));
      }
    }

    console.log(`  Fix: update SC descriptions to match current file structure.\n`);
  }

  // Step 1: Detect duplicate SC IDs across specs
  const duplicates = findDuplicateSCIds(unchecked);
  if (duplicates.size > 0) {
    console.log(`\n⚠️  Duplicate SC IDs found across specs:`);
    for (const [id, specs] of duplicates) {
      console.log(`  ${id}: ${specs.join(", ")}`);
    }
    console.log(`  Fix: renumber duplicates so each SC ID is unique across all specs.\n`);
  }

  // Step 2: Find SCs covered by hand-written test files
  const testFileMap = findTestFilesForSCs(scIds);
  const testedSCs = new Set(Array.from(testFileMap.values()).flat());
  const untestedSCs = unchecked.filter(s => !testedSCs.has(s.id));

  // Step 3: Run hand-written tests — scope by spec file
  const passingSCs = new Set<string>();
  const failingSCs = new Set<string>();

  for (const [testFile, scs] of testFileMap) {
    process.stdout.write(`  Running ${testFile}...`);
    const passed = runTestFile(testFile);
    if (passed) {
      console.log(` (${scs.length} SCs)`);
      for (const scId of scs) {
        for (const sc of unchecked.filter(u => u.id === scId)) {
          passingSCs.add(scopedKey(sc.specFile, sc.id));
        }
      }
    } else {
      console.log(` (${scs.join(", ")})`);
      for (const scId of scs) {
        for (const sc of unchecked.filter(u => u.id === scId)) {
          failingSCs.add(scopedKey(sc.specFile, sc.id));
        }
      }
    }
  }

  // Remove any SCs that failed from passing set
  for (const key of failingSCs) passingSCs.delete(key);

  // Step 4: AC-2 — Run conformity assertions on untested SCs
  if (untestedSCs.length > 0) {
    console.log(`\nChecking ${untestedSCs.length} untested SCs via conformity engine...`);
    const conformityResult = checkConformitySCs(untestedSCs, ROOT);

    for (const key of conformityResult.passing) {
      passingSCs.add(key);
      const scId = key.split("::")[1];
      console.log(`  ${scId}: conformity PASS`);
    }
    for (const key of conformityResult.failing) {
      failingSCs.add(key);
      const scId = key.split("::")[1];
      console.log(`  ${scId}: conformity FAIL`);
    }
    if (conformityResult.unmatchable.size > 0) {
      const ids = [...conformityResult.unmatchable].map(k => k.split("::")[1]);
      console.log(`  ${conformityResult.unmatchable.size} SCs unmatchable: ${ids.join(", ")}`);
    }

    // AC-4: --report flag
    if (reportMode) {
      const specCoverage = new Map<string, SpecCoverage>();

      for (const sc of unchecked) {
        if (!specCoverage.has(sc.specFile)) {
          specCoverage.set(sc.specFile, {
            testedPassing: [],
            testedFailing: [],
            conformityPassing: [],
            conformityFailing: [],
            unmatchable: [],
          });
        }
        const coverage = specCoverage.get(sc.specFile)!;
        const key = scopedKey(sc.specFile, sc.id);

        if (testedSCs.has(sc.id)) {
          if (passingSCs.has(key)) coverage.testedPassing.push(sc.id);
          else if (failingSCs.has(key)) coverage.testedFailing.push(sc.id);
        } else if (conformityResult.passing.has(key)) {
          coverage.conformityPassing.push(sc.id);
        } else if (conformityResult.failing.has(key)) {
          coverage.conformityFailing.push(sc.id);
        } else if (conformityResult.unmatchable.has(key)) {
          coverage.unmatchable.push(sc.id);
        }
      }

      console.log("\n" + generateReport(specCoverage));
    }
  }

  // Step 4: Filter out drifted/stale SCs before flipping
  for (const key of driftedSCs) {
    if (passingSCs.has(key)) {
      passingSCs.delete(key);
      const scId = key.split("::")[1];
      console.log(`\n⚠️  Not flipping ${scId}: drifted (references nonexistent file)`);
    }
  }
  for (const key of staleSCs) {
    if (passingSCs.has(key)) {
      passingSCs.delete(key);
      const scId = key.split("::")[1];
      console.log(`\n⚠️  Not flipping ${scId}: stale (keyword missing from file)`);
    }
  }

  // Step 5: Flip passing SCs
  if (passingSCs.size === 0) {
    console.log("No SCs to flip");
    process.exit(0);
  }

  // Group passing SCs by spec file and flip — scoped keys prevent cross-spec bleeding
  const bySpec = new Map<string, string[]>();
  for (const sc of unchecked) {
    const key = scopedKey(sc.specFile, sc.id);
    if (passingSCs.has(key)) {
      const list = bySpec.get(sc.specFile) || [];
      list.push(sc.id);
      bySpec.set(sc.specFile, list);
    }
  }

  let totalFlipped = 0;
  for (const [specFile, scs] of bySpec) {
    const flipped = flipCheckboxes(specFile, scs);
    if (flipped > 0) {
      console.log(`${dryRun ? "Would flip" : "Flipped"} ${flipped} SCs in ${specFile}: ${scs.join(", ")}`);
      totalFlipped += flipped;
    }
  }

  console.log(`\n${dryRun ? "Would flip" : "Flipped"} ${totalFlipped} SC checkboxes`);
}
