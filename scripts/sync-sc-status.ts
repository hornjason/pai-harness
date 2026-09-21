#!/usr/bin/env bun
/**
 * Sync SC checkbox status: test passes → spec checkbox flips from [ ] to [x].
 *
 * 1. Scans spec files for unchecked SCs: - [ ] SC-NNN: ...
 * 2. Scans test files for matching SC-NNN references
 * 3. Runs only the test files that contain unchecked SCs
 * 4. If a test file passes (0 fail), flips matching checkboxes to [x]
 *
 * Usage:
 *   bun scripts/sync-sc-status.ts           # Run targeted tests and flip checkboxes
 *   bun scripts/sync-sc-status.ts --dry-run # Show what would flip without changing files
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const SPECS_DIR = join(ROOT, "specs");
const TEST_DIR = join(ROOT, "test");
const dryRun = process.argv.includes("--dry-run");

interface UncheckedSC {
  id: string;
  specFile: string;
}

function findUncheckedSCs(): UncheckedSC[] {
  const unchecked: UncheckedSC[] = [];
  if (!existsSync(SPECS_DIR)) return unchecked;

  for (const file of new Bun.Glob("**/*.md").scanSync({ cwd: SPECS_DIR, absolute: false })) {
    const content = readFileSync(join(SPECS_DIR, file), "utf-8");
    for (const match of content.matchAll(/^- \[ \] (SC-\d+):/gm)) {
      unchecked.push({ id: match[1], specFile: file });
    }
  }
  return unchecked;
}

function findTestFilesForSCs(scIds: Set<string>): Map<string, string[]> {
  const testFileToSCs = new Map<string, string[]>();
  if (!existsSync(TEST_DIR)) return testFileToSCs;

  for (const file of readdirSync(TEST_DIR).filter(f => f.endsWith(".test.ts"))) {
    const content = readFileSync(join(TEST_DIR, file), "utf-8");
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

function flipCheckboxes(specFile: string, scIds: string[]): number {
  const filePath = join(SPECS_DIR, specFile);
  let content = readFileSync(filePath, "utf-8");
  let flipped = 0;

  for (const id of scIds) {
    const pattern = `- [ ] ${id}:`;
    if (content.includes(pattern)) {
      content = content.replace(pattern, `- [x] ${id}:`);
      flipped++;
    }
  }

  if (flipped > 0 && !dryRun) {
    writeFileSync(filePath, content);
  }
  return flipped;
}

// --- Main ---
const unchecked = findUncheckedSCs();
if (unchecked.length === 0) {
  console.log("✅ All SCs are already checked off");
  process.exit(0);
}

const scIds = new Set(unchecked.map(s => s.id));
console.log(`Found ${unchecked.length} unchecked SCs across specs`);

const testFileMap = findTestFilesForSCs(scIds);
const testedSCs = new Set(Array.from(testFileMap.values()).flat());
const untestedSCs = unchecked.filter(s => !testedSCs.has(s.id));

if (untestedSCs.length > 0) {
  console.log(`⬜ ${untestedSCs.length} SCs have no test: ${untestedSCs.map(s => s.id).join(", ")}`);
}

if (testFileMap.size === 0) {
  console.log("No test files reference unchecked SCs");
  process.exit(0);
}

const passingSCs = new Set<string>(scIds);
const failingSCs = new Set<string>();
for (const [testFile, scs] of testFileMap) {
  process.stdout.write(`  Running ${testFile}...`);
  const passed = runTestFile(testFile);
  if (passed) {
    console.log(` ✅ (${scs.length} SCs)`);
  } else {
    console.log(` ❌ (${scs.join(", ")})`);
    scs.forEach(sc => failingSCs.add(sc));
  }
}
// Only flip SCs that pass in ALL test files — any failure blocks the flip
for (const sc of failingSCs) passingSCs.delete(sc);
// Only flip SCs that actually have tests
for (const sc of passingSCs) {
  if (!testedSCs.has(sc)) passingSCs.delete(sc);
}

if (passingSCs.size === 0) {
  console.log("No SCs to flip");
  process.exit(0);
}

// Group passing SCs by spec file and flip
const bySpec = new Map<string, string[]>();
for (const sc of unchecked) {
  if (passingSCs.has(sc.id)) {
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

console.log(`\n${dryRun ? "Would flip" : "✅ Flipped"} ${totalFlipped} SC checkboxes`);
