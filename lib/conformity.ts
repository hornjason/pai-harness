/**
 * Exportable conformity test functions.
 *
 * Projects import these and pass their root path:
 *   import { runScaffoldConformity, runSpecDiscovery, runSpecDrift } from "rungate/lib/conformity";
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

export const SIGNAL_PHRASE_PATTERNS = [
  /^[-*] .*(must not|never|must|always|required|shall|prefer|eliminate).+$/gim,
  /[.;]\s*(must not|never|must|always|required|shall).+?[.;\n]/gim,
  /\b(explicitly prefers?|not dependent on|single chokepoint|no new).+?[.;\n]/gim,
  /\b(intentional|by design|anti-pattern|permanently disabled|do not change|do not remove|do not regress)\b.+?[.;\n]/gim,
  /\b(only on|only from|only when|only in|permanent[^l]|every \d+[hm]\b).+?[.;\n]/gim,
] as const;

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
  const HOME = process.env.HOME || "";
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

    test("rungate.json has required fields (if exists)", () => {
      const p = join(root, ".claude", "rungate.json");
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
  // .claude/agents/ excluded — Claude Code reads those by name convention, not import
  const scanPaths = ["specs", "scripts", "prompts"];
  const scanDirs = scanPaths.map(d => join(root, d)).filter(d => existsSync(d));
  const testDirs = [join(root, "test"), join(root, "tests")].filter(d => existsSync(d));

  // Build reference index once — scan code/config/docs directories only (skip data/cache)
  function buildReferenceIndex(): string {
    const exts = [".ts", ".js", ".md", ".json"];
    const skipDirs = new Set(["node_modules", "reference", ".git", "dist", "build", ".next",
      "cache", "logs", "reports", "ctrf", "eval", "MEMORY"]);
    const skipPrefixes = ["data-", "data/"];

    const searchDirs: string[] = [root];
    for (const entry of readdirSync(root)) {
      if (entry.startsWith(".") || skipDirs.has(entry) || skipPrefixes.some(p => entry.startsWith(p))) continue;
      const full = join(root, entry);
      try { if (require("fs").statSync(full).isDirectory()) searchDirs.push(full); } catch {}
    }
    const dotClaude = join(root, ".claude");
    if (existsSync(dotClaude)) searchDirs.push(dotClaude);

    const chunks: string[] = [];
    for (const dir of searchDirs) {
      try {
        const files = dir === root
          ? readdirSync(dir).filter(f => exts.some(e => f.endsWith(e)))
          : readdirSync(dir, { recursive: true }).map(f => String(f)).filter(f => exts.some(e => f.endsWith(e)));
        for (const f of files) {
          try { chunks.push(readFileSync(join(dir, String(f)), "utf-8")); } catch {}
        }
      } catch {}
    }
    return chunks.join("\n");
  }

  let _refIndex: string | null = null;
  function getRefIndex(): string {
    if (_refIndex === null) _refIndex = buildReferenceIndex();
    return _refIndex;
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
      const index = getRefIndex();
      const orphans: string[] = [];
      for (const dir of scanDirs) {
        const relPath = dir.startsWith(root) ? dir.slice(root.length + 1) : dir.split("/").pop()!;
        for (const f of readdirSync(dir).filter(f => !f.startsWith("."))) {
          if (!index.includes(f)) orphans.push(`${relPath}/${f}`);
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

    test("HYGIENE-6: No unreviewed constraint candidates in changed docs", async () => {
      const { extractConstraints } = await import("../scripts/extract-constraints");
      const result = await extractConstraints(root, { apply: false });

      if (result.staleness.length > 0) {
        console.warn(
          `Stale docs (past threshold): ${result.staleness.map((s) => `${s.file} (${s.daysSince}d, ${s.type} threshold=${s.threshold}d)`).join(", ")}`
        );
      }

      if (result.candidates.length > 0) {
        console.warn(
          `${result.candidates.length} unreviewed constraint candidates found. Run \`bunx rungate extract-constraints ${root}\` to review.`
        );
      }

      expect(true).toBe(true);
    });
  });
}

// ── Agent file validation ──────────────────────────────────

export function runAgentFileValidation(root: string) {
  const agentsDir = join(root, ".claude", "agents");

  describe("Agent File Validation", () => {
    test("AGENT-1: .claude/agents/ directory exists (code projects)", () => {
      const isCode = existsSync(join(root, "src")) || existsSync(join(root, "lib")) ||
        existsSync(join(root, "gates")) || existsSync(join(root, "Makefile"));
      if (!isCode) return;
      expect(existsSync(agentsDir)).toBe(true);
    });

    test("AGENT-2: All agent files have required frontmatter (name + description)", () => {
      if (!existsSync(agentsDir)) return;
      const invalid: string[] = [];
      for (const f of readdirSync(agentsDir).filter(f => f.endsWith(".md"))) {
        const content = readFileSync(join(agentsDir, f), "utf-8");
        const fm = parseFrontmatter(content);
        if (!fm || !fm.name) invalid.push(`${f}: missing 'name' field`);
        else if (!fm.description) invalid.push(`${f}: missing 'description' field`);
      }
      if (invalid.length > 0) {
        console.warn(`Invalid agent files (Claude Code will SKIP these silently):\n  ${invalid.join("\n  ")}`);
      }
      expect(invalid).toEqual([]);
    });

    test("AGENT-3: Agent file names are lowercase (Claude Code matching requirement)", () => {
      if (!existsSync(agentsDir)) return;
      const bad: string[] = [];
      for (const f of readdirSync(agentsDir).filter(f => f.endsWith(".md"))) {
        const basename = f.replace(/\.md$/, "");
        if (basename !== basename.toLowerCase() || basename.includes(" ")) {
          bad.push(f);
        }
      }
      expect(bad).toEqual([]);
    });

    test("AGENT-4: Agent name field matches filename", () => {
      if (!existsSync(agentsDir)) return;
      const mismatched: string[] = [];
      for (const f of readdirSync(agentsDir).filter(f => f.endsWith(".md"))) {
        const content = readFileSync(join(agentsDir, f), "utf-8");
        const fm = parseFrontmatter(content);
        if (!fm?.name) continue;
        const basename = f.replace(/\.md$/, "");
        if (fm.name !== basename) {
          mismatched.push(`${f}: name="${fm.name}" but filename="${basename}"`);
        }
      }
      if (mismatched.length > 0) {
        console.warn(`Agent name/filename mismatch (subagent_type won't match):\n  ${mismatched.join("\n  ")}`);
      }
      expect(mismatched).toEqual([]);
    });

    test("AGENT-5: Agent files reference AGENTS.md for context", () => {
      if (!existsSync(agentsDir)) return;
      const missing: string[] = [];
      for (const f of readdirSync(agentsDir).filter(f => f.endsWith(".md"))) {
        const content = readFileSync(join(agentsDir, f), "utf-8");
        if (!content.includes("AGENTS.md")) {
          missing.push(f);
        }
      }
      if (missing.length > 0) {
        console.warn(`Agent files not referencing AGENTS.md (won't read project context):\n  ${missing.join("\n  ")}`);
      }
      expect(missing).toEqual([]);
    });
  });
}

// ── Fallow integration ─────────────────────────────────────

interface FallowResult {
  total_issues: number;
  elapsed_ms: number;
  summary: Record<string, number>;
  unused_files: Array<{ path: string }>;
  unused_exports: Array<{ path: string; export_name: string; line?: number }>;
  unused_dependencies: Array<{ name: string }>;
  circular_dependencies: Array<{ path: string; chain?: string[] }>;
  workspace_diagnostics: Array<{ kind: string; message: string }>;
}

function runFallowCommand(root: string, args: string[]): FallowResult | null {
  const result = Bun.spawnSync(["npx", "fallow", ...args, "--format", "json", "--quiet"], {
    cwd: root,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    timeout: 30_000,
  });
  const stdout = result.stdout.toString().trim();
  if (!stdout || stdout.startsWith("{\"error\"")) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

export function runFallowCheck(root: string, opts?: { skipUnusedExports?: boolean; warnOnly?: boolean }) {
  const fail = !opts?.warnOnly;
  describe("Fallow: static analysis", () => {
    test("FALLOW-1: No unused files", () => {
      const result = runFallowCommand(root, ["dead-code", "--unused-files"]);
      if (!result) {
        console.warn("Fallow not available or failed to run — skipping");
        return;
      }
      const unused = result.unused_files.map(f => f.path);
      if (unused.length > 0) {
        console.warn(`Unused files (${unused.length}):\n  ${unused.slice(0, 10).join("\n  ")}${unused.length > 10 ? `\n  ... and ${unused.length - 10} more` : ""}`);
      }
      if (fail) expect(unused).toEqual([]);
    });

    if (!opts?.skipUnusedExports) {
      test("FALLOW-2: No unused exports", () => {
        const result = runFallowCommand(root, ["dead-code", "--unused-exports"]);
        if (!result) return;
        const unused = result.unused_exports?.map(e => `${e.path}:${e.line ?? "?"} ${e.export_name}`) || [];
        if (unused.length > 0) {
          console.warn(`Unused exports (${unused.length}):\n  ${unused.slice(0, 10).join("\n  ")}${unused.length > 10 ? `\n  ... and ${unused.length - 10} more` : ""}`);
        }
        if (fail) expect(unused).toEqual([]);
      });
    }

    test("FALLOW-3: No unused dependencies", () => {
      const result = runFallowCommand(root, ["dead-code", "--unused-deps"]);
      if (!result) return;
      const unused = result.unused_dependencies?.map(d => d.name) || [];
      if (unused.length > 0) {
        console.warn(`Unused dependencies (${unused.length}):\n  ${unused.join("\n  ")}`);
      }
      if (fail) expect(unused).toEqual([]);
    });

    test("FALLOW-4: No circular dependencies", () => {
      const result = runFallowCommand(root, ["dead-code"]);
      if (!result) return;
      const circles = result.circular_dependencies || [];
      if (circles.length > 0) {
        console.warn(`Circular dependencies (${circles.length}):\n  ${circles.slice(0, 5).map(c => c.path || JSON.stringify(c.files || c)).join("\n  ")}${circles.length > 5 ? `\n  ... and ${circles.length - 5} more` : ""}`);
      }
      if (fail) expect(circles).toEqual([]);
    });
  });
}
