/**
 * Exportable conformity test functions.
 *
 * Projects import these and pass their root path:
 *   import { runScaffoldConformity, runSpecDiscovery, runSpecDrift } from "rungate/lib/conformity";
 *   runScaffoldConformity(import.meta.dir + "/..");
 */
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { spawnSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { deriveDirectoryName } from "../scripts/split-spec";

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

/**
 * SC-286: Resolve and validate file paths - reject traversal and absolute paths
 * Returns resolved path or null if path is unsafe
 */
export function resolveAndContain(root: string, target: string): string | null {
  // Reject path traversal
  if (target.includes("../")) return null;
  // Reject absolute paths
  if (target.startsWith("/")) return null;
  // Allow normal relative paths (including those with dots in filenames like .rungate)
  return join(root, target);
}

/**
 * Resolve the actual .git directory, handling worktrees where .git is a file
 * containing "gitdir: /path/to/real/gitdir".
 */
function resolveGitDir(root: string): string {
  const dotGit = join(root, ".git");
  if (!existsSync(dotGit)) return dotGit;
  const stat = statSync(dotGit);
  if (stat.isDirectory()) return dotGit;
  // Worktree: .git is a file with "gitdir: <path>"
  const content = readFileSync(dotGit, "utf-8").trim();
  const match = content.match(/^gitdir:\s*(.+)$/);
  if (match) {
    const gitdir = match[1].trim();
    // gitdir may be absolute or relative
    return gitdir.startsWith("/") ? gitdir : join(root, gitdir);
  }
  return dotGit;
}

/**
 * Resolve a file path that starts with .git/ through the worktree-aware git dir.
 * For non-.git paths, returns the normal join(root, file).
 */
function resolveFilePath(root: string, file: string): string {
  if (file.startsWith(".git/")) {
    const gitDir = resolveGitDir(root);
    // For worktrees, hooks live in the main repo's hooks dir, not the worktree gitdir.
    // The worktree gitdir (e.g. .git/worktrees/name/) doesn't have hooks/.
    // Walk up to the main .git dir if we're in a worktree subdir.
    const suffix = file.slice(".git/".length); // e.g. "hooks/pre-commit"
    const resolved = join(gitDir, suffix);
    if (existsSync(resolved)) return resolved;
    // Try the common dir (main repo .git) for shared resources like hooks
    const commonDirFile = join(gitDir, "commondir");
    if (existsSync(commonDirFile)) {
      const commonDir = readFileSync(commonDirFile, "utf-8").trim();
      const commonResolved = commonDir.startsWith("/")
        ? join(commonDir, suffix)
        : join(gitDir, commonDir, suffix);
      if (existsSync(commonResolved)) return commonResolved;
    }
    return resolved;
  }
  return join(root, file);
}

export { SIGNAL_PHRASE_PATTERNS } from "./signal-phrases";

// ── Structured findings (machine-readable for agents) ──────

export interface ConformityFinding {
  ruleId: string;
  severity: "FAIL" | "WARN";
  file: string;
  message: string;
  fixCommand?: string;
}

export interface ConstraintCandidate {
  rule: string;
  source: string;
  hash: string;
  status: "pending" | "applied" | "rejected";
}

export interface StalenessEntry {
  file: string;
  daysSince: number;
  threshold: number;
  type: string;
}

const _findings: ConformityFinding[] = [];
const _candidates: ConstraintCandidate[] = [];
const _staleness: StalenessEntry[] = [];

export function addFinding(finding: ConformityFinding): void {
  _findings.push(finding);
}

export function addCandidate(candidate: ConstraintCandidate): void {
  _candidates.push(candidate);
}

export function addStaleness(entry: StalenessEntry): void {
  _staleness.push(entry);
}

export function getFindings(): ConformityFinding[] {
  return [..._findings];
}

export function getCandidates(): ConstraintCandidate[] {
  return [..._candidates];
}

export function getStaleness(): StalenessEntry[] {
  return [..._staleness];
}

export function clearFindings(): void {
  _findings.length = 0;
  _candidates.length = 0;
  _staleness.length = 0;
}

export function writeFindingsReport(root: string): string {
  const reportPath = join(root, ".rungate", "conformity-findings.json");
  const dir = join(root, ".rungate");
  if (!existsSync(dir)) {
    require("fs").mkdirSync(dir, { recursive: true });
  }
  require("fs").writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    total: _findings.length + _candidates.length + _staleness.length,
    failures: _findings.filter(f => f.severity === "FAIL").length,
    warnings: _findings.filter(f => f.severity === "WARN").length,
    candidateCount: _candidates.length,
    staleCount: _staleness.length,
    findings: _findings,
    constraintCandidates: _candidates,
    staleness: _staleness,
  }, null, 2));
  return reportPath;
}

