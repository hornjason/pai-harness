/**
 * Every settings scope, read before anything is concluded about one hook
 * (#713, #910).
 *
 * A LEAF module whose only relative dependency is `hook-trees`, so there is
 * one thing to mutate and one extractor deciding what a command is.
 *
 * ## The defect this exists to make unavailable
 *
 * Twice in three weeks, a census counted the hooks in ONE settings scope,
 * found zero, and reported that as absence.
 *
 * - #713 read `~/.claude/settings.json` and reported `AgentBriefGuard` "dead
 *   in both trees — wired nowhere". It is registered in the repo's PROJECT
 *   settings as `bun ${CLAUDE_PROJECT_DIR}/hooks/AgentBriefGuard.hook.ts`.
 * - #910 read this repository's own registries and reported
 *   `TestSuiteRelease.hook.ts` and `ProjectStateSync.hook.ts` "in NO registry"
 *   and never able to fire. Both are registered in `~/.claude/settings.json`
 *   and have been throughout — measured 2026-10-21, parsed rather than
 *   grepped.
 *
 * Same error, opposite scope. `lib/hook-trees.ts` records the first one in its
 * own header and says *"Read EVERY settings scope before concluding anything
 * about one hook"*, and a census that read one shipped anyway. A sentence in a
 * docblock is not a rule (`.claude/rules/config-access.md`).
 *
 * ## Why this is a refusal and not a wider reader
 *
 * The repair that suggests itself is to read more scopes. That is
 * `.claude/rules/checks-must-be-able-to-fail.md`'s fifth shape waiting to
 * happen: it fixes the two instances and leaves the next narrow reading free
 * to report confident absence again, because nothing says a reading has to be
 * complete before a verdict comes out of it.
 *
 * So `hookRegistration` THROWS unless it is handed a reading for every scope
 * in `REGISTRATION_SCOPES`, and an unreadable scope must carry a reason. A
 * caller that opened one file gets a refusal, not an answer.
 *
 * ## The asymmetry, which is the correctness argument
 *
 * A POSITIVE is conclusive from a single scope: a command naming the hook is
 * a registration, whatever the other four say. A NEGATIVE is conclusive from
 * no number of scopes short of all of them. So:
 *
 * | reading | verdict |
 * |---|---|
 * | named by at least one scope | `registered` |
 * | named by none, every scope read | `unregistered` |
 * | named by none, some scope unreadable | `unmeasured` |
 *
 * `unmeasured` is the state CI is in — `~/.claude/settings.json` is machine
 * state and no runner has one — and it is reported rather than skipped,
 * because `0`, `{}`, `null`, `SKIP` and a skipped test are indistinguishable
 * from success and a reading is not.
 */

import { join } from "path";

import { settingsCommands } from "./hook-trees";

/**
 * Every position that can register a hook, in one declaring position.
 *
 * `repo-registry` is `.claude/rungate/hooks.json` through
 * `lib/config-loader.ts`, not a settings document, so it has no path here —
 * see `settingsScopePaths`, and the case asserting the two cover this list
 * between them.
 *
 * Adding a scope is one edit, and it makes every existing reading incomplete
 * until its callers supply the new one. That is the intended cost: a scope
 * nobody reads must not be a scope a verdict silently ignores.
 */
export const REGISTRATION_SCOPES = [
  "repo-registry",
  "project-settings",
  "project-local-settings",
  "user-settings",
  "user-local-settings",
] as const;

export type RegistrationScope = (typeof REGISTRATION_SCOPES)[number];

export interface ScopeReading {
  scope: RegistrationScope;
  /** Commands read from this scope. `null` means the scope could not be read. */
  commands: string[] | null;
  /** Why it could not be read. REQUIRED when `commands` is null. */
  unreadable?: string;
}

/** A reading that cannot support a verdict. Never a verdict of its own. */
export class IncompleteScopeReadingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteScopeReadingError";
  }
}

export type RegistrationVerdict = "registered" | "unregistered" | "unmeasured";

