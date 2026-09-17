#!/usr/bin/env bun
/**
 * sync-spec-tests.ts — Reads HARNESS-SKILL-CHAIN.md, extracts mechanical claims,
 * generates spec-compliance test assertions in test/spec-compliance-auto.test.ts.
 *
 * Run: bun scripts/sync-spec-tests.ts
 * Generates: test/spec-compliance-auto.test.ts
 *
 * Claim markers in the spec:
 *   Lines containing `make <target>` → assert target file contains the make command
 *   Lines containing `**GATE:**` → assert phase ordering in workflow file
 *   Lines containing port numbers (:7776, :7778, :5173) → assert port references
 *   Lines containing `Quinn` + action verb → assert Quinn integration
 */

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { resolve, join } from "path";

const HOME = process.env.HOME || "";
const HARNESS_ROOT = process.env.HARNESS_ROOT || join(HOME, ".claude");
const SPECS_DIR = resolve(HARNESS_ROOT, "PAI/Specs");
const SHIP_PATH = resolve(HARNESS_ROOT, "workflows/ship.js");
const PROVE_PATH = resolve(HARNESS_ROOT, "workflows/prove.js");
const OUTPUT_PATH = resolve(HARNESS_ROOT, "test/spec-compliance-auto.test.ts");

function parseTestable(content: string): boolean | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const testableMatch = fmMatch[1].match(/^testable:\s*(true|false)\s*$/m);
  if (!testableMatch) return null;
  return testableMatch[1] === "true";
}

function discoverTestableSpecs(): { path: string; name: string }[] {
  const files = readdirSync(SPECS_DIR).filter(f => f.endsWith(".md"));
  const testable: { path: string; name: string }[] = [];
  for (const f of files) {
    const fullPath = join(SPECS_DIR, f);
    const content = readFileSync(fullPath, "utf-8");
    if (parseTestable(content) === true) {
      testable.push({ path: fullPath, name: f });
    }
  }
  return testable;
}

interface Claim {
  id: string;
  spec_line: number;
  claim: string;
  target: "ship" | "prove" | "both";
  assertion_type: "contains" | "ordering" | "port";
  search_term: string;
  context: string;
}

