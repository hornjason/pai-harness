/**
 * Where a registration's path actually RESOLVES — the tree the settings
 * register, against the tree the repo tests (#713).
 *
 * A near-leaf module: its only relative imports are `hook-trees` (one argv
 * parse) and `hook-scopes` (one definition of a complete scope reading), so
 * there is one binding to mutate per question and no second opinion about
 * either.
 *
 * ## The reading that was missing, with the cost attached
 *
 * `lib/hook-trees.ts` decides the tree by SPELLING: a command containing
 * `${RUNGATE_HOOKS_DIR}` reads as `"rungate"`, which every check in this repo
 * then treats as *this checkout*. Measured 2026-10-21 on the author's
 * machine, `~/.claude/settings.json` defines
 *
 *     RUNGATE_HOOKS_DIR = <a checkout that is not this one>
 *
 * and registers fourteen hook commands through it. So the spelling says
 * "rungate" and the bytes that execute are a different tree's. `#999` merged
 * a shell-injection fix into `hooks/ProjectStateSync.hook.ts` — replacing an
 * `execSync` template literal carrying tool input with an argv
 * `execFileSync` — and the file the registration resolves to still carries
 * the `execSync` form. **A merged security fix did not reach the code that
 * runs**, and the whole suite was green through it, including a case titled
 * *"every hook this repo owns is wired to this repo's copy"*.
 *
 * That case is not wrong about what it asserts. It asserts the spelling, and
 * the spelling was right. Nothing resolved it.
 *
 * ## The property
 *
 * **The tree the settings register is the tree the repo tests.** It is a
 * statement about a RESOLVED path, and it cannot be decided from any amount
 * of reading the command string — which is why this module exists beside
 * `registrationTree` rather than inside it. `registrationTree` answers
 * *which root is this spelled with*; this answers *which directory does that
 * root name on the machine doing the reading*. They are different questions
 * and the first one has been standing in for the second.
 *
 * ## Why this is a REFUSAL, and the three ways it would otherwise fail open
 *
 * Each of these produces a clean-looking reading from no evidence, and all
 * three are reachable here (`.claude/rules/config-access.md`):
 *
 * | the silent pass | what it must read as instead |
 * |---|---|
 * | a variable no readable scope defines, assumed to mean this repo | `unresolved` → UNMEASURED |
 * | a scope nobody could open, counted as registering nothing | UNMEASURED, with the scope named |
 * | **zero registrations examined** | UNMEASURED — *zero trees compared is not perfect agreement* |
 *
 * The third is the one with no analogue in the existing census and the one a
 * reader is least likely to write a case for: `foreign.length === 0` is the
 * same value for a tree with every hook correctly wired and for a run that
 * looked at nothing. `examined` is carried so the two are distinguishable,
 * and the reading refuses rather than leaving it to a caller to notice.
 *
 * ## `CLAUDE_PROJECT_DIR` resolves only in a scope the repo owns
 *
 * In `.claude/settings.json` it is this repository by definition — that file
 * loads only for a session started here. In `~/.claude/settings.json` it is
 * **whatever directory the session was started in**, which is session state
 * and not knowable from any file. Resolving it to the repo root in both
 * places would be the first row of the table above, wearing the costume of
 * an obvious simplification: it would turn a user-scope registration that may
 * execute any checkout into a confident `in-repo`.
 *
 * ## A variable with two values is UNRESOLVED, not a precedence puzzle
 *
 * Two scopes defining the same variable differently is a state this module
 * refuses rather than ranks. Picking a winner means encoding a precedence
 * order nobody has written down, and being wrong about it produces exactly
 * the confident-and-wrong path this file exists to stop.
 */

import { executedHookPath } from "./hook-trees";
import {
  type RegistrationScope,
  type ScopeReading,
  assertEveryScopeRead,
  settingsScopePaths,
} from "./hook-scopes";

/**
 * The scopes in which `${CLAUDE_PROJECT_DIR}` is THIS repository.
 *
 * Derived from nothing: it is the list of scopes that only load for a session
 * started in this tree. `repo-registry` is included because
 * `.claude/rungate/hooks.json` is scaffolded into the project settings and
 * has the same reach.
 */
const PROJECT_DIR_SCOPES: RegistrationScope[] = [
  "project-settings",
  "project-local-settings",
  "repo-registry",
];

/** `env` assignments read from one settings scope. `null` means unreadable. */
export interface EnvReading {
  scope: RegistrationScope;
  env: Record<string, string> | null;
  /** Why it could not be read. REQUIRED when `env` is null. */
  unreadable?: string;
}

