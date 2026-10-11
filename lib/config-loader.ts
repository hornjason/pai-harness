/**
 * config-loader.ts — Central config loader for rungate
 *
 * Reads config from .claude/rungate/ directory (preferred) or
 * .claude/rungate.json (fallback). Merges directory files into
 * the same shape as the monolith for backward compatibility.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { ProjectHarnessSchema } from "./rungate-schema";

export interface ComplianceRule {
  description: string;
  directives: string[];
  reinforcement: string;
  tiers: Record<string, { action: string; hook?: string }>;
  threshold: { consecutive: number; promote: number };
}

export interface OrganizeExternalSource {
  path: string;
  type: string;
  target: string | null;
  method: "symlink" | "copy" | "discover";
  matchBy: string;
}

export interface ComplianceConfig {
  rules: Record<string, ComplianceRule>;
  defaults: { consecutiveFailThreshold: number; tierPromotionThreshold: number };
  organize: {
    fileTypes: string[];
    artifactClassification: Record<string, string>;
    externalSources: OrganizeExternalSource[];
  };
}

/**
 * The resolved shape, derived from the Zod schema rather than hand-declared.
 *
 * The interface this replaces declared `test.command` as REQUIRED while
 * `TestSchema` did not declare it at all — two hand-written types for one
 * file, disagreeing, and the disagreement was load-bearing: `captureTestBaseline`
 * trusted the required-ness, zod stripped the key, and DDB (which authors
 * `dev.testCmd` and no `test` block at all) silently measured zero. ADR-002 D3.
 *
 * The resolved-only keys below are what normalisation ADDS to the authored
 * shape. `apiUrl`/`uiUrl` are the flattening `ship.js:1698-1699` did in memory,
 * moved into the loader so the workflow and the agent prompts finally read one
 * value. `roles` and `hooks` are non-optional here because the loader always
 * supplies them — the directory form merges them from fragments and the
 * monolith form defaults them — so a caller never has to ask whether an empty
 * registry means "none" or "not loaded".
 */
export const ResolvedConfigSchema = ProjectHarnessSchema.extend({
  apiUrl: z.string().optional(),
  uiUrl: z.string().optional(),
  roles: z.record(z.unknown()).default({}),
  hooks: z.array(z.unknown()).default([]),
  compliance: z.custom<ComplianceConfig>().optional(),
});

export type ResolvedConfig = z.infer<typeof ResolvedConfigSchema>;

/**
 * Used when a config declares no `test.timeout`. Matches the literal
 * `ship.js:1705` has defaulted to since before this loader existed; changing
 * it is a separate decision from unifying the readers.
 */
export const DEFAULT_TEST_TIMEOUT_MS = 120000;

/**
 * The discriminated resolution — ADR-002 D2(a).
 *
 * Malformed JSON and orphaned fragments THROW, per ADR-001 D2. Unchanged.
 *
 * Why this earns its place over the nullable that already existed: `null`,
 * `0`, `{}`, `""` and `undefined` are all falsy, so `||` and `?.` absorb every
 * one of them. `{ status: "absent" }` is truthy and has no `.test` property,
 * so `resolution.test?.command || fallback` neither compiles nor silently
 * works. Defaulting stops being something you reach by typing `||` and becomes
 * something a reviewer can see.
 */
export type ConfigResolution =
  | { status: "resolved"; config: ResolvedConfig; source: "directory" | "monolith" }
  | { status: "absent" };

const DIRECTORY_CONFIG_FILES = ["config.json", "roles.json", "hooks.json", "compliance.json"];

export function loadRungateConfig(projectRoot: string): ResolvedConfig {
  const dirPath = join(projectRoot, ".claude", "rungate");
  const monolithPath = join(projectRoot, ".claude", "rungate.json");

  const resolution = resolveConfig(projectRoot);
  if (resolution.status === "resolved") return resolution.config;

  throw new Error(`No rungate config found at ${dirPath} or ${monolithPath}`);
}

/**
 * Non-throwing variant of loadRungateConfig.
 *
 * Returns null ONLY when no config is present. A config that exists but
 * cannot be parsed still throws — per ADR-001 D2, a malformed config is
 * never a missing config. Conflating the two is what let #70 stay silent:
 * the caller could not tell "not configured" from "configured wrong".
 */
export function tryLoadRungateConfig(projectRoot: string): ResolvedConfig | null {
  const resolution = resolveConfig(projectRoot);
  return resolution.status === "resolved" ? resolution.config : null;
}

/**
 * Directory form wins over the monolith; reports `absent` when neither is
 * present. Both wrappers above are thin shims over this — ADR-001 D2's
 * two-function contract and its caller-assignment table are not re-opened.
 */