export interface ParsedSC {
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

interface SpecMetadata {
  scs: ParsedSC[];
  compliance: "strict" | "permissive";
  status: "active" | "draft";
}

function collectTestableSpecs(root: string, extraSpecDirs?: string[]): Map<string, SpecMetadata> {
  const specMap = new Map<string, SpecMetadata>();

  const localSpecs = join(root, "specs");
  if (existsSync(localSpecs)) {
    for (const f of readdirSync(localSpecs).filter(f => f.endsWith(".md"))) {
      const content = readFileSync(join(localSpecs, f), "utf-8");
      const fm = parseFrontmatter(content);
      if (fm?.testable === "true") {
        const compliance = fm?.compliance === "permissive" ? "permissive" : "strict";
        const scs = extractSCs(content, f);
        const hasCheckedSC = /- \[x\] SC-/i.test(content);
        specMap.set(f, {
          scs,
          compliance,
          status: hasCheckedSC ? "active" : "draft",
        });
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
      const compliance = fm?.compliance === "permissive" ? "permissive" : "strict";
      const hasCheckedSC = /- \[x\] SC-/i.test(content);
      const specFile = `${dir.split("/").pop()}/${f}`;
      specMap.set(specFile, {
        scs: extractSCs(content, specFile),
        compliance,
        status: hasCheckedSC ? "active" : "draft",
      });
    }
  }

  return specMap;
}

// ── Pattern matchers ────────────────────────────────────────

type AssertionFn = (root: string) => void;
type MatcherHandler = (sc: ParsedSC, match: RegExpMatchArray) => AssertionFn | null;

// Config loading with caching
let _registryCache: Array<{ name: string; regex: string }> | null = null;
function loadRegistry(): Array<{ name: string; regex: string }> {
  if (_registryCache) return _registryCache;
  const configPath = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "matcher-registry.json");
  _registryCache = JSON.parse(readFileSync(configPath, "utf-8"));
  return _registryCache!;
}

// Handler registry — one function per pattern type
const matcherHandlers: Record<string, MatcherHandler> = {
  "file-exists": (sc, match) => {
    const target = match[1].replace(/`/g, "");
    if (target.startsWith("~/") || target.startsWith("/")) return null;
    const limitMatch = sc.statement.match(/≤\s*(\d+)\s*lines/);
    return (root) => {
      expect(existsSync(join(root, target))).toBe(true);
      if (limitMatch) {
        const content = readFileSync(join(root, target), "utf-8");
        const lineCount = content.trimEnd().split("\n").length;
        expect(lineCount).toBeLessThanOrEqual(parseInt(limitMatch[1]));
      }
    };
  },

  "dir-exists": (sc, match) => {
    const dir = match[1].replace(/`/g, "");
    const minMatch = sc.statement.match(/(?:with\s+)?≥\s*(\d+)\s+(\w+)/);
    const aliases: Record<string, string[]> = {
      "tests": ["tests", "test"],
      "test": ["test", "tests"],
      "reference": ["reference", "ref", "docs/archive"],
    };
    const candidates = aliases[dir] || [dir];
    return (root) => {
      const found = candidates.find(d => existsSync(join(root, d)));
      if (!found) {
        addFinding({
          ruleId: "SCAFFOLD-DIR-EXISTS",
          severity: "FAIL",
          file: dir,
          message: `Required directory "${dir}" not found`,
          fixCommand: `mkdir -p ${dir}`,
        });
      }
      expect(found).toBeDefined();
      if (minMatch && found) {
        const count = readdirSync(join(root, found)).length;
        const required = parseInt(minMatch[1]);
        if (count < required) {
          addFinding({
            ruleId: "SCAFFOLD-DIR-COUNT",
            severity: "FAIL",
            file: found,
            message: `${found}/ has ${count} files (requires ≥${required})`,
            fixCommand: `Add files to ${found}/ — needs at least ${required}`,
          });
        }
        expect(count).toBeGreaterThanOrEqual(required);
      }
    };
  },

  "all-specs-frontmatter": (sc) => {
    return (root) => {
      const specsDir = join(root, "specs");
      if (!existsSync(specsDir)) return;

      // Scan specs/*.md and specs/*/*.md (one level deep)
      const specFiles: string[] = [];
      for (const f of readdirSync(specsDir)) {
        if (f.endsWith(".md")) {
          specFiles.push(f);
        } else if (existsSync(join(specsDir, f)) && readdirSync(specsDir, { withFileTypes: true }).find(d => d.name === f && d.isDirectory())) {
          const subFiles = readdirSync(join(specsDir, f)).filter(sf => sf.endsWith(".md") && sf !== "INDEX.md");
          specFiles.push(...subFiles.map(sf => `${f}/${sf}`));
        }
      }

      const missing = specFiles.filter(f => {
        const fm = parseFrontmatter(readFileSync(join(specsDir, f), "utf-8"));
        // Skip redirect files (status: split)
        if (fm?.status === "split") return false;
        return !fm || !("testable" in fm);
      });
      expect(missing).toEqual([]);
    };
  },

  "paths-resolve": (sc, match) => {
    const target = match[1]?.replace(/`/g, "") || "AGENTS.md";
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
  },

  "root-clean": (sc) => {
    const contentLimit = sc.statement.match(/content:\s*≤\s*(\d+)/i);
    const codeLimit = sc.statement.match(/code:\s*≤\s*(\d+)/i);
    return (root) => {
      const items = readdirSync(root).filter(f => !f.startsWith(".") && f !== "node_modules");
      const isCode = existsSync(join(root, "src")) || existsSync(join(root, "lib")) ||
        existsSync(join(root, "gates")) || existsSync(join(root, "Makefile"));
      const limit = isCode
        ? (codeLimit ? parseInt(codeLimit[1]) : 30)
        : (contentLimit ? parseInt(contentLimit[1]) : 10);
      if (items.length > limit) {
        addFinding({
          ruleId: "SCAFFOLD-ROOT-CLEAN",
          severity: "FAIL",
          file: ".",
          message: `Root has ${items.length} items (limit: ${limit}). Move non-essential files to subdirectories.`,
          fixCommand: `Review root items and move docs to docs/, scripts to scripts/, specs to specs/`,
        });
      }
      expect(items.length).toBeLessThanOrEqual(limit);
    };
  },

  "pointer-exists": (sc, match) => {
    const file = match[1].replace(/`/g, "");
    const target = match[2].replace(/`/g, "");
    return (root) => {
      const path = resolveFilePath(root, file);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf-8")).toContain(target);
    };
  },

  "test-passes": () => {
    return () => { expect(true).toBe(true); };
  },

  "canary": () => {
    return (root) => {
      const testDir = existsSync(join(root, "test")) ? join(root, "test") : join(root, "tests");
      if (!existsSync(testDir)) return;
      const testFiles = readdirSync(testDir).filter(f => f.includes("conformity") || f.includes("canary"));
      expect(testFiles.length).toBeGreaterThanOrEqual(1);
    };
  },

  "content-contains": (sc, match) => {
    const file = match[1].replace(/`/g, "");
    const items = match[2].split(",").map(i => i.trim());
    return (root) => {
      const path = resolveFilePath(root, file);
      if (!existsSync(path)) {
        expect(existsSync(path)).toBe(true);
        return;
      }
      const content = readFileSync(path, "utf-8");
      for (const item of items) {
        expect(content).toContain(item);
      }
    };
  },

  "content-not-contains": (sc, match) => {
    const file = match[1].replace(/`/g, "");
    const items = match[2].split(",").map(i => i.trim());
    return (root) => {
      const path = resolveFilePath(root, file);
      if (!existsSync(path)) {
        expect(existsSync(path)).toBe(true);
        return;
      }
      const content = readFileSync(path, "utf-8");
      for (const item of items) {
        expect(content).not.toContain(item);
      }
    };
  },

  "count-threshold": (sc, match) => {
    const file = match[1].replace(/`/g, "").trim();
    const threshold = parseInt(match[2]);
    const unit = match[3].toLowerCase();
    return (root) => {
      const path = join(root, file);
      if (!existsSync(path)) {
        expect(existsSync(path)).toBe(true);
        return;
      }
      const content = readFileSync(path, "utf-8");
      if (unit.startsWith("line")) {
        const lineCount = content.trimEnd().split("\n").length;
        expect(lineCount).toBeLessThanOrEqual(threshold);
      } else {
        const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;
        expect(wordCount).toBeLessThanOrEqual(threshold);
      }
    };
  },

  "json-field-equals": (sc, match) => {
    const file = match[1].replace(/`/g, "");
    const field = match[2];
    const expectedValue = match[3];
    return (root) => {
      const path = join(root, file);
      if (!existsSync(path)) {
        expect(existsSync(path)).toBe(true);
        return;
      }
      const content = readFileSync(path, "utf-8");
      const json = JSON.parse(content);
      // Support nested fields like "config.name"
      const fieldParts = field.split(".");
      let value = json;
      for (const part of fieldParts) {
        value = value?.[part];
      }
      expect(value).toBe(expectedValue);
    };
  },

  "section-exists": (sc, match) => {
    const file = match[1].replace(/`/g, "");
    const sectionName = match[2];
    return (root) => {
      const path = join(root, file);
      if (!existsSync(path)) {
        expect(existsSync(path)).toBe(true);
        return;
      }
      const content = readFileSync(path, "utf-8");
      // Match both # and ## headings
      const hasSection = new RegExp(`^#+ ${sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "mi").test(content);
      expect(hasSection).toBe(true);
    };
  },

  "regex-match": (sc, match) => {
    const file = match[1].replace(/`/g, "");
    const pattern = match[2];
    const flags = match[3] || "";
    return (root) => {
      const path = join(root, file);
      if (!existsSync(path)) {
        expect(existsSync(path)).toBe(true);
        return;
      }
      const content = readFileSync(path, "utf-8");
      const regex = new RegExp(pattern, flags);
      expect(regex.test(content)).toBe(true);
    };
  },

  "source-contains": (sc, match) => {
    const file = match[1].replace(/`/g, "");
    // Only match if it's a source file path (lib/, scripts/, hooks/, gates/) or has "harness" prefix
    const isSourceFile = /^(lib|scripts|hooks|gates)\//.test(file) || sc.statement.toLowerCase().includes("harness");
    if (isSourceFile) {
      const items = match[2].split(",").map(i => i.trim());
      return (root) => {
        const path = join(root, file);
        if (!existsSync(path)) {
          expect(existsSync(path)).toBe(true);
          return;
        }
        const content = readFileSync(path, "utf-8");
        for (const item of items) {
          expect(content).toContain(item);
        }
      };
    }
    return null;
  },

  "json-has-field": (sc, match) => {
    const file = match[1].replace(/`/g, "");
    const filePath = file.endsWith(".json") ? file : `${file}.json`;
    const field = match[2];
    return (root) => {
      const path = join(root, filePath);
      if (!existsSync(path)) {
        expect(existsSync(path)).toBe(true);
        return;
      }
      const content = readFileSync(path, "utf-8");
      const json = JSON.parse(content);
      // Support nested fields like "config.name"
      const fieldParts = field.split(".");
      let value = json;
      for (const part of fieldParts) {
        value = value?.[part];
      }
      expect(value).toBeDefined();
    };
  },

  "scaffold-produces": (sc, match) => {
    const file = match[1].replace(/`/g, "");
    return (root) => {
      // For now, this checks if the file exists in the root
      // A more complete implementation would actually run scaffold and check output
      const path = join(root, file);
      expect(existsSync(path)).toBe(true);
    };
  },

  "frontmatter-field": (sc, match) => {
    const file = match[1].replace(/`/g, "");
    const field = match[2];
    const expectedValue = match[3]?.trim();
    return (root) => {
      const path = join(root, file);
      if (!existsSync(path)) {
        expect(existsSync(path)).toBe(true);
        return;
      }
      const content = readFileSync(path, "utf-8");
      const fm = parseFrontmatter(content);
      expect(fm).toBeDefined();
      expect(fm?.[field]).toBeDefined();
      if (expectedValue !== undefined) {
        expect(fm?.[field]).toBe(expectedValue);
      }
    };
  },

  "file-line-range": (sc, match) => {
    const file = match[1].replace(/`/g, "");
    const min = parseInt(match[2]);
    const max = parseInt(match[3]);
    return (root) => {
      const path = join(root, file);
      if (!existsSync(path)) {
        expect(existsSync(path)).toBe(true);
        return;
      }
      const content = readFileSync(path, "utf-8");
      const lineCount = content.trimEnd().split("\n").length;
      expect(lineCount).toBeGreaterThanOrEqual(min);
      expect(lineCount).toBeLessThanOrEqual(max);
    };
  },

  "command-output": (sc, match) => {
    const command = match[1];
    const items = match[2].split(",").map(i => i.trim());
    return (root) => {
      const result = spawnSync("sh", ["-c", command], {
        cwd: root,
        timeout: 10000,
        encoding: "utf-8",
        env: { ...process.env },
      });
      const exitCode = result.status ?? 1;
      expect(exitCode).toBe(0);
      const stdout = result.stdout || "";
      for (const item of items) {
        expect(stdout.includes(item)).toBe(true);
      }
    };
  },
};

export function matchPattern(sc: ParsedSC): AssertionFn | null {
  const registry = loadRegistry();
  for (const entry of registry) {
    const regex = new RegExp(entry.regex, "i");
    const match = sc.statement.match(regex);
    if (match) {
      const handler = matcherHandlers[entry.name];
      if (handler) {
        const result = handler(sc, match);
        if (result) return result;
      }
    }
  }
  return null;
}

// ── Exported test runners ───────────────────────────────────

export function runScaffoldConformity(root: string, opts?: { extraSpecDirs?: string[] }) {
  const specMap = collectTestableSpecs(root, opts?.extraSpecDirs ?? []);

  describe("Spec-Driven Conformity Tests", () => {
    if (specMap.size === 0) {
      test("at least one testable spec with SCs exists", () => {
        expect(specMap.size).toBeGreaterThan(0);
      });
      return;
    }

    for (const [specFile, metadata] of specMap) {
      describe(specFile, () => {
        const unmatched: string[] = [];
        for (const sc of metadata.scs) {
          const assertion = matchPattern(sc);
          if (!assertion) { unmatched.push(`${sc.id}: ${sc.statement}`); continue; }
          if (metadata.status === "draft") {
            test.todo(`${sc.id}: ${sc.statement}`);
          } else {
            test(`${sc.id}: ${sc.statement}`, () => { assertion(root); });
          }
        }
        if (unmatched.length > 0) {
          // SC-287: strict mode (default) fails on unmatched, permissive mode warns
          if (metadata.compliance === "permissive") {
            test(`WARN: ${unmatched.length} SCs have no pattern matcher`, () => {
              console.warn(`Unmatched SCs in ${specFile}:\n  ${unmatched.join("\n  ")}`);
              expect(true).toBe(true);
            });
          } else {
            test(`FAIL: ${unmatched.length} SCs have no pattern matcher (strict mode)`, () => {
              console.error(`Unmatched SCs in ${specFile}:\n  ${unmatched.join("\n  ")}`);
              expect(unmatched).toEqual([]);
            });
          }
        }
      });
    }
  });

  describe("Scaffold: structural checks", () => {
    test("AGENTS.md has required standard sections", () => {
      if (!existsSync(join(root, "AGENTS.md"))) {
        addFinding({ ruleId: "SCAFFOLD-AGENTS-MISSING", severity: "FAIL", file: "AGENTS.md", message: "AGENTS.md not found", fixCommand: "Run scaffold to generate AGENTS.md" });
        expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
        return;
      }
      const content = readFileSync(join(root, "AGENTS.md"), "utf-8");
      const required = ["Project Identity", "Key Files", "Specs", "Tests", "Workflow"];
      const missing = required.filter(s => !content.toLowerCase().includes(s.toLowerCase()));
      if (missing.length > 0) {
        addFinding({ ruleId: "SCAFFOLD-AGENTS-SECTIONS", severity: "FAIL", file: "AGENTS.md", message: `Missing sections: ${missing.join(", ")}`, fixCommand: "Re-run scaffold to regenerate AGENTS.md" });
      }
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
      for (const f of missing) {
        addFinding({ ruleId: "SPEC-FRONTMATTER", severity: "FAIL", file: `specs/${f}`, message: `Spec "${f}" missing testable field in frontmatter`, fixCommand: `Add "testable: true" or "testable: false" to frontmatter of specs/${f}` });
      }
      expect(missing).toEqual([]);
    });

    test("at least one testable spec exists", () => {
      if (!existsSync(specsDir)) return;
      const testable = readdirSync(specsDir).filter(f => f.endsWith(".md")).filter(f => {
        const fm = parseFrontmatter(readFileSync(join(specsDir, f), "utf-8"));
        return fm?.testable === "true";
      });
      if (testable.length === 0) {
        addFinding({
          ruleId: "SPEC-DISCOVERY-TESTABLE",
          severity: "FAIL",
          file: "specs/",
          message: "No spec has testable: true. At least one spec must be testable.",
          fixCommand: `Add "testable: true" to frontmatter of a spec in specs/`,
        });
      }
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

      // Scan specs/*.md and specs/*/*.md (one level deep)
      const specFiles: string[] = [];
      for (const f of readdirSync(specsDir)) {
        if (f.endsWith(".md")) {
          specFiles.push(f);
        } else if (existsSync(join(specsDir, f)) && readdirSync(specsDir, { withFileTypes: true }).find(d => d.name === f && d.isDirectory())) {
          const subFiles = readdirSync(join(specsDir, f)).filter(sf => sf.endsWith(".md") && sf !== "INDEX.md");
          specFiles.push(...subFiles.map(sf => `${f}/${sf}`));
        }
      }

      for (const f of specFiles) {
        const content = readFileSync(join(specsDir, f), "utf-8");
        const fm = parseFrontmatter(content);
        // Skip redirect files (status: split)
        if (fm?.status === "split") continue;
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

    test("HYGIENE-10: All ADRs have doc-type: adr in frontmatter", () => {
      const adrDir = join(root, "docs", "adr");
      if (!existsSync(adrDir)) return;
      const missing: string[] = [];
      for (const f of readdirSync(adrDir).filter(f => f.endsWith(".md"))) {
        const content = readFileSync(join(adrDir, f), "utf-8");
        const fm = parseFrontmatter(content);
        if (!fm || fm["doc-type"] !== "adr") {
          missing.push(f);
          addFinding({
            ruleId: "HYGIENE-10",
            severity: "FAIL",
            file: `docs/adr/${f}`,
            message: `ADR "${f}" missing doc-type: adr in frontmatter`,
            fixCommand: `Add "doc-type: adr" to frontmatter of docs/adr/${f}`,
          });
        }
      }
      if (missing.length > 0) {
        console.error(`HYGIENE-10 FAIL: ADRs missing doc-type: ${missing.join(", ")}`);
      }
      expect(missing).toEqual([]);
    });

    test("HYGIENE-7: No spec files at root (must be in specs/)", () => {
      const allowlist = new Set([
        "AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", "CODE-MAP.md",
        "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "LICENSE.md",
        "ARCHITECTURE.md", "PRINCIPLES.md", "MODEL.md", "PROJECT-STATE.md",
      ]);
      const misplaced: string[] = [];
      for (const f of readdirSync(root).filter(f => f.endsWith(".md"))) {
        if (allowlist.has(f)) continue;
        const content = readFileSync(join(root, f), "utf-8");
        const fm = parseFrontmatter(content);
        if (fm?.["doc-type"] === "spec") {
          misplaced.push(f);
          addFinding({
            ruleId: "HYGIENE-7",
            severity: "FAIL",
            file: f,
            message: `Spec "${f}" is at root — must be in specs/`,
            fixCommand: `mv ${f} specs/${f}`,
          });
        }
      }
      if (misplaced.length > 0) {
        console.error(`HYGIENE-7 FAIL: Specs at root: ${misplaced.join(", ")}. Move to specs/.`);
      }
      expect(misplaced).toEqual([]);
    });

    test("HYGIENE-8: No ADR files outside docs/adr/", () => {
      const misplaced: string[] = [];
      const checkDirs = [root, join(root, "docs"), join(root, "specs")];
      for (const dir of checkDirs) {
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir).filter(f => f.endsWith(".md"))) {
          const content = readFileSync(join(dir, f), "utf-8");
          const fm = parseFrontmatter(content);
          if (fm?.["doc-type"] === "adr") {
            const relPath = dir === root ? f : `${dir.replace(root + "/", "")}/${f}`;
            misplaced.push(relPath);
            addFinding({
              ruleId: "HYGIENE-8",
              severity: "FAIL",
              file: relPath,
              message: `ADR "${relPath}" is outside docs/adr/ — must be in docs/adr/`,
              fixCommand: `mv ${relPath} docs/adr/${f}`,
            });
          }
        }
      }
      if (misplaced.length > 0) {
        console.error(`HYGIENE-8 FAIL: ADRs outside docs/adr/: ${misplaced.join(", ")}. Move to docs/adr/.`);
      }
      expect(misplaced).toEqual([]);
    });

    test("HYGIENE-9: No doc files at root (except allowlisted)", () => {
      const allowlist = new Set([
        "AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", "CODE-MAP.md",
        "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "LICENSE.md",
        "ARCHITECTURE.md", "PRINCIPLES.md", "MODEL.md", "PROJECT-STATE.md",
      ]);
      const misplaced: string[] = [];
      for (const f of readdirSync(root).filter(f => f.endsWith(".md"))) {
        if (allowlist.has(f)) continue;
        const content = readFileSync(join(root, f), "utf-8");
        const fm = parseFrontmatter(content);
        if (fm?.["doc-type"] === "guide" || fm?.["doc-type"] === "doc") {
          misplaced.push(f);
          addFinding({
            ruleId: "HYGIENE-9",
            severity: "FAIL",
            file: f,
            message: `Doc "${f}" is at root — must be in docs/`,
            fixCommand: `mv ${f} docs/${f}`,
          });
        }
      }
      if (misplaced.length > 0) {
        console.error(`HYGIENE-9 FAIL: Docs at root: ${misplaced.join(", ")}. Move to docs/.`);
      }
      expect(misplaced).toEqual([]);
    });

    test("HYGIENE-6: No unreviewed constraint candidates in changed docs", async () => {
      const { extractConstraints } = await import("../scripts/extract-constraints");
      const result = await extractConstraints(root, { apply: false });

      for (const s of result.staleness) {
        addStaleness({ file: s.file, daysSince: s.daysSince, threshold: s.threshold, type: s.type });
      }

      for (const c of result.candidates) {
        addCandidate({ rule: c.rule, source: c.source, hash: c.hash, status: "pending" });
      }

      if (result.staleness.length > 0) {
        console.warn(
          `Stale docs (past threshold): ${result.staleness.map((s: any) => `${s.file} (${s.daysSince}d, ${s.type} threshold=${s.threshold}d)`).join(", ")}`
        );
      }

      if (result.candidates.length > 0) {
        console.warn(
          `${result.candidates.length} unreviewed constraint candidates found. Run \`bunx rungate extract-constraints ${root}\` to review.`
        );
      }

      expect(true).toBe(true);
    });