/**
 * The `env` block of one settings document.
 *
 * A document that does not parse THROWS, for the same reason
 * `settingsCommands` throws: a corrupt settings file is not a settings file
 * with no variables in it, and swallowing it would turn every variable it
 * defines into `unresolved` — a refusal, but for the wrong reason, and one
 * nobody could act on.
 *
 * Non-string values are DROPPED rather than coerced. `"X": 3` is not a path
 * fragment and `String(3)` would build one.
 */
export function settingsEnv(doc: string): Record<string, string> {
  const parsed = JSON.parse(doc) as { env?: unknown };
  const env = parsed?.env;
  if (env === null || typeof env !== "object" || Array.isArray(env)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Every distinct value each variable is given, across the scopes that could
 * be read.
 *
 * A list rather than a value, so a variable defined twice differently is
 * visible as such at the point of use instead of being resolved by whichever
 * scope happened to be last.
 */
export function mergeEnv(readings: EnvReading[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of readings) {
    for (const [k, v] of Object.entries(r.env ?? {})) {
      const seen = (out[k] ??= []);
      if (!seen.includes(v)) seen.push(v);
    }
  }
  return out;
}

/**
 * Assemble a complete env reading from a filesystem.
 *
 * Deliberately shaped like `readRegistrationScopes` and reading the SAME
 * `settingsScopePaths` declaration, including its `ownership` field — so what
 * an absent file means is decided in one place for both readings. A reader
 * with its own idea of that is how `unregistered` became unreachable once
 * already (battery row M6 of #970).
 *
 * `repo-registry` is a hooks array, not a settings document, so it defines no
 * variables. It is present with an empty reading rather than omitted: an
 * omitted scope is what `assertEveryScopeRead` exists to refuse, and "this
 * scope cannot define variables" is a reading.
 */
export function readEnvScopes(
  repoRoot: string,
  home: string,
  readFile: (path: string) => string | null,
): EnvReading[] {
  const readings: EnvReading[] = settingsScopePaths(repoRoot, home).map(
    ({ scope, path, ownership }) => {
      const doc = readFile(path);
      if (doc !== null) return { scope, env: settingsEnv(doc) };
      if (ownership === "repo") return { scope, env: {} };
      return {
        scope,
        env: null,
        unreadable:
          `${path} is not on this machine, and it is machine state the repo does not own — so ` +
          `any variable it defines is a value this run never saw`,
      };
    },
  );
  readings.push({ scope: "repo-registry", env: {} });
  return readings;
}

export type Resolution =
  | { kind: "resolved"; path: string }
  | { kind: "unresolved"; reason: string };

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * The first variable a raw path is reached through, or `"literal"`.
 *
 * This is what a ratchet keys on. Not the resolved directory — that is a
 * machine path, and a machine path in a committed file is wrong on the next
 * machine and churns on this one. Not the hook name either: a hundred hooks
 * behind one misdirected variable is ONE fact, and banking it a hundred times
 * means the entry churns on every hook added.
 */
export function pathSpelling(raw: string): string {
  VAR.lastIndex = 0;
  const m = VAR.exec(raw);
  return m ? (m[1] ?? m[2]) : "literal";
}

/**
 * Expand `${VAR}` and `$VAR` against a reading, or say which variable stopped
 * it.
 *
 * `projectDir` is `null` in a scope where `${CLAUDE_PROJECT_DIR}` is session
 * state — see the header. Passing the repo root there regardless is the
 * cheapest wrong fix available at this call site and it is the one that
 * reintroduces the defect.
 */
export function resolvePath(
  raw: string,
  env: Record<string, string[]>,
  projectDir: string | null,
): Resolution {
  const unresolved: string[] = [];
  const expanded = raw.replace(VAR, (whole, braced?: string, bare?: string) => {
    const name = braced ?? bare ?? "";
    if (name === "CLAUDE_PROJECT_DIR") {
      if (projectDir !== null) return projectDir;
      unresolved.push(
        `${name} is the directory the session was started in, which is session state and is ` +
          `not readable from this scope`,
      );
      return whole;
    }
    const values = env[name];
    if (values === undefined || values.length === 0) {
      unresolved.push(`${name} is not defined by any scope this run could read`);
      return whole;
    }
    if (values.length > 1) {
      unresolved.push(
        `${name} is defined ${values.length} times with different values, and which one applies ` +
          `is a precedence question nobody has written down`,
      );
      return whole;
    }
    return values[0];
  });

  if (unresolved.length > 0) return { kind: "unresolved", reason: unresolved.join("; ") };
  if (!expanded.startsWith("/")) {
    return {
      kind: "unresolved",
      reason:
        `${expanded} is not absolute, so which directory it names depends on the working ` +
        `directory of whatever spawns the hook`,
    };
  }
  return { kind: "resolved", path: normalize(expanded) };
}

/** Collapse `//`, `/./` and a trailing slash. No `fs`, so no symlink resolution. */
function normalize(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." ) { parts.pop(); continue; }
    parts.push(seg);
  }
  return "/" + parts.join("/");
}

export type Target = "in-repo" | "foreign" | "unresolved";

export interface TargetReading {
  hook: string;
  scope: RegistrationScope;
  command: string;
  /** The variable the path is reached through, or `"literal"`. */
  spelling: string;
  target: Target;
  /** The absolute path the registration resolves to, when it resolved. */
  resolved: string | null;
  detail: string;
}

export interface TargetTreeCensus {
  reading: "MEASURED" | "UNMEASURED";
  unmeasuredReasons: string[];
  /** How many registrations this run actually looked at. */
  examined: number;
  inRepo: TargetReading[];
  foreign: TargetReading[];
  unresolved: TargetReading[];
}

/**
 * Resolve every registration of every hook this repo owns, and say which tree
 * it lands in.
 *
 * `readings` carries the commands and `envReadings` carries the variables,
 * and BOTH go through `assertEveryScopeRead` — the one binding deciding what
 * a complete reading is. A second definition of completeness here would be
 * two deciders for one question
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape), and the
 * env half is the one that would quietly acquire a narrower scope list: a
 * variable defined in a scope nobody read is indistinguishable from a
 * variable nobody defined, and only the first of those is innocent.
 */
export function registeredTreeCensus(
  owned: string[],
  readings: ScopeReading[],
  envReadings: EnvReading[],
  repoRoot: string,
): TargetTreeCensus {
  assertEveryScopeRead(readings);
  assertEveryScopeRead(
    envReadings.map(r => ({
      scope: r.scope,
      commands: r.env === null ? null : [],
      unreadable: r.unreadable,
    })),
  );

  const reasons: string[] = [];
  for (const r of readings) {
    if (r.commands === null) reasons.push(`${r.scope} commands: ${r.unreadable}`);
  }
  for (const r of envReadings) {
    if (r.env === null) reasons.push(`${r.scope} env: ${r.unreadable}`);
  }

  const env = mergeEnv(envReadings);
  const hooksDir = normalize(`${repoRoot}/hooks`);
  const out: TargetReading[] = [];
  let examined = 0;

  for (const reading of readings) {
    const projectDir = PROJECT_DIR_SCOPES.includes(reading.scope) ? repoRoot : null;
    for (const command of reading.commands ?? []) {
      const raw = executedHookPath(command);
      if (raw === null) continue;
      const base = raw.slice(raw.lastIndexOf("/") + 1).replace(/\.hook\.ts$/, "");
      if (!owned.includes(base)) continue;

      examined++;
      const spelling = pathSpelling(raw);
      const res = resolvePath(raw, env, projectDir);
      if (res.kind === "unresolved") {
        out.push({
          hook: base,
          scope: reading.scope,
          command,
          spelling,
          target: "unresolved",
          resolved: null,
          detail:
            `${base} is registered in ${reading.scope} as ${raw}, and which directory that names ` +
            `could not be read: ${res.reason}. An unresolved path is not this repo's copy; it is ` +
            `no reading at all`,
        });
        continue;
      }

      const dir = res.path.slice(0, res.path.lastIndexOf("/"));
      const inRepo = dir === hooksDir;
      out.push({
        hook: base,
        scope: reading.scope,
        command,
        spelling,
        target: inRepo ? "in-repo" : "foreign",
        resolved: res.path,
        detail: inRepo
          ? `${base} is registered in ${reading.scope} and resolves to ${res.path}, inside the ` +
            `tree this suite runs against`
          : `${base} is registered in ${reading.scope} as ${raw}, which resolves to ${res.path} — ` +
            `OUTSIDE ${hooksDir}. Nothing merged into this repository reaches that file, and ` +
            `every check here is measuring bytes that do not execute`,
      });
    }
  }

  const unresolved = out.filter(r => r.target === "unresolved");
  for (const r of unresolved) reasons.push(r.detail);
  if (examined === 0) {
    reasons.push(
      `no registration of a hook this repo owns was examined, so no tree was compared with any ` +
        `other. Zero trees compared is not perfect agreement — an empty violation list here means ` +
        `the run found nothing to read, which is the state CI is in and is not a pass`,
    );
  }

  return {
    reading: reasons.length === 0 ? "MEASURED" : "UNMEASURED",
    unmeasuredReasons: reasons,
    examined,
    inRepo: out.filter(r => r.target === "in-repo"),
    foreign: out.filter(r => r.target === "foreign"),
    unresolved,
  };
}