export function resolveConfig(projectRoot: string): ConfigResolution {
  const dirPath = join(projectRoot, ".claude", "rungate");
  const monolithPath = join(projectRoot, ".claude", "rungate.json");

  // config.json is the sole marker for the directory form. Treating any
  // fragment as the marker let a stray roles.json shadow a complete monolith
  // and silently drop issueRepo/ci/test — ADR-001 Step E keeps the monolith
  // in place during migration, so that state is on the normal upgrade path.
  if (existsSync(join(dirPath, "config.json"))) {
    return { status: "resolved", source: "directory", config: loadFromDirectory(dirPath) };
  }

  if (existsSync(monolithPath)) {
    return { status: "resolved", source: "monolith", config: loadFromMonolith(monolithPath) };
  }

  // Fragments with no config.json and no monolith is a broken directory
  // config, not an unconfigured project. Fail loudly rather than reporting
  // absent, which the caller would read as "no rungate here".
  const orphans = DIRECTORY_CONFIG_FILES.filter((file) => existsSync(join(dirPath, file)));
  if (orphans.length > 0) {
    throw new Error(
      `Incomplete rungate config at ${dirPath}: found ${orphans.join(", ")} but no config.json`
    );
  }

  return { status: "absent" };
}

/**
 * The single normalisation rule — ADR-002 D3. `dev.*` is the authored shape
 * and wins; `test.command` keeps being read and is deprecated by nothing here.
 *
 * Every key not named below passes through untouched. A config carrying
 * `remoteHosts` keeps it; normalisation is not a filter.
 */
function normalise(raw: Record<string, any>): ResolvedConfig {
  const command = raw.dev?.testCmd ?? raw.test?.command;
  const timeout = raw.test?.timeout ?? DEFAULT_TEST_TIMEOUT_MS;

  return {
    ...raw,
    apiUrl: raw.apiUrl ?? raw.dev?.apiBase,
    uiUrl: raw.uiUrl ?? raw.dev?.uiBase,
    // `command` stays undefined when neither shape declares one. That is the
    // honest unresolved state, and a caller that reports a measurement must
    // propagate it as unmeasured rather than substitute a plausible default
    // (ADR-002 D2(b); #227 and #224 are the worked precedents).
    test: { ...(raw.test ?? {}), command, timeout },
    roles: raw.roles ?? {},
    hooks: raw.hooks ?? [],
    schemaVersion: raw.schemaVersion ?? 1,
  } as ResolvedConfig;
}

function loadFromDirectory(dirPath: string): ResolvedConfig {
  const config = readJson(join(dirPath, "config.json"));
  const roles = existsSync(join(dirPath, "roles.json"))
    ? readJson(join(dirPath, "roles.json"))
    : {};
  const hooks = existsSync(join(dirPath, "hooks.json"))
    ? readJson(join(dirPath, "hooks.json"))
    : [];
  const compliance = existsSync(join(dirPath, "compliance.json"))
    ? readJson(join(dirPath, "compliance.json"))
    : undefined;

  return normalise({ ...config, roles, hooks, compliance });
}

function loadFromMonolith(path: string): ResolvedConfig {
  return normalise(readJson(path));
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function loadComplianceConfig(projectRoot: string): ComplianceConfig | null {
  const dirPath = join(projectRoot, ".claude", "rungate", "compliance.json");
  if (existsSync(dirPath)) {
    return readJson(dirPath);
  }
  return null;
}

export function buildDirToCompMap(compliance: ComplianceConfig): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [compId, rule] of Object.entries(compliance.rules)) {
    for (const dir of rule.directives) {
      map[dir] = compId;
    }
  }
  return map;
}

export function buildReinforcementMap(compliance: ComplianceConfig): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [compId, rule] of Object.entries(compliance.rules)) {
    map[compId] = rule.reinforcement;
  }
  return map;
}

export function buildTierPromotionMap(
  compliance: ComplianceConfig
): Record<string, { tier: 2 | 3; promotion: string }> {
  const map: Record<string, { tier: 2 | 3; promotion: string }> = {};
  for (const [compId, rule] of Object.entries(compliance.rules)) {
    const maxTier = Math.max(...Object.keys(rule.tiers).map(Number));
    if (maxTier >= 2) {
      const tierAction = rule.tiers[String(maxTier)];
      map[compId] = {
        tier: maxTier as 2 | 3,
        promotion: tierAction.hook
          ? `Deploy ${tierAction.hook} hook (${tierAction.action})`
          : tierAction.action,
      };
    }
  }
  return map;
}
