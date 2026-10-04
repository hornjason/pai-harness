import { describe, test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "precompute-goal.ts");
const AGENTS_DIR = join(import.meta.dir, "..", ".claude", "agents");

describe("context preload parity (#49)", () => {
  test("SC-6: context extraction completes in <5s", () => {
    const start = performance.now();
    execFileSync("bun", [SCRIPT, "--issue", "48", "--repo", "hornjason/pai-harness"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });

  test("SC-7: marcus reinforcement rules match brief content", () => {
    const output = execFileSync("bun", [SCRIPT, "--issue", "48", "--repo", "hornjason/pai-harness"], {
      encoding: "utf-8",
      timeout: 10000,
    });
    const result = JSON.parse(output);
    const marcusRules = result.preloadedContexts?.marcus?.rules || [];

    const briefContent = readFileSync(join(AGENTS_DIR, "marcus.md"), "utf-8");
    const testingSection = briefContent.match(/^## Testing Rules\s*\n([\s\S]*?)(?=\n## |\Z)/m)?.[1] || "";
    const briefRules = testingSection
      .split("\n")
      .filter((l) => l.match(/^\s*[-*\d.]+\s+.+/))
      .map((l) => l.replace(/^\s*[-*\d.]+\s+/, "").trim())
      .filter((r) => r.length > 10);

    expect(marcusRules.length).toBe(briefRules.length);
    for (const rule of briefRules) {
      expect(marcusRules).toContain(rule);
    }
  });

  test("SC-7: discovery reinforcement rules match brief content", () => {
    const output = execFileSync("bun", [SCRIPT, "--issue", "48", "--repo", "hornjason/pai-harness"], {
      encoding: "utf-8",
      timeout: 10000,
    });
    const result = JSON.parse(output);
    const discoveryRules = result.preloadedContexts?.discovery?.rules || [];

    const briefContent = readFileSync(join(AGENTS_DIR, "discovery.md"), "utf-8");
    const fmMatch = briefContent.match(/reinforcement:\s*\[([^\]]+)\]/);
    if (!fmMatch) return;

    const sectionNames: string[] = [];
    const items = fmMatch[1].matchAll(/['"]([^'"]+)['"]/g);
    for (const item of items) sectionNames.push(item[1]);

    let expectedRules: string[] = [];
    for (const name of sectionNames) {
      const re = new RegExp(`^## ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n([\\s\\S]*?)(?=\\n## |\\Z)`, "m");
      const match = briefContent.match(re);
      if (match) {
        const lines = match[1].split("\n");
        let seenBlank = false;
        for (const line of lines) {
          if (line.trim() === "") { seenBlank = true; continue; }
          if (seenBlank) break;
          const ruleMatch = line.match(/^\s*[-*\d.]+\s+(.+)/);
          if (ruleMatch) expectedRules.push(ruleMatch[1].trim());
        }
      }
    }

    expect(discoveryRules.length).toBe(expectedRules.length);
    for (const rule of expectedRules) {
      expect(discoveryRules).toContain(rule);
    }
  });
});
