/**
 * config-loader.ts — the one module that knows where rungate config LIVES
 *
 * Reads config from .claude/rungate/ directory (preferred) or
 * .claude/rungate.json (fallback). Merges directory files into
 * the same shape as the monolith for backward compatibility.
 *
 * It owns the WRITE side too (#415). ADR-002 D1 is usually quoted as "only
 * this module may read the config", but the thing being centralised is the
 * knowledge of which file a project's config is in, and a writer that answers
 * that question for itself is a second answer to drift from. `create-brief`
 * was the live instance: it built `.claude/rungate.json`, handed it to a
 * writer, and on a project that had followed the documented migration printed
 * "not found — role not registered", naming a file the project is documented
 * not to have. The brief was written and the role was registered nowhere.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import {
  ContainerSchema,
  DevSchema,
  ProdSchema,
  ProjectHarnessSchema,
  TestSchema,
} from "./rungate-schema";

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
    /**
     * Names a cross-project document may call this project by (#442).
     *
     * Optional: the directory name and the GitHub slug are derived from the
     * tree, so this is only for what a human knows — the abbreviation, the
     * product name, the thing the team says out loud.
     */
    aliases?: string[];
  };
}

/**
 * URLs are validated where a config is AUTHORED (`parseProjectHarness`), not
 * where it is READ. A reader that throws on a cosmetically odd `apiBase` turns
 * a working project into a broken one, which is the opposite of ADR-001 D2's
 * intent: the loader distinguishes present / absent / unreadable, and nothing
 * else. Top-level keys are optional for the same reason — requiring `project`
 * here would add a third outcome the two wrappers have no way to express.
 */
const LooseUrl = z.string().nullish();

/**
 * The resolved shape (ADR-002 D3), derived from the authored schema rather
 * than hand-declared. The interface this replaces claimed `test.command` was
 * required while `TestSchema` did not declare it at all — two hand-written
 * types for one file, disagreeing, which is how a reader could be written
 * against a key the validator deleted.
 *
 * `.passthrough()` is load-bearing: consumers carry keys rungate has never
 * heard of (DDB's `remoteHosts`), and a loader that silently drops them is the
 * same defect as a validator that strips `container`.
 */
export const ResolvedConfigSchema = ProjectHarnessSchema.partial()
  .extend({
    // `null` is what a greenfield scaffold writes for a base URL it could not
    // detect. It is an authored absence, not a broken config.
    dev: DevSchema.partial().extend({ apiBase: LooseUrl, uiBase: LooseUrl }).optional(),
    test: TestSchema.extend({ apiBase: LooseUrl }).optional(),
    prod: ProdSchema.extend({ apiBase: LooseUrl, uiBase: LooseUrl }).optional(),
    container: ContainerSchema.optional(),
    pages: z.record(z.unknown()).optional(),
    // Merged from side files by the directory loader, so always present in the
    // resolved shape — callers index them without a null check.
    roles: z.record(z.unknown()).default({}),
    hooks: z.array(z.unknown()).default([]),
    compliance: z
      .custom<ComplianceConfig>((value) => typeof value === "object" && value !== null)
      .optional(),
    // Normalised, not authored — see normaliseConfig.
    apiUrl: z.string().optional(),
    uiUrl: z.string().optional(),
  })
  .passthrough();

export type ResolvedConfig = z.infer<typeof ResolvedConfigSchema>;

/** ship.js:1705's fallback, kept identical so normalisation changes no run. */
export const DEFAULT_TEST_TIMEOUT = 120000;

/**
 * The config's path relative to a project root, in the directory layout.
 *
 * Exported because a reader sometimes has to NAME the file without reading
 * it — `scripts/contract-parity.ts` compares what each position in a tree
 * DECLARES, so it labels and plants the config by path. Writing that literal
 * anywhere else is a CONFIG-1 violation and rightly so, and the fix for a
 * label is the same as the fix for a read: get it from here, so there is one
 * module that knows where the config lives.
 */
