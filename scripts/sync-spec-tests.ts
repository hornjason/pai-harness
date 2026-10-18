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
import { collectSpecFiles } from "../lib/spec-files";
import { resolve, join } from "path";
import { harnessRootFor } from "../lib/paths";
import { localCalendarDay } from "../lib/local-calendar-day";

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

/**
 * Whether a spec makes claims about THIS harness's own workflows (#225).
 *
 * Every claim this script extracts is asserted against `workflows/ship.js` or
 * `workflows/prove.js`, so it only means anything for a spec describing the
 * harness. `specs/bootstrap-data-flow/template-architecture.md` describes what
 * a SCAFFOLDED CONSUMER's files look like, and its `make dev-all` /
 * `make test-rebuild` / `make prove-up` are examples of a consumer Makefile —
 * turning them into "rungate's ship.js must contain this string" is a false
 * assertion about a different project.
 *
 * This was always true; it only started firing when #225 made the collectors
 * recursive and the consumer-facing specs became visible for the first time.
 * The opt-out is frontmatter rather than a path rule so it stays explicit and
 * reviewable, and so making a spec visible to the conformity engine and making
 * it a source of harness claims remain two separate decisions.
 */
function parseWorkflowClaims(content: string): boolean {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return true;
  return !/^workflow-claims:\s*false\s*$/m.test(fm[1]);
}

function discoverTestableSpecs(specsDir: string): { path: string; name: string }[] {
  const files = collectSpecFiles(specsDir); // #225 — subdirectories too
  const testable: { path: string; name: string }[] = [];
  for (const f of files) {
    const fullPath = join(specsDir, f);
    const content = readFileSync(fullPath, "utf-8");
    if (parseTestable(content) === true && parseWorkflowClaims(content)) {
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

/**
 * #277/#343 — this emitted twelve assertions, every one of which was a bare
 * substring presence check against a 4,000-line workflow file.
 *
 * Four claim shapes were extracted from spec prose — \`make x\`, \`**GATE:**\`,
 * a port number, and "Quinn <verb>" — and each became
 * \`expect(SHIP_JS.toLowerCase()).toContain(<search_term>)\` where the search
 * term was a generic word lifted out of the sentence. Counted in ship.js:
 *
 *     "gate"     196 occurrences
 *     "ship"     264
 *     "quinn"     94
 *     "rebuild"   17
 *     "x"        563      <- from the literal spec phrase \`make x\`
 *
 * None of them could fail. Not "unlikely to fail" — the terms are structural
 * vocabulary of the file being searched, so the assertions were true before
 * the spec sentence existed and would stay true if the behaviour were
 * deleted. Twelve named checks, zero measurement, counted in the suite total
 * and in every compliance report.
 *
 * Found because an SC line added in #343 — about REMOVING a hardcoded
 * \`make rebuild\` — matched the \`make x\` shape and generated a thirteenth
 * test asserting ship.js contains "rebuild". A spec sentence describing the
 * deletion of a thing generated a test demanding its presence.
 *
 * Removed rather than weakened, which is what #315 did with
 * \`evidence-target-valid\` for the same reason: a name in a report with
 * nothing behind it is worse than an absence, because the absence is visible.
 * Rebuilding spec-claim extraction with assertions that can fail is real
 * work with a real design question behind it — what IS the checkable content
 * of "Spec requires make rebuild"? — and it is not done by keeping these.
 *
 * \`test/spec-compliance-config.test.ts\` holds the hand-written checks that
 * used to live in the generated file and are genuinely load-bearing.
 */
function extractClaims(_spec: string): Claim[] {
  return [];
}

function generateTest(claims: Claim[]): string {
  // No claims means no file worth importing: the header alone would read
  // `workflows/ship.js` at module scope to populate two constants nothing
  // uses, so a missing workflow file would fail a suite that asserts nothing.
  if (claims.length === 0) {
    return [
      `// AUTO-GENERATED by scripts/sync-spec-tests.ts — do not edit manually`,
      `// Regenerate: bun scripts/sync-spec-tests.ts`,
      ``,
      `// No generated claims. extractClaims returns nothing on purpose — see the`,
      `// docblock above it in scripts/sync-spec-tests.ts. The twelve assertions`,
      `// this file used to hold were bare substring checks for words like "gate"`,
      `// and "ship" against a file containing them 196 and 264 times.`,
      `//`,
      `// Hand-written spec-compliance checks live in`,
      `// test/spec-compliance-config.test.ts and test/spec-compliance.test.ts.`,
      ``,
    ].join("\n");
  }

  const shipClaims = claims.filter(c => c.target === "ship" || c.target === "both");
  const proveClaims = claims.filter(c => c.target === "prove" || c.target === "both");

  const lines: string[] = [
    `// AUTO-GENERATED by scripts/sync-spec-tests.ts — do not edit manually`,
    `// Regenerate: bun scripts/sync-spec-tests.ts`,
    `// Source: specs/ (every spec with testable: true)`,
    `// Generated: ${localCalendarDay()}`,
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
  const allFiles = collectSpecFiles(SPECS_DIR); // #225 — subdirectories too

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
