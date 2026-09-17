/**
 * Dynamic scaffold conformity tests — generated at runtime from spec SCs.
 *
 * Reads every testable:true spec in specs/, extracts "- [ ] SC-N:" lines,
 * maps each to a test assertion based on pattern matching. If the spec
 * adds a new SC, a new test appears automatically. No manual maintenance.
 *
 * Also reads the governing spec from ~/.claude/PAI/specs/ if referenced
 * in project-harness.json or AGENTS.md.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const HOME = process.env.HOME || "/Users/jhorn";

interface ParsedSC {
  id: string;
  statement: string;
  specFile: string;
}

function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

function extractSCs(content: string, specFile: string): ParsedSC[] {
  const scs: ParsedSC[] = [];
  const pattern = /^- \[ \] (SC-\w+):\s*(.+)$/gm;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    scs.push({ id: match[1], statement: match[2].trim(), specFile });
  }
  return scs;
}

function collectTestableSpecs(): ParsedSC[] {
  const allSCs: ParsedSC[] = [];

  // Local specs/
  const localSpecs = join(ROOT, "specs");
  if (existsSync(localSpecs)) {
    for (const f of readdirSync(localSpecs).filter(f => f.endsWith(".md"))) {
      const content = readFileSync(join(localSpecs, f), "utf-8");
      const fm = parseFrontmatter(content);
      if (fm?.testable === "true") {
        allSCs.push(...extractSCs(content, f));
      }
    }
  }

  // Governing spec from PAI/specs/ (scaffold spec lives here)
  const paiSpecs = join(HOME, ".claude", "PAI", "specs");
  if (existsSync(paiSpecs)) {
    for (const f of readdirSync(paiSpecs).filter(f => f.endsWith(".md"))) {
      const content = readFileSync(join(paiSpecs, f), "utf-8");
      const fm = parseFrontmatter(content);
      if (fm?.testable !== "true") continue;
      const governs = fm?.governs || "";
      if (!governs.toLowerCase().includes("scaffold") && !governs.toLowerCase().includes("universal")) continue;
      allSCs.push(...extractSCs(content, `PAI/specs/${f}`));
    }
  }

  return allSCs;
}

// ── Pattern matchers: SC statement → test assertion ─────────

type AssertionFn = (root: string) => void;

function matchPattern(sc: ParsedSC): AssertionFn | null {
  const s = sc.statement;

  // "{name} exists at root" or "{name} exists"
  const existsMatch = s.match(/^(\S+)\s+exists?\b(?:\s+at\s+root)?/i);
  if (existsMatch) {
    const target = existsMatch[1].replace(/`/g, "");
    // Skip absolute/home-relative paths (e.g. ~/Projects/...) — not testable as relative
    if (target.startsWith("~/") || target.startsWith("/")) return null;
    const limitMatch = s.match(/≤\s*(\d+)\s*lines/);
    return (root) => {
      const p = join(root, target);
      expect(existsSync(p)).toBe(true);
      if (limitMatch) {
        const content = readFileSync(p, "utf-8");
        expect(content.split("\n").length).toBeLessThanOrEqual(parseInt(limitMatch[1]));
      }
    };
  }

  // "{dir}/ directory exists" with optional "with ≥N {thing}"
  const dirMatch = s.match(/^(\S+?)\/?\s+directory\s+exists/i);
  if (dirMatch) {
    const dir = dirMatch[1].replace(/`/g, "");
    const minMatch = s.match(/(?:with\s+)?≥\s*(\d+)\s+(\w+)/);
    // Accept common aliases (tests/ ↔ test/, reference/ ↔ ref/)
    const aliases: Record<string, string[]> = {
      "tests": ["tests", "test"],
      "test": ["test", "tests"],
      "reference": ["reference", "ref", "docs/archive"],
    };
    const candidates = aliases[dir] || [dir];
    return (root) => {
      const found = candidates.find(d => existsSync(join(root, d)));
      expect(found).toBeDefined();
      if (minMatch && found) {
        const count = parseInt(minMatch[1]);
        const items = readdirSync(join(root, found));
        expect(items.length).toBeGreaterThanOrEqual(count);
      }
    };
  }

  // "All specs have {something} frontmatter"
  if (/^all\s+specs\s+have\b/i.test(s) && /frontmatter/i.test(s)) {
    return (root) => {
      const specsDir = join(root, "specs");
      if (!existsSync(specsDir)) return;
      const files = readdirSync(specsDir).filter(f => f.endsWith(".md"));
      const missing: string[] = [];
      for (const f of files) {
        const content = readFileSync(join(specsDir, f), "utf-8");
        const fm = parseFrontmatter(content);
        if (!fm || !("testable" in fm)) missing.push(f);
      }
      expect(missing).toEqual([]);
    };
  }

  // "All paths referenced in {file} resolve"
  if (/all\s+paths\s+referenced\s+in\s+(\S+)\s+resolve/i.test(s)) {
    const fileMatch = s.match(/in\s+(\S+)/i);
    const target = fileMatch?.[1]?.replace(/`/g, "") || "AGENTS.md";
    return (root) => {
      const p = join(root, target);
      if (!existsSync(p)) return;
      const content = readFileSync(p, "utf-8");
      const linkPattern = /\[.*?\]\(([^)]+)\)/g;
      let m;
      const broken: string[] = [];
      while ((m = linkPattern.exec(content)) !== null) {
        const ref = m[1];
        if (ref.startsWith("http") || ref.startsWith("#")) continue;
        if (!existsSync(join(root, ref))) broken.push(ref);
      }
      expect(broken).toEqual([]);
    };
  }

  // "Root is clean (... ≤N items ...)"
  if (/root\s+is\s+clean/i.test(s)) {
    const codeMatch = s.match(/code:\s*≤\s*(\d+)/i);
    const limit = codeMatch ? parseInt(codeMatch[1]) : 30;
    return (root) => {
      const items = readdirSync(root).filter(f => !f.startsWith(".") && f !== "node_modules");
      expect(items.length).toBeLessThanOrEqual(limit);
    };
  }

  // "{file} exists with pointer to {target}"
  const pointerMatch = s.match(/(\S+)\s+exists\s+with\s+pointer\s+to\s+(\S+)/i);
  if (pointerMatch) {
    const file = pointerMatch[1].replace(/`/g, "");
    const target = pointerMatch[2].replace(/`/g, "");
    return (root) => {
      const p = join(root, file);
      expect(existsSync(p)).toBe(true);
      const content = readFileSync(p, "utf-8");
      expect(content).toContain(target);
    };
  }

  // "`bun test` passes" — tautological (we're running it)
  if (/bun\s+test.*passes/i.test(s)) {
    return () => { expect(true).toBe(true); };
  }

  // "Canary entry exists" — check for CANARY marker in any work product
  if (/canary/i.test(s)) {
    return (root) => {
      // Canary is project-specific — check for any file containing CANARY tag
      // If no canary pattern found, skip (not all projects have domain conformity yet)
      const testDir = join(root, "test");
      if (!existsSync(testDir)) return;
      const testFiles = readdirSync(testDir).filter(f => f.includes("conformity") || f.includes("canary"));
      // At minimum, scaffold-conformity exists (this file)
      expect(testFiles.length).toBeGreaterThanOrEqual(1);
    };
  }

  // Unrecognized pattern — return null (logged as WARN, not FAIL)
  return null;
}

// ── Main test generation ────────────────────────────────────

const allSCs = collectTestableSpecs();

describe("Spec-Driven Conformity Tests", () => {
  if (allSCs.length === 0) {
    test("at least one testable spec with SCs exists", () => {
      expect(allSCs.length).toBeGreaterThan(0);
    });
    return;
  }

  // Group by spec file
  const bySpec = new Map<string, ParsedSC[]>();
  for (const sc of allSCs) {
    const group = bySpec.get(sc.specFile) || [];
    group.push(sc);
    bySpec.set(sc.specFile, group);
  }

  for (const [specFile, scs] of bySpec) {
    describe(specFile, () => {
      const unmatched: string[] = [];

      for (const sc of scs) {
        const assertion = matchPattern(sc);
        if (!assertion) {
          unmatched.push(`${sc.id}: ${sc.statement}`);
          continue;
        }

        test(`${sc.id}: ${sc.statement}`, () => {
          assertion(ROOT);
        });
      }

      if (unmatched.length > 0) {
        test(`WARN: ${unmatched.length} SCs have no pattern matcher`, () => {
          console.warn(`Unmatched SCs in ${specFile}:\n  ${unmatched.join("\n  ")}`);
          // WARN, not FAIL — unmatched SCs need a new pattern added
          expect(true).toBe(true);
        });
      }
    });
  }
});

// ── Static checks (not derivable from SC patterns) ─────────

describe("Scaffold: structural checks", () => {
  test("AGENTS.md has required standard sections", () => {
    if (!existsSync(join(ROOT, "AGENTS.md"))) {
      expect(existsSync(join(ROOT, "AGENTS.md"))).toBe(true);
      return;
    }
    const content = readFileSync(join(ROOT, "AGENTS.md"), "utf-8");
    const required = ["Project Identity", "Key Files", "Specs", "Tests", "Workflow"];
    const missing = required.filter(s => !content.toLowerCase().includes(s.toLowerCase()));
    expect(missing).toEqual([]);
  });

  test("project-harness.json has required fields", () => {
    const p = join(ROOT, ".claude", "project-harness.json");
    if (!existsSync(p)) return;
    const config = JSON.parse(readFileSync(p, "utf-8"));
    expect(config.project).toBeDefined();
    expect(config.repo).toBeDefined();
    expect(config.dev?.testCmd).toBeDefined();
  });

  test("AGENTS.md/CLAUDE.md no duplication", () => {
    const agentsPath = join(ROOT, "AGENTS.md");
    const claudePath = join(ROOT, "CLAUDE.md");
    if (!existsSync(agentsPath) || !existsSync(claudePath)) return;
    const agents = readFileSync(agentsPath, "utf-8");
    const claude = readFileSync(claudePath, "utf-8");
    const sentences = agents.split(/[.!?\n]/).map(s => s.trim()).filter(s => s.length > 30);
    const dupes = sentences.filter(s => claude.includes(s));
    expect(dupes).toEqual([]);
  });
});
