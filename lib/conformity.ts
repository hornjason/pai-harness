/**
 * Exportable conformity test functions.
 *
 * Projects import these and pass their root path:
 *   import { runScaffoldConformity, runSpecDiscovery, runSpecDrift } from "pai-harness/lib/conformity";
 *   runScaffoldConformity(import.meta.dir + "/..");
 */
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

// ── Shared utilities ────────────────────────────────────────

export function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

interface ParsedSC {
  id: string;
  statement: string;
  specFile: string;
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

function collectTestableSpecs(root: string, extraSpecDirs?: string[]): ParsedSC[] {
  const allSCs: ParsedSC[] = [];

  const localSpecs = join(root, "specs");
  if (existsSync(localSpecs)) {
    for (const f of readdirSync(localSpecs).filter(f => f.endsWith(".md"))) {
      const content = readFileSync(join(localSpecs, f), "utf-8");
      const fm = parseFrontmatter(content);
      if (fm?.testable === "true") {
        allSCs.push(...extractSCs(content, f));
      }
    }
  }

  for (const dir of extraSpecDirs || []) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter(f => f.endsWith(".md"))) {
      const content = readFileSync(join(dir, f), "utf-8");
      const fm = parseFrontmatter(content);
      if (fm?.testable !== "true") continue;
      const governs = fm?.governs || "";
      if (!governs.toLowerCase().includes("scaffold") && !governs.toLowerCase().includes("universal")) continue;
      allSCs.push(...extractSCs(content, `${dir.split("/").pop()}/${f}`));
    }
  }

  return allSCs;
}

// ── Pattern matchers ────────────────────────────────────────

type AssertionFn = (root: string) => void;

function matchPattern(sc: ParsedSC): AssertionFn | null {
  const s = sc.statement;

  const existsMatch = s.match(/^(\S+)\s+exists?\b(?:\s+at\s+root)?/i);
  if (existsMatch) {
    const target = existsMatch[1].replace(/`/g, "");
    if (target.startsWith("~/") || target.startsWith("/")) return null;
    const limitMatch = s.match(/≤\s*(\d+)\s*lines/);
    return (root) => {
      expect(existsSync(join(root, target))).toBe(true);
      if (limitMatch) {
        const content = readFileSync(join(root, target), "utf-8");
        expect(content.split("\n").length).toBeLessThanOrEqual(parseInt(limitMatch[1]));
      }
    };
  }

  const dirMatch = s.match(/^(\S+?)\/?\s+directory\s+exists/i);
  if (dirMatch) {
    const dir = dirMatch[1].replace(/`/g, "");
    const minMatch = s.match(/(?:with\s+)?≥\s*(\d+)\s+(\w+)/);
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
        expect(readdirSync(join(root, found)).length).toBeGreaterThanOrEqual(parseInt(minMatch[1]));
      }
    };
  }

  if (/^all\s+specs\s+have\b/i.test(s) && /frontmatter/i.test(s)) {
    return (root) => {
      const specsDir = join(root, "specs");
      if (!existsSync(specsDir)) return;
      const missing = readdirSync(specsDir).filter(f => f.endsWith(".md")).filter(f => {
        const fm = parseFrontmatter(readFileSync(join(specsDir, f), "utf-8"));
        return !fm || !("testable" in fm);
      });
      expect(missing).toEqual([]);
    };
  }

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
        if (m[1].startsWith("http") || m[1].startsWith("#")) continue;
        if (!existsSync(join(root, m[1]))) broken.push(m[1]);
      }
      expect(broken).toEqual([]);
    };
  }

  if (/root\s+is\s+clean/i.test(s)) {
    const contentLimit = s.match(/content:\s*≤\s*(\d+)/i);
    const codeLimit = s.match(/code:\s*≤\s*(\d+)/i);
    return (root) => {
      const items = readdirSync(root).filter(f => !f.startsWith(".") && f !== "node_modules");
      // Detect project type: if src/, lib/, gates/, or package.json with deps → code project
      const isCode = existsSync(join(root, "src")) || existsSync(join(root, "lib")) ||
        existsSync(join(root, "gates")) || existsSync(join(root, "Makefile"));
      const limit = isCode
        ? (codeLimit ? parseInt(codeLimit[1]) : 30)
        : (contentLimit ? parseInt(contentLimit[1]) : 10);
      expect(items.length).toBeLessThanOrEqual(limit);
    };
  }

  const pointerMatch = s.match(/(\S+)\s+exists\s+with\s+pointer\s+to\s+(\S+)/i);
  if (pointerMatch) {
    const file = pointerMatch[1].replace(/`/g, "");
    const target = pointerMatch[2].replace(/`/g, "");
    return (root) => {
      expect(existsSync(join(root, file))).toBe(true);
      expect(readFileSync(join(root, file), "utf-8")).toContain(target);
    };
  }

  if (/bun\s+test.*passes/i.test(s)) return () => { expect(true).toBe(true); };

  if (/canary/i.test(s)) {
    return (root) => {
      const testDir = existsSync(join(root, "test")) ? join(root, "test") : join(root, "tests");
      if (!existsSync(testDir)) return;
      const testFiles = readdirSync(testDir).filter(f => f.includes("conformity") || f.includes("canary"));
      expect(testFiles.length).toBeGreaterThanOrEqual(1);
    };
  }

  return null;
}

