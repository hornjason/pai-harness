/**
 * create-sc — Generate matchable SC lines from structured input.
 *
 * Deep module: all pattern-to-text logic lives here.
 * Thin consumer: scripts/create-sc.ts is the CLI wrapper.
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ── Types ─────────────────────────────────────────────────────

export interface RegistryEntry {
  name: string;
  syntax: string;
  regex: string;
  example: string;
  notes: string;
}

interface ParamDef {
  required: string[];
  generate: (params: Record<string, string>) => string;
}

// ── Registry loading ──────────────────────────────────────────

let _registryCache: RegistryEntry[] | null = null;

function loadRegistry(): RegistryEntry[] {
  if (_registryCache) return _registryCache;
  const configPath = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "matcher-registry.json");
  _registryCache = JSON.parse(readFileSync(configPath, "utf-8"));
  return _registryCache!;
}

// ── Pattern param definitions ─────────────────────────────────

const patternDefs: Record<string, ParamDef> = {
  "file-exists": {
    required: ["file"],
    generate: (p) => `${p.file} exists`,
  },
  "dir-exists": {
    required: ["dir"],
    generate: (p) => `${p.dir}/ directory exists`,
  },
  "all-specs-frontmatter": {
    required: [],
    generate: () => "all specs have frontmatter",
  },
  "paths-resolve": {
    required: ["file"],
    generate: (p) => `all paths referenced in ${p.file} resolve`,
  },
  "root-clean": {
    required: [],
    generate: () => "root is clean",
  },
  "pointer-exists": {
    required: ["file", "target"],
    generate: (p) => `${p.file} exists with pointer to ${p.target}`,
  },
  "test-passes": {
    required: [],
    generate: () => "bun test passes",
  },
  "canary": {
    required: [],
    generate: () => "canary test exists",
  },
  "content-contains": {
    required: ["file", "items"],
    generate: (p) => `${p.file} contains [${p.items}]`,
  },
  "content-not-contains": {
    required: ["file", "items"],
    generate: (p) => `${p.file} must NOT contain [${p.items}]`,
  },
  "count-threshold": {
    required: ["file", "count", "unit"],
    generate: (p) => `${p.file} is under [${p.count}] ${p.unit}`,
  },
  "json-field-equals": {
    required: ["file", "field", "value"],
    generate: (p) => `${p.file} ${p.field} field equals [${p.value}]`,
  },
  "section-exists": {
    required: ["file", "section"],
    generate: (p) => `${p.file} has section [${p.section}]`,
  },
  "regex-match": {
    required: ["file", "pattern"],
    generate: (p) => `${p.file} matches /${p.pattern}/${p.flags ?? ""}`,
  },
  "source-contains": {
    required: ["file", "keywords"],
    generate: (p) => `harness ${p.file} contains [${p.keywords}]`,
  },
  "json-has-field": {
    required: ["file", "field"],
    generate: (p) => `${p.file} has field ${p.field}`,
  },
  "scaffold-produces": {
    required: ["file"],
    generate: (p) => `scaffold output ${p.file} exists`,
  },
  "frontmatter-field": {
    required: ["file", "field"],
    generate: (p) => p.value
      ? `${p.file} frontmatter has ${p.field} = ${p.value}`
      : `${p.file} frontmatter has ${p.field}`,
  },
  "file-line-range": {
    required: ["file", "min", "max"],
    generate: (p) => `${p.file} is between [${p.min}] and [${p.max}] lines`,
  },
  "command-output": {
    required: ["command", "expected"],
    generate: (p) => `command-output \`${p.command}\` contains [${p.expected}]`,
  },
};

// ── Core functions ────────────────────────────────────────────

function validatePattern(name: string): RegistryEntry {
  const registry = loadRegistry();
  const entry = registry.find(e => e.name === name);
  if (!entry) {
    const validNames = registry.map(e => e.name).join(", ");
    throw new Error(`Unknown pattern: "${name}". Valid patterns: ${validNames}`);
  }
  return entry;
}

function validateParams(patternName: string, params: Record<string, string>): void {
  const def = patternDefs[patternName];
  if (!def) {
    throw new Error(`No parameter definition for pattern: "${patternName}"`);
  }
  const missing = def.required.filter(k => !params[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required params for "${patternName}": ${missing.join(", ")}. ` +
      `Required: ${def.required.join(", ")}`
    );
  }
}

export function generateSCText(patternName: string, params: Record<string, string>): string {
  // Validate pattern exists in registry
  const entry = validatePattern(patternName);

  // Validate required params
  validateParams(patternName, params);

  // Generate the statement text
  const def = patternDefs[patternName];
  const statement = def.generate(params);

  // Validate round-trip: generated text must match the pattern's regex
  const regex = new RegExp(entry.regex, "i");
  if (!regex.test(statement)) {
    throw new Error(
      `Internal error: generated text "${statement}" does not match pattern regex /${entry.regex}/i`
    );
  }

  return statement;
}

export function listPatterns(): string {
  const registry = loadRegistry();
  const lines: string[] = ["Available patterns:", ""];
  for (const entry of registry) {
    const def = patternDefs[entry.name];
    const required = def ? def.required : [];
    lines.push(`  ${entry.name}`);
    lines.push(`    Syntax:   ${entry.syntax}`);
    lines.push(`    Example:  ${entry.example}`);
    lines.push(`    Required: ${required.length > 0 ? required.join(", ") : "(none)"}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Find the next SC number in a spec file by scanning existing SC-NNN IDs.
 */
export function nextSCNumber(specContent: string): number {
  const ids: number[] = [];
  const pattern = /SC-(\d+)/g;
  let match;
  while ((match = pattern.exec(specContent)) !== null) {
    ids.push(parseInt(match[1]));
  }
  if (ids.length === 0) return 1;
  return Math.max(...ids) + 1;
}

/**
 * Format an SC line for appending to a spec file.
 */
export function formatSCLine(scNumber: number, statement: string): string {
  return `- [ ] SC-${scNumber}: ${statement}`;
}