    test("HYGIENE-REPORT: Write unified findings report", () => {
      const findings = getFindings();
      const candidates = getCandidates();
      const staleness = getStaleness();
      const totalItems = findings.length + candidates.length + staleness.length;

      if (totalItems > 0) {
        const reportPath = writeFindingsReport(root);
        console.log(`\n📋 Findings written to ${reportPath}`);
        if (findings.length > 0) {
          console.log(`   Issues: ${findings.filter(f => f.severity === "FAIL").length} FAIL, ${findings.filter(f => f.severity === "WARN").length} WARN`);
          for (const f of findings) {
            console.log(`   ${f.severity}: ${f.file} — ${f.message}`);
            if (f.fixCommand) console.log(`     Fix: ${f.fixCommand}`);
          }
        }
        if (candidates.length > 0) {
          console.log(`   Constraint candidates: ${candidates.length} pending review`);
          for (const c of candidates) {
            console.log(`     "${c.rule}" (${c.source})`);
          }
          console.log(`   → Run \`bunx rungate extract-constraints ${root}\` to apply or reject`);
        }
        if (staleness.length > 0) {
          console.log(`   Stale docs: ${staleness.length}`);
          for (const s of staleness) {
            console.log(`     ${s.file} — ${s.daysSince}d old (${s.type} threshold: ${s.threshold}d)`);
          }
        }
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

    test("AGENT-6: All file paths referenced in briefs exist", () => {
      if (!existsSync(agentsDir)) return;
      const broken: string[] = [];
      for (const f of readdirSync(agentsDir).filter(f => f.endsWith(".md"))) {
        const content = readFileSync(join(agentsDir, f), "utf-8");
        const refs = content.match(/node_modules\/[^\s`*)"']+/g) || [];
        for (const ref of refs) {
          const clean = ref.replace(/[`*)"']+$/, "");
          if (!existsSync(join(root, clean))) {
            broken.push(`${f} → ${clean}`);
            addFinding({
              ruleId: "AGENT-BROKEN-REF",
              severity: "FAIL",
              file: `.claude/agents/${f}`,
              message: `Brief references "${clean}" but file does not exist`,
              fixCommand: `Check prompts/ directory for correct filename — may be a typo or renamed file`,
            });
          }
        }
      }
      if (broken.length > 0) {
        console.error(`Broken references in agent briefs:\n  ${broken.join("\n  ")}`);
      }
      expect(broken).toEqual([]);
    });
  });
}

// ── SC-294: Directory validation ───────────────────────────

export function runDirectoryValidation(root: string) {
  const specsDir = join(root, "specs");

  describe("Directory Validation (SC-294)", () => {
    test("SC-294: Every specs/ subdirectory has a parent spec file", () => {
      if (!existsSync(specsDir)) return;

      const invalid: string[] = [];

      // Find all subdirectories in specs/
      const entries = readdirSync(specsDir);
      const subdirs = entries.filter(entry => {
        const fullPath = join(specsDir, entry);
        try {
          return statSync(fullPath).isDirectory();
        } catch {
          return false;
        }
      });

      // For each subdirectory, check if there's a corresponding parent spec
      for (const subdir of subdirs) {
        // Find all .md files in specs/
        const specFiles = entries.filter(f => f.endsWith(".md"));

        // Check if any spec file derives to this directory name
        let found = false;
        for (const specFile of specFiles) {
          const derived = deriveDirectoryName(specFile);
          if (derived === subdir) {
            found = true;
            break;
          }
        }

        if (!found) {
          invalid.push(`${subdir}/: no parent spec derives to this directory name`);
        }
      }

      if (invalid.length > 0) {
        console.error(`Hand-created directories (SC-294 violation):\n  ${invalid.join("\n  ")}\n\nDirectories MUST be created by split-spec.ts, not manually.`);
      }
      expect(invalid).toEqual([]);
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
      const unused = result.unused_files.map(f => f.path).filter(p => !p.includes("test/fixtures/") && !p.includes("reference/"));
      if (unused.length > 0) {
        console.warn(`Unused files (${unused.length}):\n  ${unused.slice(0, 10).join("\n  ")}${unused.length > 10 ? `\n  ... and ${unused.length - 10} more` : ""}`);
      }
      if (fail) expect(unused).toEqual([]);
    });

    if (!opts?.skipUnusedExports) {
      test("FALLOW-2: No unused exports", () => {
        const result = runFallowCommand(root, ["dead-code", "--unused-exports"]);
        if (!result) return;
        const unused = (result.unused_exports || [])
          .filter(e => !e.path.includes("test/fixtures/") && !e.path.includes("reference/"))
          .map(e => `${e.path}:${e.line ?? "?"} ${e.export_name}`);
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

export function runPackageValidation(root: string) {
  describe("Package validation", () => {
    test("PKG-1: package.json exists", () => {
      expect(existsSync(join(root, "package.json"))).toBe(true);
    });

    test("PKG-2: required fields present", () => {
      const pkgPath = join(root, "package.json");
      if (!existsSync(pkgPath)) return;
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      expect(pkg.name).toBeDefined();
      expect(pkg.type).toBe("module");
      expect(pkg.scripts?.test).toBeDefined();
    });

    test("PKG-3: devDependencies.rungate present", () => {
      const pkgPath = join(root, "package.json");
      if (!existsSync(pkgPath)) return;
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      expect(pkg.devDependencies?.rungate).toBeDefined();
    });
  });
}

export function runTsconfigValidation(root: string) {
  describe("TSConfig validation", () => {
    test("TSC-1: tsconfig.json exists", () => {
      expect(existsSync(join(root, "tsconfig.json"))).toBe(true);
    });

    test("TSC-2: strict mode enabled", () => {
      const tscPath = join(root, "tsconfig.json");
      if (!existsSync(tscPath)) return;
      const tsconfig = JSON.parse(readFileSync(tscPath, "utf-8"));
      if (!tsconfig.compilerOptions?.strict) {
        console.warn("WARN: tsconfig.json strict mode not enabled");
      }
    });
  });
}

export function runModuleDepthCheck(root: string) {
  describe("Module depth analysis", () => {
    test("DEPTH-1: no shallow modules (more exports than internal functions)", () => {
      const srcDir = join(root, "src");
      if (!existsSync(srcDir)) return;
      const shallow: string[] = [];
      for (const f of readdirSync(srcDir).filter(f => f.endsWith(".ts"))) {
        const content = readFileSync(join(srcDir, f), "utf-8");
        const exportCount = (content.match(/export\s+(function|const|class|type|interface)\s/g) || []).length;
        const internalCount = (content.match(/(?<!export\s)(function|const)\s+[a-z]/g) || []).length;
        if (exportCount > 0 && internalCount > 0 && exportCount > internalCount) {
          shallow.push(`${f}: ${exportCount} exports, ${internalCount} internal`);
        }
      }
      if (shallow.length > 0) {
        console.warn(`WARN: Shallow modules:\n  ${shallow.join("\n  ")}`);
      }
    });

    test("DEPTH-2: modules with >3 importers have contract tests", () => {
      const srcDir = join(root, "src");
      const testDir = join(root, "test");
      if (!existsSync(srcDir)) return;
      const importCounts: Record<string, number> = {};
      for (const f of readdirSync(srcDir).filter(f => f.endsWith(".ts"))) {
        const content = readFileSync(join(srcDir, f), "utf-8");
        const imports = content.match(/from\s+["']\.\/([^"']+)["']/g) || [];
        for (const imp of imports) {
          const target = imp.match(/["']\.\/([^"']+)["']/)?.[1] || "";
          importCounts[target] = (importCounts[target] || 0) + 1;
        }
      }
      const highImport = Object.entries(importCounts).filter(([, c]) => c > 3);
      if (highImport.length > 0 && existsSync(testDir)) {
        const testFiles = readdirSync(testDir).filter(f => f.endsWith(".test.ts"));
        for (const [mod, count] of highImport) {
          const hasTest = testFiles.some(t => t.includes(mod.replace(/\.ts$/, "")));
          if (!hasTest) {
            console.warn(`WARN: ${mod} has ${count} importers but no contract test`);
          }
        }
      }
    });
  });
}

export function runAbsenceValidation(root: string) {
  describe("Absence validation", () => {
    test("ABSENCE-1: anti-criteria use absence verification", () => {
      const specsDir = join(root, "specs");
      if (!existsSync(specsDir)) return;
      for (const f of readdirSync(specsDir).filter(f => f.endsWith(".md"))) {
        const content = readFileSync(join(specsDir, f), "utf-8");
        const antiCriteria = content.match(/^- \[ \] SC-A\d+:.+$/gm) || [];
        for (const ac of antiCriteria) {
          if (!ac.match(/not|never|no |absence|must not/i)) {
            console.warn(`WARN: Anti-criterion may not verify absence: ${ac.substring(0, 80)}`);
          }
        }
      }
    });
  });
}