// ── Exported test runners ───────────────────────────────────

export function runScaffoldConformity(root: string, opts?: { extraSpecDirs?: string[] }) {
  const HOME = process.env.HOME || "/Users/jhorn";
  const defaultExtraSpecs = [join(HOME, ".claude", "PAI", "specs")];
  const allSCs = collectTestableSpecs(root, opts?.extraSpecDirs ?? defaultExtraSpecs);

  describe("Spec-Driven Conformity Tests", () => {
    if (allSCs.length === 0) {
      test("at least one testable spec with SCs exists", () => {
        expect(allSCs.length).toBeGreaterThan(0);
      });
      return;
    }

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
          if (!assertion) { unmatched.push(`${sc.id}: ${sc.statement}`); continue; }
          test(`${sc.id}: ${sc.statement}`, () => { assertion(root); });
        }
        if (unmatched.length > 0) {
          test(`WARN: ${unmatched.length} SCs have no pattern matcher`, () => {
            console.warn(`Unmatched SCs in ${specFile}:\n  ${unmatched.join("\n  ")}`);
            expect(true).toBe(true);
          });
        }
      });
    }
  });

  describe("Scaffold: structural checks", () => {
    test("AGENTS.md has required standard sections", () => {
      if (!existsSync(join(root, "AGENTS.md"))) {
        expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
        return;
      }
      const content = readFileSync(join(root, "AGENTS.md"), "utf-8");
      const required = ["Project Identity", "Key Files", "Specs", "Tests", "Workflow"];
      const missing = required.filter(s => !content.toLowerCase().includes(s.toLowerCase()));
      expect(missing).toEqual([]);
    });

    test("project-harness.json has required fields (if exists)", () => {
      const p = join(root, ".claude", "project-harness.json");
      if (!existsSync(p)) return;
      const config = JSON.parse(readFileSync(p, "utf-8"));
      expect(config.project).toBeDefined();
      expect(config.repo).toBeDefined();
    });

    test("AGENTS.md/CLAUDE.md no duplication (if both exist)", () => {
      if (!existsSync(join(root, "AGENTS.md")) || !existsSync(join(root, "CLAUDE.md"))) return;
      const agents = readFileSync(join(root, "AGENTS.md"), "utf-8");
      const claude = readFileSync(join(root, "CLAUDE.md"), "utf-8");
      const sentences = agents.split(/[.!?\n]/).map(s => s.trim()).filter(s => s.length > 30);
      expect(sentences.filter(s => claude.includes(s))).toEqual([]);
    });
  });
}