export const RUNGATE_CONFIG_RELATIVE_PATH = join(".claude", "rungate", "config.json");

/**
 * Every path a project's rungate config can occupy, in POSIX form, newest
 * layout first (#505).
 *
 * Slash-separated and not `join`ed, because the one consumer outside this
 * module compares them against `.gitignore` patterns and `git check-ignore`
 * output, both of which are POSIX whatever the platform. A `path.join` here
 * would produce backslashes on Windows and silently stop matching.
 *
 * It exists because a question about the config's LOCATION is the same
 * question `resolveConfig` answers, and ADR-002 D1 centralises that for a
 * reason — a second list is a second answer to drift from, and this one is
 * consulted by a step that EDITS the project's ignore rules. A stale entry
 * there does not produce a wrong reading; it produces a config file the
 * project cannot commit.
 */
export const RUNGATE_CONFIG_IGNORE_PATHS = [
  ".claude/rungate/config.json",
  ".claude/rungate.json",
] as const;

/** The directory both of the above sit in. */
export const RUNGATE_CONFIG_PARENT_DIR = ".claude";

/** The directory layout's own directory, POSIX form, for the same consumer. */
export const RUNGATE_CONFIG_DIR = ".claude/rungate";

/**
 * The resolution (ADR-002 D2(a)). `absent` is TRUTHY and carries no `.test`,
 * so the four sites that wrote `config?.test?.command || fallback` cannot
 * silently absorb it — `null`, `0`, `{}` and `""` all could.
 *
 * Malformed JSON and orphaned fragments THROW, per ADR-001 D2. Unchanged.
 */
export type ConfigResolution =
  | {
      status: "resolved";
      config: ResolvedConfig;
      source: "directory" | "monolith";
      /** The directory or file the config was read from (#415). */
      path: string;
    }
  | { status: "absent" };

/**
 * The files the directory layout is made of.
 *
 * Exported because the scaffold's `.gitignore` negation has to name each one
 * (#505): the negation re-includes `.claude/rungate/` and then re-excludes
 * its contents, so a config file this list does not carry is a config file
 * the project cannot commit — and losing `roles.json` to a branch switch is
 * the same defect as losing `config.json`. One list, in the module that
 * knows where the config lives, or the two drift and the symptom is a file
 * that silently stops being version-controlled.
 */
export const DIRECTORY_CONFIG_FILES = ["config.json", "roles.json", "hooks.json", "compliance.json"];

/**
 * ADR-002 D3. `dev.*` is the authored canonical shape; `test.command` keeps
 * being read and is NOT deprecated here — it is rungate's own live config, and
 * moving the dogfood and the consumer path in one change would leave neither
 * as a control for the other.
 */
function normaliseConfig(raw: unknown): ResolvedConfig {
  const parsed = ResolvedConfigSchema.parse(raw);

  // The trailing `?? undefined` collapses an authored `null` — a base URL the
  // scaffold could not detect — into the same absence an omitted key gives.
  // Two spellings of "not set" reaching readers is how this class of bug
  // started.
  return {
    ...parsed,
    apiUrl: parsed.apiUrl ?? parsed.dev?.apiBase ?? undefined,
    uiUrl: parsed.uiUrl ?? parsed.dev?.uiBase ?? undefined,
    test: {
      ...parsed.test,
      // dev.* wins. No `|| "bun test"` fallback: an absent command must stay
      // absent so a reader can report it unmeasured rather than run the wrong
      // suite and report 0 failures.
      command: parsed.dev?.testCmd ?? parsed.test?.command,
      timeout: parsed.test?.timeout ?? DEFAULT_TEST_TIMEOUT,
    },
  };
}

/**
 * The single resolution point. Directory form wins over the monolith.
 */