export interface HookRegistration {
  hook: string;
  verdict: RegistrationVerdict;
  /** The scopes whose commands name this hook. */
  registeredIn: RegistrationScope[];
  /** The scopes this run could not read. */
  unreadable: RegistrationScope[];
  detail: string;
}

/**
 * Who owns a scope, which decides what an ABSENT file means there.
 *
 * This distinction is the whole of #199 and #479 and it is easy to lose. For
 * a scope the repo owns, a file that is not there is a complete reading: it
 * registers nothing, and that is a fact CI can assert. For a scope on the
 * machine, a file that is not there is **no reading at all** — every runner
 * lacks `~/.claude/settings.json`, and treating that as "registers nothing"
 * is how a check comes to report hooks unregistered that are registered.
 *
 * Collapsing the two was measured, not reasoned about: with every absent file
 * read as unreadable, this repo has no `.claude/settings.local.json`, so
 * every verdict on every machine carried an unreadable scope and `AC-4` could
 * never conclude `unregistered` — a check that cannot fail
 * (`.claude/rules/checks-must-be-able-to-fail.md`). Found by battery row M6
 * coming back 4 against a predicted 1.
 */
export type ScopeOwnership = "repo" | "machine";

/**
 * Where each settings scope lives, given a repo root and a home directory.
 *
 * Takes both rather than reading `process.env` or `homedir()`, for the reason
 * `reconcile` takes documents: a function that reads ambient state can only be
 * tested against ambient state.
 */
export function settingsScopePaths(
  repoRoot: string,
  home: string,
): { scope: RegistrationScope; path: string; ownership: ScopeOwnership }[] {
  return [
    {
      scope: "project-settings",
      path: join(repoRoot, ".claude", "settings.json"),
      ownership: "repo",
    },
    {
      scope: "project-local-settings",
      path: join(repoRoot, ".claude", "settings.local.json"),
      ownership: "repo",
    },
    { scope: "user-settings", path: join(home, ".claude", "settings.json"), ownership: "machine" },
    {
      scope: "user-local-settings",
      path: join(home, ".claude", "settings.local.json"),
      ownership: "machine",
    },
  ];
}

/**
 * Assemble a complete reading from a filesystem.
 *
 * ONE binding for "which scopes exist and how are they read", so a caller
 * cannot have its own idea of the scope list — three files in this tree did,
 * and two of them were wrong in opposite directions.
 *
 * `readFile` is injected and returns `null` for a file that is not there, so
 * this module keeps no `fs` import and a case can drive an absent scope
 * without touching the machine. A file that EXISTS and cannot be read or
 * parsed must throw out of `readFile` or out of `settingsCommands` — a
 * corrupt settings file is not a settings file with no hooks in it
 * (`.claude/rules/config-access.md`).
 *
 * `repoRegistryCommands` comes from the caller because the registry is
 * resolved by `lib/config-loader.ts`, which supports two layouts and is not a
 * settings document.
 *
 * What an absent file means depends on who owns the scope — see
 * `ScopeOwnership`. The result is validated before it is returned: a reader
 * that assembled an incomplete reading must fail where it read, not where
 * somebody later drew a conclusion from it.
 */
export function readRegistrationScopes(
  repoRoot: string,
  home: string,
  readFile: (path: string) => string | null,
  repoRegistryCommands: string[],
): ScopeReading[] {
  const readings: ScopeReading[] = settingsScopePaths(repoRoot, home).map(
    ({ scope, path, ownership }) => {
      const doc = readFile(path);
      if (doc !== null) return { scope, commands: settingsCommands([doc]) };
      if (ownership === "repo") {
        // A committed scope that is not in the tree registers nothing, and
        // that is a reading rather than the absence of one.
        return { scope, commands: [] };
      }
      return {
        scope,
        commands: null,
        unreadable: `${path} is not on this machine, and it is machine state the repo does not own`,
      };
    },
  );
  readings.push({ scope: "repo-registry", commands: repoRegistryCommands });
  assertEveryScopeRead(readings);
  return readings;
}

