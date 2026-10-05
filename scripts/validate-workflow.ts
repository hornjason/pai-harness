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
//
// This list is MEASURED, not assumed (#69). It comes from running a probe
// workflow that reports `typeof <name>` for each candidate. Do not add a name
// here on the belief that it "should" be available — re-run the probe.
//
// The previous list claimed require, process, Buffer and eval were available.
// None of them are. That is what let ship.js ship a top-level require() which
// killed every run: the validator approved it and no test ever executed it.
const WORKFLOW_GLOBALS = new Set([
  // harness-provided
  "agent", "phase", "log", "parallel", "pipeline", "workflow", "args", "budget",
  // runtime-provided
  "console", "globalThis", "JSON", "Math", "Date",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  // language built-ins
  "Object", "Array", "String", "Number", "Boolean",
  "Map", "Set", "Error", "RegExp", "Promise", "Proxy", "Symbol",
  "parseInt", "parseFloat", "isNaN", "isFinite", "undefined", "NaN",
  "Infinity", "encodeURIComponent", "decodeURIComponent",
  "encodeURI", "decodeURI",
]);

// Names the sandbox does NOT provide, with the reason, so the error is
// actionable rather than a bare "undeclared global".
//
// These are only a problem at the top level of a workflow script. Inside a
// template literal they are fine — those strings are executed by `bun -e` in a
// real Bun runtime, not by the sandbox.
const FORBIDDEN_SANDBOX_GLOBALS = new Map([
  ["require", "no module loading in the sandbox — inline the code instead (#69)"],
  ["process", "no Node process object — pass values in through args"],
  ["Buffer", "no Node Buffer"],
  ["module", "not a CommonJS module"],
  ["exports", "not a CommonJS module"],
  ["__dirname", "no filesystem context"],
  ["__filename", "no filesystem context"],
  ["Bun", "no Bun global — shell out through an agent instead"],
  ["fetch", "no network primitives in the sandbox"],
  ["eval", "code generation from strings is disallowed by the sandbox"],
]);

/**
 * Strip everything the sandbox never evaluates as script: comments, and the
 * contents of string and template literals. What remains is code the sandbox
 * actually runs, so an identifier found here is really being referenced.
 *
 * Template literals matter most — ship.js legitimately embeds `require('fs')`
 * inside `bun -e` strings, and those run in a real Bun runtime.
 */
function stripNonCode(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, " `` ")
    .replace(/'(?:\\[\s\S]|[^\\'\n])*'/g, " '' ")
    .replace(/"(?:\\[\s\S]|[^\\"\n])*"/g, ' "" ');
}

// 3b. Forbidden-global check — the sandbox does not provide these at all
try {
  const code = stripNonCode(readFileSync(resolved, "utf-8"));
  let forbidden = 0;

  for (const [name, reason] of FORBIDDEN_SANDBOX_GLOBALS) {
    const pattern = new RegExp(`(?<![.\\w$])${name}\\s*[({.[]`, "g");
    const hits = code.match(pattern);
    if (hits) {
      console.error(
        `  ✗ \`${name}\` used ${hits.length}x at workflow top level — ${reason}`,
      );
      forbidden += hits.length;
      errors++;
    }
  }

  if (forbidden === 0) {
    console.log("  ✓ Sandbox globals: no unavailable globals referenced");
  }
} catch (e: any) {
  console.error(`  ✗ Forbidden-global check failed: ${e.message}`);
  errors++;
}

// 4. Check for dangerous inline shell patterns
try {
  const content = readFileSync(resolved, "utf-8");
  const lines = content.split("\n");
  let dangerousPatterns = 0;

  // The SECURITY-HELPERS block is the one sanctioned home for shell
  // construction — it IS the vetted builder. Scanning it flags the fix as the
  // defect, so skip it here and let the behavioural parity tests cover it.
  let inHelpers = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("SECURITY-HELPERS-START")) { inHelpers = true; continue; }
    if (line.includes("SECURITY-HELPERS-END")) { inHelpers = false; continue; }
    if (inHelpers) continue;

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