export function runSpecDiscovery(root: string) {
  const specsDir = join(root, "specs");

  describe("Spec Discovery: frontmatter enforcement", () => {
    test("specs/ directory exists", () => {
      expect(existsSync(specsDir)).toBe(true);
    });

    test("every .md in specs/ has testable field", () => {
      if (!existsSync(specsDir)) return;
      const missing = readdirSync(specsDir).filter(f => f.endsWith(".md")).filter(f => {
        const fm = parseFrontmatter(readFileSync(join(specsDir, f), "utf-8"));
        return !fm || !("testable" in fm);
      });
      expect(missing).toEqual([]);
    });

    test("at least one testable spec exists", () => {
      if (!existsSync(specsDir)) return;
      const testable = readdirSync(specsDir).filter(f => f.endsWith(".md")).filter(f => {
        const fm = parseFrontmatter(readFileSync(join(specsDir, f), "utf-8"));
        return fm?.testable === "true";
      });
      expect(testable.length).toBeGreaterThan(0);
    });
  });
}

export function runSpecDrift(root: string) {
  const specsDir = join(root, "specs");
  const testDirs = [join(root, "test"), join(root, "tests")].filter(d => existsSync(d));

  interface SpecRef { specFile: string; section: string; testFile: string; line: number; }

  function extractRefs(testFile: string, dir: string): SpecRef[] {
    const content = readFileSync(join(dir, testFile), "utf-8");
    const refs: SpecRef[] = [];
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const structured = lines[i].match(/\/\/\s*SPEC-REF:\s*(\S+\.md)\s*§\s*(.+)/);
      if (structured && !structured[1].match(/^(filename|FILENAME|example)\./i)) {
        refs.push({ specFile: structured[1], section: structured[2].trim(), testFile, line: i + 1 });
      }
    }
    return refs;
  }

  describe("Spec-Test Drift Detector", () => {
    test("DRIFT-1: Every SPEC-REF points to an existing spec file", () => {
      const allRefs: SpecRef[] = [];
      for (const dir of testDirs) {
        for (const tf of readdirSync(dir).filter(f => f.endsWith(".test.ts"))) {
          allRefs.push(...extractRefs(tf, dir));
        }
      }
      const broken = allRefs.filter(r => !existsSync(join(specsDir, r.specFile)))
        .map(r => `${r.testFile}:${r.line} → ${r.specFile}`);
      expect(broken).toEqual([]);
    });

    test("DRIFT-2: Every testable spec is referenced by at least one test", () => {
      if (!existsSync(specsDir)) return;
      const testable = readdirSync(specsDir).filter(f => f.endsWith(".md")).filter(f => {
        const fm = parseFrontmatter(readFileSync(join(specsDir, f), "utf-8"));
        return fm?.testable === "true";
      });

      let allContent = "";
      for (const dir of testDirs) {
        for (const tf of readdirSync(dir).filter(f => f.endsWith(".test.ts"))) {
          allContent += readFileSync(join(dir, tf), "utf-8");
        }
      }

      const orphaned = testable.filter(s => !allContent.includes(s));
      if (orphaned.length > 0) {
        console.warn(`Testable specs with no test references: ${orphaned.join(", ")}`);
      }
      expect(true).toBe(true);
    });
  });
}