/**
 * Refuse a reading that cannot support a verdict.
 *
 * Exported so a caller can establish completeness once before a loop, and so
 * there is exactly one binding deciding what "complete" means. Every entry
 * point below goes through it; none re-derives the question.
 */
export function assertEveryScopeRead(readings: ScopeReading[]): void {
  const seen = readings.map(r => r.scope);
  const missing = REGISTRATION_SCOPES.filter(s => !seen.includes(s));
  if (missing.length > 0) {
    throw new IncompleteScopeReadingError(
      `a registration verdict needs a reading for every scope and ${missing.join(", ")} ` +
        `${missing.length === 1 ? "was" : "were"} not supplied. Reading one scope and taking zero ` +
        `hits as absence is #713 and #910; supply the scope with commands, or with ` +
        `commands: null and a reason saying why it could not be read.`,
    );
  }
  const duplicated = [...new Set(seen.filter((s, i) => seen.indexOf(s) !== i))];
  if (duplicated.length > 0) {
    throw new IncompleteScopeReadingError(
      `${duplicated.join(", ")} was supplied more than once, so the reading covers fewer scopes ` +
        `than it has entries. Completeness is over the SET of scopes, never the count.`,
    );
  }
  for (const r of readings) {
    const reason = (r.unreadable ?? "").trim();
    if (r.commands === null && reason === "") {
      throw new IncompleteScopeReadingError(
        `${r.scope} reports no commands and does not say why. An unreadable scope and a scope ` +
          `nobody opened produce the same empty reading, and which of those happened is the ` +
          `whole question.`,
      );
    }
    if (r.commands !== null && reason !== "") {
      throw new IncompleteScopeReadingError(
        `${r.scope} carries both commands and a reason it could not be read, so no caller can ` +
          `tell which of the two is the reading.`,
      );
    }
  }
}

/**
 * One hook's registration, over a complete reading of every scope.
 *
 * Reports nothing about which TREE a registration points into — that is
 * `wrongTreeViolations`' question in `lib/hook-trees.ts`, and answering it
 * here as well would be two deciders for one question
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
 */
export function hookRegistration(hook: string, readings: ScopeReading[]): HookRegistration {
  assertEveryScopeRead(readings);

  const needle = `${hook}.hook.ts`;
  const registeredIn = readings
    .filter(r => (r.commands ?? []).some(c => c.includes(needle)))
    .map(r => r.scope);
  const unreadable = readings.filter(r => r.commands === null).map(r => r.scope);

  // A positive is conclusive from one scope; a negative is conclusive from
  // none short of all of them. The order of these two branches IS the
  // asymmetry — swapping them would make a hook that is demonstrably
  // registered report `unmeasured` because some unrelated scope was absent.
  if (registeredIn.length > 0) {
    return {
      hook,
      verdict: "registered",
      registeredIn,
      unreadable,
      detail: `registered in ${registeredIn.join(", ")}`,
    };
  }

  if (unreadable.length > 0) {
    const reasons = readings
      .filter(r => r.commands === null)
      .map(r => `${r.scope}: ${r.unreadable}`)
      .join("; ");
    return {
      hook,
      verdict: "unmeasured",
      registeredIn: [],
      unreadable,
      detail:
        `no scope this run could read names ${needle}, and ${unreadable.join(", ")} could not be ` +
        `read (${reasons}). This is not "not registered" — it is a reading nobody was able to ` +
        `take, which is exactly what #910 reported as absence.`,
    };
  }

  return {
    hook,
    verdict: "unregistered",
    registeredIn: [],
    unreadable: [],
    detail: `all ${REGISTRATION_SCOPES.length} scopes were read and none names ${needle}`,
  };
}

/** The same verdict for a list of hooks, over one reading. */
export function registrationCensus(
  hooks: string[],
  readings: ScopeReading[],
): HookRegistration[] {
  assertEveryScopeRead(readings);
  return hooks.map(h => hookRegistration(h, readings));
}
