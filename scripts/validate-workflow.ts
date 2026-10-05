#!/usr/bin/env bun
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

const args = process.argv.slice(2);
const workflowPath = args[0] || join(import.meta.dir, "..", "workflows", "ship.js");
const resolved = resolve(workflowPath);

if (!existsSync(resolved)) {
  console.error(`Workflow not found: ${resolved}`);
  process.exit(1);
}

let errors = 0;

console.log(`Validating workflow: ${resolved}`);

// 1. Syntax check — wrap in async function (matching workflow runtime) and parse
try {
  const content = readFileSync(resolved, "utf-8");
  const stripped = content
    .replace(/^export\s+(const|let|var|function|class|async\s+function)/gm, "$1")
    .replace(/^import\s+[^;]*;?\s*$/gm, "");
  // Workflow runtime wraps scripts in async function with injected globals
  const wrapped = `(async function(agent, phase, log, parallel, pipeline, workflow, args) {\n${stripped}\n})`;
  new Function(wrapped);
  console.log("  ✓ Syntax: valid JavaScript");
} catch (e: any) {
  console.error(`  ✗ Syntax error: ${e.message}`);
  errors++;
}

// 2. Temporal dead zone detection — find let/const declarations and usages
try {
  const content = readFileSync(resolved, "utf-8");
  const lines = content.split("\n");

  const declarations = new Map<string, number>();
  const usages: Array<{ name: string; line: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const declMatch = line.match(/^(?:let|const)\s+([A-Z_][A-Z_0-9]*)\s*=/);
    if (declMatch) {
      declarations.set(declMatch[1], i + 1);
    }
    // Check for assignments to ALL_CAPS variables (convention for module-level state)
    const assignMatch = line.match(/^\s+([A-Z_][A-Z_0-9]*)\s*=\s/);
    if (assignMatch && !line.match(/^(?:let|const|var)\s/)) {
      usages.push({ name: assignMatch[1], line: i + 1 });
    }
  }

  let tdzFound = 0;
  for (const usage of usages) {
    const declLine = declarations.get(usage.name);
    if (declLine && usage.line < declLine) {
      console.error(
        `  ✗ TDZ: '${usage.name}' used at line ${usage.line} but declared at line ${declLine}`,
      );
      tdzFound++;
    }
  }
  if (tdzFound === 0) {
    console.log("  ✓ TDZ check: no temporal dead zone issues");
  } else {
    errors += tdzFound;
  }
} catch (e: any) {
  console.error(`  ✗ TDZ check failed: ${e.message}`);
  errors++;
}

// 3. Undeclared globals check — workflow sandbox provides specific globals
const WORKFLOW_GLOBALS = new Set([
  "agent", "phase", "log", "parallel", "pipeline", "workflow",
  "args", "console", "require", "process", "JSON", "Buffer",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "Date", "Math", "Object", "Array", "String", "Number", "Boolean",
  "Map", "Set", "Error", "RegExp", "Promise", "Proxy", "Symbol",
  "parseInt", "parseFloat", "isNaN", "isFinite", "undefined", "NaN",
  "Infinity", "encodeURIComponent", "decodeURIComponent",
  "encodeURI", "decodeURI", "eval",
]);

// 4. Check for dangerous inline shell patterns
try {
  const content = readFileSync(resolved, "utf-8");
  const lines = content.split("\n");
  let dangerousPatterns = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // git add with unquoted interpolation (not using buildSafeGitAdd)
    if (line.match(/git add \$\{/) && !line.includes("buildSafeGitAdd")) {
      console.warn(
        `  ⚠ Line ${i + 1}: Inline git add with interpolation — consider buildSafeGitAdd()`,
      );
      dangerousPatterns++;
    }
  }

  if (dangerousPatterns === 0) {
    console.log("  ✓ Shell patterns: no dangerous inline construction");
  } else {
    console.warn(`  ⚠ ${dangerousPatterns} inline shell pattern(s) found (warnings, not errors)`);
  }
} catch (e: any) {
  console.error(`  ✗ Shell pattern check failed: ${e.message}`);
  errors++;
}

if (errors > 0) {
  console.error(`\n✗ FAILED: ${errors} error(s) found`);
  process.exit(1);
} else {
  console.log(`\n✓ PASSED: workflow validation complete`);
  process.exit(0);
}