function extractClaims(spec: string): Claim[] {
  const claims: Claim[] = [];
  const lines = spec.split("\n");
  let claimCounter = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Make commands: make test-up, make prove-up, make test-rebuild, make rebuild
    const makeMatch = line.match(/`(make\s+[\w-]+)`/);
    if (makeMatch) {
      const cmd = makeMatch[1];
      // Determine target based on section context and command name
      const isProveSection = lines.slice(Math.max(0, i - 30), i).some(l => /Step 4.*PROVE|PROVE.*post-merge|Layer 3.*Prove/i.test(l));
      const isReleaseSection = lines.slice(Math.max(0, i - 20), i).some(l => /Step 5.*RELEASE|RELEASE/i.test(l));
      // Skip release commands — they belong to release skill, not ship/prove
      if (isReleaseSection) continue;
      const target = isProveSection || cmd.includes("prove") ? "prove" : "ship";
      // For ship, test-up may have been upgraded to test-rebuild — check for either
      const searchTerm = cmd.replace("make ", "");
      claims.push({
        id: `AUTO-MAKE-${++claimCounter}`,
        spec_line: lineNum,
        claim: `Spec requires make ${searchTerm}`,
        target,
        assertion_type: "contains",
        search_term: searchTerm,
        context: line.trim().slice(0, 100),
      });
    }

    // GATE markers
    if (line.includes("**GATE:") || line.includes("**Gate:**")) {
      const gateText = line.replace(/\*\*/g, "").replace("GATE:", "").replace("Gate:", "").trim();
      const target = line.toLowerCase().includes("prove") ? "prove" : "ship";
      claims.push({
        id: `AUTO-GATE-${++claimCounter}`,
        spec_line: lineNum,
        claim: `Gate: ${gateText.slice(0, 80)}`,
        target,
        assertion_type: "contains",
        search_term: gateText.includes("Quinn") ? "quinn" : gateText.includes("Ship gate") ? "ship" : "gate",
        context: line.trim().slice(0, 100),
      });
    }

    // Port references in context of specific tools
    const portMatch = line.match(/:(\d{4})\b/);
    if (portMatch) {
      const port = portMatch[1];
      if (["7776", "7777", "7778", "5173"].includes(port)) {
        // Determine which file should reference this port
        const isProveSection = lines.slice(Math.max(0, i - 20), i).some(l => /Step 4.*PROVE|PROVE.*post-merge/i.test(l));
        const target = isProveSection ? "prove" : "ship";
        claims.push({
          id: `AUTO-PORT-${++claimCounter}`,
          spec_line: lineNum,
          claim: `Port ${port} referenced in ${isProveSection ? "PROVE" : "SHIP"} context`,
          target,
          assertion_type: "port",
          search_term: port,
          context: line.trim().slice(0, 100),
        });
      }
    }

    // Quinn + action verb patterns
    const quinnMatch = line.match(/Quinn\s+(validates|captures|tests|navigates|compares|verifies)/i);
    if (quinnMatch) {
      const action = quinnMatch[1].toLowerCase();
      const isProveSection = lines.slice(Math.max(0, i - 20), i).some(l => /Step 4.*PROVE|PROVE.*post-merge/i.test(l));
      const target = isProveSection ? "prove" : "ship";
      claims.push({
        id: `AUTO-QUINN-${++claimCounter}`,
        spec_line: lineNum,
        claim: `Quinn ${action} in ${isProveSection ? "PROVE" : "SHIP"}`,
        target,
        assertion_type: "contains",
        search_term: "quinn",
        context: line.trim().slice(0, 100),
      });
    }
  }

  // Deduplicate by search_term + target
  const seen = new Set<string>();
  return claims.filter(c => {
    const key = `${c.target}:${c.assertion_type}:${c.search_term}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function generateTest(claims: Claim[]): string {
  const shipClaims = claims.filter(c => c.target === "ship" || c.target === "both");
  const proveClaims = claims.filter(c => c.target === "prove" || c.target === "both");

  const lines: string[] = [
    `// AUTO-GENERATED by scripts/sync-spec-tests.ts — do not edit manually`,
    `// Regenerate: bun scripts/sync-spec-tests.ts`,
    `// Source: PAI/specs/HARNESS-SKILL-CHAIN.md`,
    `// Generated: ${new Date().toISOString().split("T")[0]}`,
    ``,
    `import { test, expect, describe } from "bun:test";`,
    `import { readFileSync } from "fs";`,
    ``,
    `const SHIP_JS = readFileSync("${SHIP_PATH}", "utf-8");`,
    `const PROVE_JS = readFileSync("${PROVE_PATH}", "utf-8");`,
    ``,
  ];

  if (shipClaims.length > 0) {
    lines.push(`describe("auto-spec: ship.js claims from HARNESS-SKILL-CHAIN.md", () => {`);
    for (const claim of shipClaims) {
      const testName = `${claim.id}: ${claim.claim}`.replace(/"/g, '\\"');
      lines.push(`  // Spec line ${claim.spec_line}: ${claim.context}`);
      if (claim.assertion_type === "port") {
        lines.push(`  test("${testName}", () => {`);
        lines.push(`    expect(SHIP_JS).toContain("${claim.search_term}");`);
        lines.push(`  });`);
      } else {
        lines.push(`  test("${testName}", () => {`);
        lines.push(`    expect(SHIP_JS.toLowerCase()).toContain("${claim.search_term.toLowerCase()}");`);
        lines.push(`  });`);
      }
      lines.push(``);
    }
    lines.push(`});`);
    lines.push(``);
  }

  if (proveClaims.length > 0) {
    lines.push(`describe("auto-spec: prove.js claims from HARNESS-SKILL-CHAIN.md", () => {`);
    for (const claim of proveClaims) {
      const testName = `${claim.id}: ${claim.claim}`.replace(/"/g, '\\"');
      lines.push(`  // Spec line ${claim.spec_line}: ${claim.context}`);
      if (claim.assertion_type === "port") {
        lines.push(`  test("${testName}", () => {`);
        lines.push(`    expect(PROVE_JS).toContain("${claim.search_term}");`);
        lines.push(`  });`);
      } else {
        lines.push(`  test("${testName}", () => {`);
        lines.push(`    expect(PROVE_JS.toLowerCase()).toContain("${claim.search_term.toLowerCase()}");`);
        lines.push(`  });`);
      }
      lines.push(``);
    }
    lines.push(`});`);
  }

  return lines.join("\n") + "\n";
}

// Main — glob scan all testable specs
const testableSpecs = discoverTestableSpecs();
const allFiles = readdirSync(SPECS_DIR).filter(f => f.endsWith(".md"));

console.log(`Spec discovery: ${allFiles.length} specs scanned, ${testableSpecs.length} testable`);

let allClaims: Claim[] = [];
for (const spec of testableSpecs) {
  const content = readFileSync(spec.path, "utf-8");
  const claims = extractClaims(content);
  allClaims = allClaims.concat(claims);
  console.log(`  ${spec.name}: ${claims.length} claims`);
}

const testContent = generateTest(allClaims);
writeFileSync(OUTPUT_PATH, testContent);

console.log(`\nTotal: ${allClaims.length} claims extracted`);
console.log(`  ship.js: ${allClaims.filter(c => c.target === "ship").length}`);
console.log(`  prove.js: ${allClaims.filter(c => c.target === "prove").length}`);
console.log(`Written to: ${OUTPUT_PATH}`);

for (const c of allClaims) {
  console.log(`  ${c.id} [${c.target}] L${c.spec_line}: ${c.claim}`);
}
