#!/usr/bin/env bun
/**
 * Type check with a ratchet.
 *
 * Issues #65 / #76. AGENTS.md has documented `bunx tsc --noEmit` as THE type
 * check since the repo was created, and `.github/workflows/ci.yml` runs it. With
 * no tsconfig.json, tsc printed 147 lines of help text and exited 1 — so the
 * documented check had never checked a single file, and CI never noticed because
 * `bun test` failed first and the step never ran.
 *
 * Adding tsconfig.json surfaced 88 errors. Fixing all of them is #65 and is a
 * separate body of work, so the choice here is between a step that blocks every
 * merge and a step that cannot fail. Both are bad; a ratchet is neither.
 *
 * It fails two ways, which is what makes it a gate rather than a report:
 *   - MORE errors than the baseline  -> a regression was introduced
 *   - FEWER errors than the baseline -> progress that nobody banked; lower the
 *     baseline in the same commit, or the number quietly drifts back up
 *
 * The baseline is whatever `.claude/typecheck-baseline.json` says; it only ever
 * goes down. 49 of the original 88 were one upstream defect rather than our
 * code — bun-types 1.4.2 makes the test function mandatory on `test.todo`,
 * while Bun's runtime accepts a bodyless `test.todo("label")`. Those are now
 * absorbed by the ambient overload in `test/types/bun-test-todo.d.ts`, so they
 * no longer inflate the count. What remains is ours.
 */

import { spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const BASELINE_FILE = join(ROOT, ".claude", "typecheck-baseline.json");

/** `path/to/file.ts(12,34): error TS1234: message` */
const ERROR_LINE = /^\S.*\(\d+,\d+\): error TS\d+:/;

function countErrors(output: string): number {
  return output.split("\n").filter((l) => ERROR_LINE.test(l)).length;
}

const result = spawnSync("bunx", ["tsc", "--noEmit"], {
  cwd: ROOT,
  encoding: "utf-8",
  // tsc writes diagnostics to stdout; bunx writes install noise to stderr.
  stdio: ["ignore", "pipe", "pipe"],
});

// A spawn failure yields no output, which parses as zero errors. At a baseline
// of zero that would read as a clean typecheck for a check that never ran —
// the precise shape of defect this script exists to prevent. Fail closed.
if (result.error) {
  console.error(`typecheck: could not run tsc: ${result.error.message}`);
  process.exit(1);
}
if (result.status === null) {
  console.error(`typecheck: tsc terminated by signal ${result.signal}`);
  process.exit(1);
}

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

// tsc with no tsconfig prints its help text and exits 1 — the exact failure this
// script exists to make impossible to ship again. Detect it explicitly rather
// than letting "0 errors parsed" read as success.
if (!existsSync(join(ROOT, "tsconfig.json"))) {
  console.error("typecheck: no tsconfig.json — tsc would print help and check nothing.");
  process.exit(1);
}
if (/tsc: The TypeScript Compiler/.test(output)) {
  console.error("typecheck: tsc printed usage instead of checking. Output:\n" + output.slice(0, 500));
  process.exit(1);
}

// tsc reports config-level problems (TS18003 "no inputs were found",
// TS5083 "cannot read file") with no file(line,col) prefix, so ERROR_LINE
// counts zero and the run looks clean. A non-zero baseline masks it; the day
// #65 drives the baseline to 0 it becomes a silent pass for a check that never
// compiled anything. Trust the exit status over the parse.
const actual = countErrors(output);
if (result.status !== 0 && actual === 0) {
  console.error(output);
  console.error(`\ntypecheck: tsc exited ${result.status} but produced no parseable diagnostics — treating as failure, not as a clean run.`);
  process.exit(1);
}

/**
 * A missing baseline is honest (Infinity -> "progress, bank it"). A malformed
 * one is not: `{"error": 88}` or `{"errors": "88"}` made `baseline` undefined
 * or a string, so both comparisons below were false and the script fell
 * through to the success path. A one-character edit to a four-line JSON file
 * silently disabled the gate while still printing "matching baseline".
 */
function readBaseline(): number {
  if (!existsSync(BASELINE_FILE)) return Number.POSITIVE_INFINITY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(BASELINE_FILE, "utf-8"));
  } catch (e) {
    console.error(`typecheck: ${BASELINE_FILE} is not valid JSON: ${(e as Error).message}`);
    process.exit(1);
  }
  const n = (parsed as { errors?: unknown })?.errors;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    console.error(`typecheck: ${BASELINE_FILE} has no integer "errors" field (got ${JSON.stringify(n)}). Refusing to report a result against a baseline I cannot read.`);
    process.exit(1);
  }
  return n;
}

const baseline = readBaseline();

if (process.argv.includes("--update-baseline")) {
  writeFileSync(BASELINE_FILE, JSON.stringify({ errors: actual, updated: new Date().toISOString().split("T")[0] }, null, 2) + "\n");
  console.log(`typecheck: baseline set to ${actual}`);
  process.exit(0);
}

if (actual > baseline) {
  console.error(output);
  console.error(`\ntypecheck: ${actual} errors, baseline is ${baseline}. ${actual - baseline} new error(s) — fix them.`);
  process.exit(1);
}

if (actual < baseline) {
  console.error(
    `typecheck: ${actual} errors, baseline is ${baseline}. ` +
      `Progress — bank it with \`bun scripts/typecheck.ts --update-baseline\` so it cannot regress.`,
  );
  process.exit(1);
}

console.log(`typecheck: ${actual} errors, matching baseline (#65 tracks reducing it).`);
