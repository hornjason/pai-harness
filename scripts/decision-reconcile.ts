#!/usr/bin/env bun
// decision-reconcile.ts — Verify council decisions are present in target documents
// Usage: decision-reconcile.ts <council-synthesis.json> [--target <file>]
// Without --target: checks ALL decisions against their declared targets
// With --target: checks only decisions targeting that specific file

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

interface Decision {
  id: string;
  statement: string;
  target?: {
    ref?: string;
    section?: string;
  };
}

interface Synthesis {
  decisions?: Decision[];
}

type ResultStatus = "FOUND" | "MISSING";

interface Result {
  status: ResultStatus;
  id: string;
  statement: string;
  detail?: string;
}

function expandHome(filepath: string): string {
  return filepath.startsWith("~") ? filepath.replace("~", homedir()) : filepath;
}

function usage(): never {
  console.error(
    "Usage: decision-reconcile.ts <council-synthesis.json> [--target <file>]"
  );
  process.exit(1);
}

// Parse args
const args = process.argv.slice(2);
if (args.length === 0) usage();

const synthesisPath = resolve(args[0]);
let targetFilter = "";

if (args[1] === "--target") {
  if (!args[2]) usage();
  targetFilter = args[2];
}

// Validate synthesis file
if (!existsSync(synthesisPath)) {
  console.error(`FAIL: ${synthesisPath} not found`);
  process.exit(1);
}

let data: Synthesis;
try {
  data = JSON.parse(readFileSync(synthesisPath, "utf-8"));
} catch {
  console.error(`FAIL: ${synthesisPath} is invalid JSON`);
  process.exit(1);
}

const decisions = data.decisions ?? [];
const results: Result[] = [];

for (const d of decisions) {
  const ref = d.target?.ref;
  if (!ref) continue;
  if (targetFilter && ref !== targetFilter) continue;

  const filepath = expandHome(ref);

  if (!existsSync(filepath)) {
    results.push({
      status: "MISSING",
      id: d.id,
      statement: d.statement.slice(0, 60),
      detail: `file not found: ${ref}`,
    });
    continue;
  }

  const content = readFileSync(filepath, "utf-8");

  // Extract key words (>3 chars) from statement, take first 3 as key phrase
  const words = d.statement.split(/\s+/).filter((w) => w.length > 3);
  const keyPhrase = words.slice(0, 3).join(" ");
  const contentLower = content.toLowerCase();

  if (
    keyPhrase.toLowerCase() &&
    contentLower.includes(keyPhrase.toLowerCase())
  ) {
    results.push({
      status: "FOUND",
      id: d.id,
      statement: d.statement.slice(0, 60),
    });
  } else if (content.includes(d.id)) {
    results.push({
      status: "FOUND",
      id: d.id,
      statement: d.statement.slice(0, 60),
    });
  } else {
    // Check section match as fallback
    const section = d.target?.section;
    if (section && contentLower.includes(section.toLowerCase())) {
      results.push({
        status: "FOUND",
        id: d.id,
        statement: d.statement.slice(0, 60),
        detail: "via section match",
      });
    } else {
      results.push({
        status: "MISSING",
        id: d.id,
        statement: d.statement.slice(0, 60),
        detail: `not found in ${ref}`,
      });
    }
  }
}

// Report
let found = 0;
let missing = 0;

for (const r of results) {
  if (r.status === "FOUND") {
    found++;
    const suffix = r.detail ? ` (${r.detail})` : "";
    console.log(`  FOUND: ${r.id} — ${r.statement}${suffix}`);
  } else {
    missing++;
    console.log(`  MISSING: ${r.id} — ${r.statement} (${r.detail})`);
  }
}

console.log("");
console.log(
  `=== Reconcile: ${found} found, ${missing} missing out of ${found + missing} decisions ===`
);
process.exit(missing === 0 ? 0 : 1);
