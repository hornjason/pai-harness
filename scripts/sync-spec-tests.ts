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

import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { harnessRootFor } from "../lib/paths";

/**
 * Where this script reads specs and writes tests (#141).
 *
 * It used to compute these itself:
 *
 *     const HARNESS_ROOT = process.env.HARNESS_ROOT || join(HOME, ".claude");
 *     const SPECS_DIR    = resolve(HARNESS_ROOT, "PAI/Specs");
 *     const OUTPUT_PATH  = resolve(HARNESS_ROOT, "test/spec-compliance-auto.test.ts");
 *
 * `HARNESS_ROOT` is never exported — no profile, CI file, hook or skill sets
 * it; it is only ever passed as a workflow argument. So the default applied,
 * and the generator read `~/.claude/PAI/Specs` and wrote
 * `~/.claude/test/spec-compliance-auto.test.ts`, while `lib/paths.ts`
 * `harnessRoot()` resolved to this checkout. Two functions, one concept, two
 * answers — and both directories exist, so nothing ever errored.
 *
 * The cost: `specs/` holds 30 spec files and this generator had never read
 * one of them. "SCs without tests are wishes" is the project's own rule, and
 * the mechanism meant to enforce it wrote its output where the suite does not
 * look and reported success. `gates/gate-executor.ts` runs it on every gate.
 *
 * Pure in `root` so the resolution is testable without a filesystem, which is
 * the shape the issue asked for.
 */
export interface SyncPaths {
  specsDir: string;
  shipPath: string;
  provePath: string;
  outputPath: string;
}

export function resolveSyncPaths(root: string): SyncPaths {
  return {
    specsDir: resolve(root, "specs"),
    shipPath: resolve(root, "workflows/ship.js"),
    provePath: resolve(root, "workflows/prove.js"),
    outputPath: resolve(root, "test/spec-compliance-auto.test.ts"),
  };
}

/**
 * The tree this script WRITES to, stated rather than inherited (#190).
 *
 * It was `const ROOT = harnessRoot()` at module scope, which made the
 * destination of a write depend on two things the caller never said: the
 * `HARNESS_ROOT` environment variable, and which checkout happened to load
 * `lib/paths.ts`. `gates/gate-executor.ts` runs this on every scope gate, so a
 * gate whose root was resolved elsewhere regenerated a DIFFERENT checkout's
 * `test/spec-compliance-auto.test.ts` and left its own stale — silently, since
 * both files exist and both are real.
 *
 * Resolution order:
 *
 *   1. `argv[2]`, when a caller names the tree it means.
 *   2. Otherwise the checkout this script file lives in.
 *
 * `bun <checkout>/scripts/sync-spec-tests.ts` therefore writes into
 * `<checkout>`, whatever the cwd and whatever the environment says. Deliberately
 * NOT `harnessRoot()`: a writer that can be aimed by an env var is how #141
 * happened, and `HARNESS_ROOT` is set by the ship workflow for reasons that
 * have nothing to do with where generated tests belong.
 */
export function syncRoot(argv: string[] = process.argv): string {
  const arg = argv[2];
  // `join(dir, "..")` because this file sits in `scripts/`; `harnessRootFor`
  // resolves and validates the path it is handed, it does not search upward.
  return arg ? harnessRootFor(arg) : harnessRootFor(join(import.meta.dir, ".."));
}

function parseTestable(content: string): boolean | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const testableMatch = fmMatch[1].match(/^testable:\s*(true|false)\s*$/m);
  if (!testableMatch) return null;
  return testableMatch[1] === "true";
}

function discoverTestableSpecs(specsDir: string): { path: string; name: string }[] {
  const files = readdirSync(specsDir).filter(f => f.endsWith(".md"));
  const testable: { path: string; name: string }[] = [];
  for (const f of files) {
    const fullPath = join(specsDir, f);
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
    `// Source: specs/ (every spec with testable: true)`,
    `// Generated: ${new Date().toISOString().split("T")[0]}`,
    ``,
    `import { test, expect, describe } from "bun:test";`,
    `import { readFileSync } from "fs";`,
    `import { join } from "path";`,
    `import { harnessRootFor } from "../lib/paths";`,
    ``,
    `// Resolved at run time, not baked in: an absolute path written by whoever`,
    `// last ran the generator makes the file unrunnable anywhere else, CI`,
    `// included.`,
    `//`,
    `// Resolved from THIS file's own location, not from the implicit`,
    `// module-relative root (#190). These cases grade workflows/ship.js, and`,
    `// the implicit root honours HARNESS_ROOT — so a run with it set read a`,
    `// different checkout's ship.js than the one this file was generated`,
    `// from. A generated test grading a tree it does not belong to reports`,
    `// failures that exist in nobody's checkout.`,
    `const HR = harnessRootFor(join(import.meta.dir, ".."));`,
    `const SHIP_JS = readFileSync(join(HR, "workflows/ship.js"), "utf-8");`,
    `const PROVE_JS = readFileSync(join(HR, "workflows/prove.js"), "utf-8");`,
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

// Main — glob scan all testable specs.
//
// Behind `import.meta.main` so importing this module for its pure path
// helpers does not rewrite a test file as a side effect of the import. The
// test that covers resolveSyncPaths does exactly that import, and without
// this guard it regenerated the suite's own source mid-run.
export function main(root: string) {
  const { specsDir: SPECS_DIR, outputPath: OUTPUT_PATH } = resolveSyncPaths(root);

  // Fail loudly on a missing spec directory. The previous version could not:
  // `~/.claude/PAI/Specs` happened to exist, so reading the wrong tree looked
  // exactly like reading the right one.
  if (!existsSync(SPECS_DIR)) {
    console.error(
      `sync-spec-tests: no spec directory at ${SPECS_DIR}\n` +
        `  (harness root given as ${root} — pass the root as argv[2] if that is wrong)`,
    );
    process.exit(1);
  }

  const testableSpecs = discoverTestableSpecs(SPECS_DIR);
  const allFiles = readdirSync(SPECS_DIR).filter(f => f.endsWith(".md"));

  console.log(`Spec discovery: ${allFiles.length} specs scanned, ${testableSpecs.length} testable`);

  let allClaims: Claim[] = [];
  for (const spec of testableSpecs) {
    const content = readFileSync(spec.path, "utf-8");
    const claims = extractClaims(content);
    allClaims = allClaims.concat(claims);
    console.log(`  ${spec.name}: ${claims.length} claims`);
  }

  writeFileSync(OUTPUT_PATH, generateTest(allClaims));

  console.log(`\nTotal: ${allClaims.length} claims extracted`);
  console.log(`  ship.js: ${allClaims.filter(c => c.target === "ship").length}`);
  console.log(`  prove.js: ${allClaims.filter(c => c.target === "prove").length}`);
  console.log(`Written to: ${OUTPUT_PATH}`);

  for (const c of allClaims) {
    console.log(`  ${c.id} [${c.target}] L${c.spec_line}: ${c.claim}`);
  }
}

if (import.meta.main) main(syncRoot());