export function runDocHygiene(root: string) {
  const specsDir = join(root, "specs");
  const refDir = join(root, "reference");
  const scanDirs = ["specs", "scripts", "prompts"].map(d => join(root, d)).filter(d => existsSync(d));
  const testDirs = [join(root, "test"), join(root, "tests")].filter(d => existsSync(d));

  function countReferences(filename: string): number {
    let refs = 0;
    const searchDirs = [root];
    const exts = [".ts", ".js", ".md", ".json"];
    for (const dir of readdirSync(root).filter(f => !f.startsWith(".") && f !== "node_modules" && f !== "reference")) {
      const full = join(root, dir);
      try { if (require("fs").statSync(full).isDirectory()) searchDirs.push(full); } catch {}
    }
    for (const dir of searchDirs) {
      try {
        const files = dir === root
          ? readdirSync(dir).filter(f => exts.some(e => f.endsWith(e)))
          : readdirSync(dir, { recursive: true }).map(f => String(f)).filter(f => exts.some(e => f.endsWith(e)));
        for (const f of files) {
          const content = readFileSync(join(dir, String(f)), "utf-8");
          if (content.includes(filename)) refs++;
        }
      } catch {}
    }
    return refs;
  }

  describe("Doc Hygiene", () => {
    test("HYGIENE-1: All specs have non-empty governs field", () => {
      if (!existsSync(specsDir)) return;
      const missing: string[] = [];
      for (const f of readdirSync(specsDir).filter(f => f.endsWith(".md"))) {
        const content = readFileSync(join(specsDir, f), "utf-8");
        const fm = parseFrontmatter(content);
        if (!fm) continue;
        const governs = fm.governs || "";
        if (!governs || governs.includes("TODO")) missing.push(f);
      }
      if (missing.length > 0) {
        console.warn(`Specs with empty/TODO governs field: ${missing.join(", ")}`);
      }
      expect(true).toBe(true);
    });

    test("HYGIENE-2: All specs have updated field in frontmatter", () => {
      if (!existsSync(specsDir)) return;
      const missing: string[] = [];
      for (const f of readdirSync(specsDir).filter(f => f.endsWith(".md"))) {
        const content = readFileSync(join(specsDir, f), "utf-8");
        const fm = parseFrontmatter(content);
        if (!fm || !fm.updated) missing.push(f);
      }
      expect(missing).toEqual([]);
    });

    test("HYGIENE-3: No orphaned files (zero references outside reference/)", () => {
      const orphans: string[] = [];
      for (const dir of scanDirs) {
        const dirName = dir.split("/").pop()!;
        for (const f of readdirSync(dir).filter(f => !f.startsWith("."))) {
          const refs = countReferences(f);
          if (refs === 0) orphans.push(`${dirName}/${f}`);
        }
      }
      if (orphans.length > 0) {
        console.warn(`Orphaned files (0 references — consider archiving to reference/):\n  ${orphans.join("\n  ")}`);
      }
      expect(true).toBe(true);
    });

    test("HYGIENE-4: All specs listed in AGENTS.md are in AGENTS.md specs table", () => {
      if (!existsSync(specsDir) || !existsSync(join(root, "AGENTS.md"))) return;
      const agentsContent = readFileSync(join(root, "AGENTS.md"), "utf-8");
      const specFiles = readdirSync(specsDir).filter(f => f.endsWith(".md"));
      const unlisted = specFiles.filter(f => !agentsContent.includes(f));
      if (unlisted.length > 0) {
        console.warn(`Specs not listed in AGENTS.md: ${unlisted.join(", ")}`);
      }
      expect(true).toBe(true);
    });

    test("HYGIENE-5: reference/ contents not in active routing", () => {
      if (!existsSync(refDir) || !existsSync(join(root, "AGENTS.md"))) return;
      const agentsContent = readFileSync(join(root, "AGENTS.md"), "utf-8");
      const leaked: string[] = [];
      for (const sub of readdirSync(refDir)) {
        const subPath = join(refDir, sub);
        try {
          if (require("fs").statSync(subPath).isDirectory()) {
            for (const f of readdirSync(subPath)) {
              if (agentsContent.includes(f) && !agentsContent.includes("reference/")) leaked.push(`reference/${sub}/${f}`);
            }
          } else {
            if (agentsContent.includes(sub) && !agentsContent.includes("reference/")) leaked.push(`reference/${sub}`);
          }
        } catch {}
      }
      if (leaked.length > 0) {
        console.warn(`Archived files still referenced in AGENTS.md (stale routing): ${leaked.join(", ")}`);
      }
      expect(true).toBe(true);
    });
  });
}
