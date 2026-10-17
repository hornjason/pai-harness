/**
 * create-sc — Generate matchable SC lines from structured input.
 *
 * Deep module: all pattern-to-text logic lives here.
 * Thin consumer: scripts/create-sc.ts is the CLI wrapper.
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import type { ScRegistry } from "./sc-ids";
import { isFixtureScId, scIdsSpelledInSource } from "./sc-ids";
import type { ScNamespaceReading } from "./sc-id-cross-tree";
import { readScNamespace } from "./sc-id-cross-tree";
import { tryLoadRungateConfig } from "./config-loader";

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

const _registryCache = new Map<string, RegistryEntry[]>();

function loadBuiltInRegistry(): RegistryEntry[] {
  const key = "__builtin__";
  if (_registryCache.has(key)) return _registryCache.get(key)!;
  const configPath = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "matcher-registry.json");
  const entries: RegistryEntry[] = JSON.parse(readFileSync(configPath, "utf-8"));
  _registryCache.set(key, entries);
  return entries;
}

/**
 * Load the matcher registry, optionally merging consumer-defined custom matchers.
 *
 * When projectRoot is provided, resolves that project's config through
 * `lib/config-loader.ts` and merges any `customMatchers` array entries with the
 * built-in registry. Consumer entries with the same `name` as a built-in entry
 * override the built-in.
 */
export function loadRegistry(projectRoot?: string): RegistryEntry[] {
  const cacheKey = projectRoot ?? "__builtin__";
  if (_registryCache.has(cacheKey)) return _registryCache.get(cacheKey)!;

  const builtIn = loadBuiltInRegistry();
  if (!projectRoot) {
    return builtIn;
  }

  // Through the loader, so a consumer on the directory layout can supply
  // custom matchers at all — this read was monolith-only, which is #212/#90.
  // The parse failure is NOT caught: the old `catch` returned the built-in
  // registry, so a consumer whose config had a trailing comma silently got
  // rungate's matchers and no indication their own had been dropped.
  const config = tryLoadRungateConfig(projectRoot);
  const customMatchers = (config?.customMatchers ?? []) as RegistryEntry[];
  if (customMatchers.length === 0) {
    _registryCache.set(cacheKey, builtIn);
    return builtIn;
  }

  // Merge: consumer entries override built-in entries with same name
  const merged = builtIn.filter(
    (entry) => !customMatchers.some((c) => c.name === entry.name)
  );
  merged.push(...customMatchers);

  _registryCache.set(cacheKey, merged);
  return merged;
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
 * The next free SC number.
 *
 * `SC-<n>` is a GLOBAL id — `lib/sc-ids.ts` says so, and
 * `test/spec-sc-ids-unique.test.ts` enforces it. This function read ONE
 * spec's content, which in a global namespace is not an allocator but a
 * collision generator, and it generated ten (#392): GATE-CONTRACTS-SPEC.md
 * counted up to 378 in its own file and took 379..388 for its per-gate
 * subsections, while CONFIG-DRIVEN-TESTING-SPEC.md independently counted up
 * to 378 in ITS own file and took 379 next. Both were locally correct and
 * neither could see the other.
 *
 * Pass the registry and the whole namespace is consulted, headings included —
 * a number owned by a `### SC-N:` section is just as taken as a tracked one.
 *
 * `reg` is optional so the one-argument answer is unchanged for any caller
 * that has no registry to hand; silently changing that would be a different
 * bug. It is the wrong answer in a shared namespace, which is why
 * `scripts/create-sc.ts` passes one.
 *
 * ## The namespace has a second half, and #392 only fixed the first
 *
 * Consulting the registry stopped two specs minting the same number. It did
 * nothing about test fixtures, which spell SC ids inside the SAME namespace
 * and appear in no registry: `test/sync-sc-status.test.ts:61` is literally
 * `- [ ] SC-9441: AGENTS.md exists`, a checkbox declaration in a string
 * literal. Allocating 900 would mint a criterion out of a scratch number and
 * hand a live claim to a fixture — the shape #392 closed, arriving from the
 * side nothing looks at.
 *
 * So `spelledInSource` is the other half — and only there is the reserved
 * range ignored. The 9000s exist to be safe for fixtures, so counting a
 * FIXTURE at 9450 as taken would push every future criterion past 9000 and
 * destroy the reservation it was built on. That is the one case where a
 * higher number is the wrong answer.
 *
 * A SPEC declaration is authoritative at any number, reserved or not. If a
 * spec has already claimed 9150 then 9150 is claimed, whatever the
 * convention says it should have been, and allocating it again is the
 * collision this function exists to prevent. The reservation is enforced
 * against specs by SC-1524, not by making the allocator pretend.
 */
export function nextSCNumber(
  specContent: string,
  reg?: ScRegistry,
  spelledInSource?: Iterable<string>,
): number {
  const ids: number[] = [];
  const take = (raw: string): void => {
    const n = Number(raw.replace(/^SC-[A-Z]?/, ""));
    if (Number.isFinite(n)) ids.push(n);
  };
  const pattern = /SC-(\d+)/g;
  let match;
  while ((match = pattern.exec(specContent)) !== null) take(match[0]);
  for (const id of reg?.declaredById.keys() ?? []) take(id);
  for (const id of spelledInSource ?? []) if (!isFixtureScId(id)) take(id);
  if (ids.length === 0) return 1;
  return Math.max(...ids) + 1;
}

/**
 * The next free SC number for a project, over every namespace this machine
 * can see (#503).
 *
 * `nextSCNumber` answers the question for the arguments it is handed, and
 * three widths of that question have each been wrong in turn: one spec's
 * content (#392), the spec registry without test fixtures (#399), and the
 * registry of whichever working tree the command ran in (#503). This is the
 * composition, in one place, so a caller cannot assemble two of the three and
 * believe it asked.
 *
 * It returns the reading alongside the number because the number is a FLOOR:
 * a clone on another machine is outside anything this process can reach, and
 * a caller that printed only the number would be claiming a guarantee the
 * reading explicitly does not give.
 */
export function allocateScNumber(
  root: string,
  specContent: string,
  reg?: ScRegistry,
): { number: number; namespace: ScNamespaceReading } {
  const namespace = readScNamespace(root);
  const number = nextSCNumber(specContent, reg, [
    ...scIdsSpelledInSource(root).keys(),
    ...namespace.ids.keys(),
  ]);
  return { number, namespace };
}

/**
 * Format an SC line for appending to a spec file.
 */
export function formatSCLine(scNumber: number, statement: string): string {
  return `- [ ] SC-${scNumber}: ${statement}`;
}
