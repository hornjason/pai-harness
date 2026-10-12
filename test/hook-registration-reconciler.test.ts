import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

/**
 * #199 — the hook inventory is an inventory, and nothing reconciles it.
 *
 * `.claude/rungate/hooks.json` declares 16 entries `enabled: true`. Nothing
 * compared that claim to anything, so the inventory could say whatever it
 * liked. The nearest existing test asserts every entry HAS an `enabled`
 * field — it validates the field's presence and never reconciles it, which is
 * the inventory-with-no-reconciler shape the issue names.
 *
 * ## What this file does NOT assert, and why
 *
 * The issue's headline — "five hooks are declared enabled and registered
 * nowhere" — is NOT checkable from this repo, and the first version of this
 * file got that wrong in a way worth recording.
 *
 * That version read `~/.claude/settings.json` alongside the two repo-scoped
 * settings files. On the author's machine that file registers 59 hooks and
 * the count came out at five inert. In CI the file does not exist, the count
 * came out at twelve, and the suite went red. A check that passes locally and
 * fails in CI because it reads machine state is the same defect as SC-91/SC-92
 * in #225, which asserted `.git/hooks/*` — files git cannot carry.
 *
 * It is not a bug in the check so much as the premise: `specs/HOOK-ARCHITECTURE-SPEC.md`
 * SC-518 REQUIRES machine-wide hooks to be registered in user settings rather
 * than project settings, because project settings only load for sessions
 * started in that directory. Registration is therefore machine state by
 * design, the repo does not own it, and no repo test can honestly assert it.
 * "Five" is a fact about one laptop.
 *
 * So the live assertions here cover what the repo DOES own, and the
 * registration logic is proved able to fail against planted fixtures rather
 * than against whatever settings the machine happens to have.
 */

const ROOT = join(import.meta.dir, "..");
const HOOKS_JSON = join(ROOT, ".claude", "rungate", "hooks.json");

interface HookEntry {
  name?: string;
  enabled?: boolean;
  command?: string;
}

function entries(): HookEntry[] {
  return JSON.parse(readFileSync(HOOKS_JSON, "utf-8")) as HookEntry[];
}

function declaredEnabled(): string[] {
  return entries().filter(h => h.enabled === true).map(h => h.name ?? "").filter(Boolean);
}

/**
 * Names registered by a set of settings documents.
 *
 * Takes the documents as strings rather than reading paths, so the live call
 * and the planted-fixture calls below go through the identical code. A helper
 * that reads the filesystem can only be tested against the filesystem, which
 * is how the first version of this file ended up asserting machine state.
 */
export function registeredIn(settingsDocs: string[]): Set<string> {
  const names = new Set<string>();
  for (const doc of settingsDocs) {
    for (const m of doc.matchAll(/([A-Za-z][A-Za-z0-9]*)\.hook\.ts/g)) names.add(m[1]);
  }
  return names;
}

/** Declared enabled, registered in none of the supplied documents. */
export function inertHookViolations(declared: string[], settingsDocs: string[]): string[] {
  const registered = registeredIn(settingsDocs);
  return declared.filter(n => !registered.has(n));
}

describe("#199: the hook inventory is reconciled against what the repo owns", () => {
  test("every hook declared enabled has a handler file to run", () => {
    // The repo-verifiable half of the issue, and a real one: an entry naming
    // a handler that is not there is a command line that fails on every
    // invocation, and `enabled: true` says it is running.
    const missing = declaredEnabled().filter(
      n => !existsSync(join(ROOT, "hooks", `${n}.hook.ts`)),
    );
    expect(
      missing,
      `declared enabled with no hooks/<name>.hook.ts to run: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  test("every entry's command names the same handler as the entry", () => {
    // Copy-paste drift: an entry called X whose command runs Y is registered
    // under one name and executes another, and both halves look right in
    // isolation.
    const wrong: string[] = [];
    for (const h of entries()) {
      if (!h.name || !h.command) continue;
      const named = /([A-Za-z][A-Za-z0-9]*)\.hook\.ts/.exec(h.command)?.[1];
      if (named && named !== h.name) wrong.push(`${h.name} runs ${named}.hook.ts`);
    }
    expect(wrong, `entry name and command disagree: ${wrong.join(", ")}`).toEqual([]);
  });

  test("the inventory is real, so the two checks above are not vacuous", () => {
    // Both assertions are filters, and both are satisfied by an empty
    // inventory. An inventory that fails to parse, or a schema change that
    // renames `enabled`, would otherwise turn this file green while checking
    // nothing.
    expect(entries().length, "no entries parsed from the inventory").toBeGreaterThan(10);
    expect(declaredEnabled().length, "no entry is declared enabled").toBeGreaterThan(10);
    expect(
      entries().filter(h => h.command).length,
      "no entry carries a command",
    ).toBeGreaterThan(10);
  });
});

describe("#199: the registration reconciliation is able to fail", () => {
  /**
   * Proved against planted settings documents, not against this machine.
   *
   * This is the logic the issue asks for; what it cannot be is a live CI
   * assertion, for the reason in the file docblock. Proving it here means that
   * when registration does become repo-owned — or when someone runs it as a
   * local diagnostic — the reconciliation is known to work rather than assumed
   * to.
   */
  const SETTINGS_WITH = ['{"hooks":{"PreToolUse":[{"command":"bun Alpha.hook.ts"}]}}'];
  const SETTINGS_WITHOUT = ['{"hooks":{"PreToolUse":[{"command":"bun Other.hook.ts"}]}}'];

  test("a declared hook absent from the settings is reported", () => {
    expect(inertHookViolations(["Alpha"], SETTINGS_WITHOUT)).toEqual(["Alpha"]);
  });

  test("the same hook present in the settings is not reported", () => {
    // The converse. Without it, a reconciliation that reports everything
    // satisfies the case above.
    expect(inertHookViolations(["Alpha"], SETTINGS_WITH)).toEqual([]);
  });

  test("registration in ANY supplied scope counts, not just the first", () => {
    // A reconciler that read one document would report a hook registered only
    // in project settings as missing — the bug the multi-scope signature
    // exists to prevent.
    expect(inertHookViolations(["Alpha"], [...SETTINGS_WITHOUT, ...SETTINGS_WITH])).toEqual([]);
  });

  test("no settings documents at all means everything is unregistered, not everything fine", () => {
    // Fail-closed. An empty document set is what CI sees, and reading it as
    // "nothing to report" is the fail-open that would have hidden the issue
    // in the first place.
    expect(inertHookViolations(["Alpha", "Beta"], [])).toEqual(["Alpha", "Beta"]);
  });

  test("the extractor matches a real settings command line, not just the fixtures", () => {
    // The fixtures are hand-written, so on their own they prove the function
    // can parse strings this test chose. This runs it over the shape the repo
    // actually ships.
    const repoSettings = join(ROOT, ".claude", "settings.json");
    expect(existsSync(repoSettings), "the repo has no .claude/settings.json to read").toBe(true);
    const found = registeredIn([readFileSync(repoSettings, "utf-8")]);
    expect(found.size, "no hook names extracted from the repo's own settings").toBeGreaterThan(0);
  });
});
