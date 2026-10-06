/**
 * config-loader.ts — Central config loader for rungate
 *
 * Reads config from .claude/rungate/ directory (preferred) or
 * .claude/rungate.json (fallback). Merges directory files into
 * the same shape as the monolith for backward compatibility.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

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

export interface RungateConfig {
  project: string;
  repo: string;
  issueRepo: string;
  contextDocs: Record<string, string>;
  consumers: string[];
  pages: Record<string, unknown>;
  test: { command: string; timeout: number };
  roles: Record<string, unknown>;
  hooks: unknown[];
  compliance?: ComplianceConfig;
}

const DIRECTORY_CONFIG_FILES = ["config.json", "roles.json", "hooks.json", "compliance.json"];

export function loadRungateConfig(projectRoot: string): RungateConfig {
  const dirPath = join(projectRoot, ".claude", "rungate");
  const monolithPath = join(projectRoot, ".claude", "rungate.json");

  const config = resolveRungateConfig(projectRoot);
  if (config) return config;

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
export function tryLoadRungateConfig(projectRoot: string): RungateConfig | null {
  return resolveRungateConfig(projectRoot);
}

/** Directory form wins over the monolith; returns null when neither is present. */
function resolveRungateConfig(projectRoot: string): RungateConfig | null {
  const dirPath = join(projectRoot, ".claude", "rungate");
  const monolithPath = join(projectRoot, ".claude", "rungate.json");

  // config.json is the sole marker for the directory form. Treating any
  // fragment as the marker let a stray roles.json shadow a complete monolith
  // and silently drop issueRepo/ci/test — ADR-001 Step E keeps the monolith
  // in place during migration, so that state is on the normal upgrade path.
  if (existsSync(join(dirPath, "config.json"))) {
    return loadFromDirectory(dirPath);
  }

  if (existsSync(monolithPath)) {
    return loadFromMonolith(monolithPath);
  }

  // Fragments with no config.json and no monolith is a broken directory
  // config, not an unconfigured project. Fail loudly rather than returning
  // null, which the caller would read as "no rungate here".
  const orphans = DIRECTORY_CONFIG_FILES.filter((file) => existsSync(join(dirPath, file)));
  if (orphans.length > 0) {
    throw new Error(
      `Incomplete rungate config at ${dirPath}: found ${orphans.join(", ")} but no config.json`
    );
  }

  return null;
}

function loadFromDirectory(dirPath: string): RungateConfig {
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

  return { ...config, roles, hooks, compliance };
}

function loadFromMonolith(path: string): RungateConfig {
  return readJson(path);
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