export function resolveConfig(projectRoot: string): ConfigResolution {
  const dirPath = join(projectRoot, ".claude", "rungate");
  const monolithPath = join(projectRoot, ".claude", "rungate.json");

  // config.json is the sole marker for the directory form. Treating any
  // fragment as the marker let a stray roles.json shadow a complete monolith
  // and silently drop issueRepo/ci/test — ADR-001 Step E keeps the monolith
  // in place during migration, so that state is on the normal upgrade path.
  if (existsSync(join(dirPath, "config.json"))) {
    return {
      status: "resolved",
      config: loadFromDirectory(dirPath),
      source: "directory",
      path: dirPath,
    };
  }

  if (existsSync(monolithPath)) {
    return {
      status: "resolved",
      config: loadFromMonolith(monolithPath),
      source: "monolith",
      path: monolithPath,
    };
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

  return normaliseConfig({ ...config, roles, hooks, compliance });
}

function loadFromMonolith(path: string): ResolvedConfig {
  return normaliseConfig(readJson(path));
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

/**
 * Register a role in whichever layout the project is actually on (#415).
 *
 * The counterpart to `loadRoleConfig`, and deliberately in the same module:
 * the writer has to make the same choice between the two layouts that the
 * reader makes, and a second place making it is how `create-brief` came to
 * write a monolith a migrated consumer does not have.
 *
 * Throws on an unscaffolded project. There is no third branch that invents a
 * layout — a tool that creates `.claude/rungate.json` beside an existing
 * `.claude/rungate/` gives the project two role sets and lets whichever the
 * reader prefers decide what the project is, which is #70 one layer up.
 *
 * Returns the file written, so a caller can say where the role went rather
 * than naming a path it guessed.
 */
export function writeRoleConfig(
  projectRoot: string,
  roleName: string,
  role: unknown,
): string {
  const resolution = resolveConfig(projectRoot);
  if (resolution.status === "absent") {
    throw new Error(
      `No rungate config found under ${join(projectRoot, ".claude")} — ` +
        `scaffold the project before registering a role`,
    );
  }

  const target =
    resolution.source === "directory"
      ? join(resolution.path, "roles.json")
      : resolution.path;

  const existing = existsSync(target) ? readJson(target) : {};
  const roles = resolution.source === "directory" ? existing : (existing.roles ??= {});

  if (roles[roleName]) {
    throw new Error(`Role '${roleName}' already exists in ${target}`);
  }
  roles[roleName] = role;

  writeFileSync(target, JSON.stringify(existing, null, 2) + "\n");
  return target;
}

/** Whether a scaffold wrote, or stepped aside because something was there. */
export type ScaffoldWriteResult =
  | { status: "created"; path: string }
  | { status: "exists"; path: string };

/**
 * Create a project's config in the DIRECTORY layout (#415).
 *
 * `scripts/scaffold-rungate-config.ts` built these four paths itself, which
 * put two modules in the business of knowing the layout — and left the
 * scaffolder banked in the config-access ratchet at a number no migration
 * could ever lower, because there was no read to migrate.
 *
 * **The "already there" decision lives here and only here.** The script used
 * to make it as well, which made this one unreachable: a mutation that
 * deleted it left the caller's copy still refusing, so the guard measured as
 * load-bearing while nothing depended on it. Two deciders that agree are
 * behaviourally one.
 *
 * Returns rather than throwing, so the caller reports the outcome without
 * having to sniff an exception message for a prefix.
 */
export function writeScaffoldedConfig(
  projectRoot: string,
  parts: { config: unknown; roles: unknown; hooks: unknown; compliance: unknown },
): ScaffoldWriteResult {
  const resolution = resolveConfig(projectRoot);
  if (resolution.status === "resolved") {
    return { status: "exists", path: resolution.path };
  }

  const dirPath = join(projectRoot, ".claude", "rungate");
  mkdirSync(dirPath, { recursive: true });
  const files: Array<[string, unknown]> = [
    ["config.json", parts.config],
    ["roles.json", parts.roles],
    ["hooks.json", parts.hooks],
    ["compliance.json", parts.compliance],
  ];
  for (const [name, body] of files) {
    writeFileSync(join(dirPath, name), JSON.stringify(body, null, 2) + "\n");
  }
  return { status: "created", path: dirPath };
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
