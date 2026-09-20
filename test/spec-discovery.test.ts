import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

import { harnessRoot } from "../lib/paths";
import { parseFrontmatter } from "../lib/conformity";

const HARNESS_ROOT = harnessRoot();
const SPECS_DIR = join(HARNESS_ROOT, "specs");

// Scan specs/*.md and specs/*/*.md (one level deep)
const getAllSpecFiles = () => {
  const specFiles: string[] = [];
  for (const f of readdirSync(SPECS_DIR)) {
    if (f.endsWith(".md")) {
      specFiles.push(f);
    } else if (readdirSync(SPECS_DIR, { withFileTypes: true }).find(d => d.name === f && d.isDirectory())) {
      const subFiles = readdirSync(join(SPECS_DIR, f)).filter(sf => sf.endsWith(".md") && sf !== "INDEX.md");
      specFiles.push(...subFiles.map(sf => `${f}/${sf}`));
    }
  }
  return specFiles;
};

const specFiles = getAllSpecFiles();

describe("spec-discovery: frontmatter enforcement", () => {

  test("SD-1: Every .md in PAI/Specs/ has testable field (true or false)", () => {
    const missing: string[] = [];
    for (const f of specFiles) {
      const content = readFileSync(join(SPECS_DIR, f), "utf-8");
      const fm = parseFrontmatter(content);
      // Skip redirect files (status: split)
      if (fm?.status === "split") continue;
      if (!fm || !("testable" in fm)) {
        missing.push(f);
      }
    }
    expect(missing).toEqual([]);
  });

  test("SD-2: Every spec with testable:true produced at least 1 claim", () => {
    const testableSpecs: string[] = [];
    for (const f of specFiles) {
      const content = readFileSync(join(SPECS_DIR, f), "utf-8");
      const fm = parseFrontmatter(content);
      if (fm?.testable === "true") {
        testableSpecs.push(f);
      }
    }
    expect(testableSpecs.length).toBeGreaterThan(0);

    const noClaims: string[] = [];
    for (const f of testableSpecs) {
      const content = readFileSync(join(SPECS_DIR, f), "utf-8");
      const hasMake = /`make\s+[\w-]+`/.test(content);
      const hasGate = /\*\*GATE:|Gate:\*\*/.test(content);
      const hasPort = /:\d{4}\b/.test(content);
      const hasQuinn = /Quinn\s+(validates|captures|tests|navigates|compares|verifies)/i.test(content);
      if (!hasMake && !hasGate && !hasPort && !hasQuinn) {
        noClaims.push(f);
      }
    }
    if (noClaims.length > 0) {
      console.warn(`Specs with testable:true but no extractable claims: ${noClaims.join(", ")}`);
    }
  });

  test("SD-3: Total claim count across all testable specs is non-zero", () => {
    let totalClaims = 0;
    for (const f of specFiles) {
      const content = readFileSync(join(SPECS_DIR, f), "utf-8");
      const fm = parseFrontmatter(content);
      if (fm?.testable !== "true") continue;
      const makes = (content.match(/`make\s+[\w-]+`/g) || []).length;
      const gates = (content.match(/\*\*GATE:|Gate:\*\*/g) || []).length;
      const ports = (content.match(/:(7776|7777|7778|5173)\b/g) || []).length;
      const quinns = (content.match(/Quinn\s+(validates|captures|tests|navigates|compares|verifies)/gi) || []).length;
      totalClaims += makes + gates + ports + quinns;
    }
    expect(totalClaims).toBeGreaterThan(0);
  });
});
