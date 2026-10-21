import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { loadRungateConfig } from "../lib/config-loader";
import {
  hookRegistration,
  readRegistrationScopes,
  registrationCensus,
  settingsScopePaths,
  unplacedHooks,
  type HookRegistration,
  type ScopeReading,
} from "../lib/hook-scopes";
import { commandNamesHook, hookFilesNamedBy } from "../lib/hook-trees";

const HARNESS_ROOT = resolve(import.meta.dir, "..");

/**
 * #898 — five `at least 14` floors stood in for one agreement between four
 * positions, and a floor cannot witness an addition.
 *
 * Measured as #879's battery row M10: deleting the newly added `HookCurrency`
 * row from the spec table was **0 red across 92 tests**, while the same hook's
 * `.claude/settings.json`, `.claude/rungate/hooks.json` and hook-file-comment
 * positions were each 1 red. Three of Tier 2's four positions were enforced
 * generally; the fourth was enforced only for whichever fourteen hooks existed
 * when the number was written.
 *
 * What the census found the moment it was pointed at the real populations
 * (2026-10-21), none of which any floor could see:
 *
 *   19 hook files on disk
 *   17 registry entries   — ProjectStateSync and TestSuiteRelease are in NO registry
 *   17 spec table rows    — BashToolGuard and ProjectStateSync have no row
 *   16 monolith entries   — which is what this file USED to read, one release stale
 *
 * That last line is its own defect and is why the registry reading now goes
 * through `loadRungateConfig` (`.claude/rules/config-access.md`: never read
 * only `.claude/rungate.json`). This file hardcoded the monolith, so #879's
 * hook was invisible to it — the floor was green over a population that did
 * not contain the thing most recently added to the repo.
 *
 * ## The census's own blind spot, found by #910 and fixed here
 *
 * The line above — *"ProjectStateSync and TestSuiteRelease are in NO
 * registry"* — is correct about this repository and was read as a claim about
 * every scope. Both are registered in `~/.claude/settings.json`, and have
 * been throughout; measured 2026-10-21 by parsing it rather than grepping.
 * The repo's own `test/test-suite-guard-registration.test.ts` has asserted
 * that about `TestSuiteRelease` since #67-A and was green the whole time.
 *
 * Two hook files were given unregistered declarations on the strength of that
 * reading, and **AC-5 could not catch them, because it read the same single
 * scope that produced the error.** A guard whose blind spot is identical to
 * the blind spot of the thing it guards is
 * `.claude/rules/checks-must-be-able-to-fail.md`'s fourth shape with the
 * second decider removed — both agree, and neither can be wrong in a way the
 * other notices.
 *
 * So AC-4 and AC-5 now go through `lib/hook-scopes.ts`, which REFUSES to
 * return a verdict from a reading short of every scope. The consequence that
 * matters: **no reading this file can take produces `unregistered` unless
 * every scope was read**, so the conclusion #898 drew is not available to it
 * any more. A scope that cannot be read — `~/.claude/settings.json` on a
 * runner — makes the verdict `unmeasured`, which AC-7 reports and which is
 * never clean.
 */

/** The declaration. Everything else is a position that must agree with it. */
const HOOK_FILES = readdirSync(join(HARNESS_ROOT, "hooks"))
  .filter(f => f.endsWith(".hook.ts"))
  .sort();

/**
 * The hook file a row or a registry entry names — ONE binding, so there is one
 * thing to mutate. A second extractor would survive any mutation of the first
 * and the agreement would hold up on whichever copy was not broken.
 */
function namedHookFile(text: unknown): string | null {
  // Delegates to , which tokenises and basenames rather
  // than matching a substring anywhere in the string. A second extractor
  // would survive any mutation of the first (#970 review, finding 3).
  return hookFilesNamedBy(String(text))[0] ?? null;
}

/**
 * A hook that is deliberately not registered says so IN ITS OWN HEADER.
 *
 * Caller-owned on purpose. A central allowlist of exempt files becomes
 * evidence those files are referenced, and then the orphan checks that read
 * references go green because of the exemption list itself — this repo has
 * been bitten by that shape, so the declaration lives with the thing it is
 * about and travels when the file moves.
 */
const UNREGISTERED_MARKER = "NOT REGISTERED";

/**
 * The declaration line in a hook's SOURCE. Pure, so AC-6's predicate stays
 * provable when the tree carries no declaration at all — which is the state
 * #910 left it in, and a `continue` over an empty population is an assertion
 * that holds vacuously.
 */
export function unregisteredDeclarationIn(content: string): string | null {
  const line = content.split("\n").find(l => l.includes(UNREGISTERED_MARKER));
  return line ? line.trim() : null;
}

/** A declaration with fewer than 20 letters of reason beside the marker. */
export function declarationLacksReason(line: string): boolean {
  return line.replace(UNREGISTERED_MARKER, "").replace(/[^A-Za-z]/g, "").length <= 20;
}

const unregisteredDeclaration = (file: string): string | null =>
  unregisteredDeclarationIn(readFileSync(join(HARNESS_ROOT, "hooks", file), "utf-8"));

/**
 * Every scope that can register a hook, read for real, with the ones that are
 * not on this machine NAMED rather than dropped.
 *
 * The scope list and the assembly are `lib/hook-scopes.ts`'s, not this
 * file's: a census with its own idea of which scopes exist is how #898 came
 * to read one.
 */
function liveScopeReadings(): ScopeReading[] {
  return readRegistrationScopes(HARNESS_ROOT, homedir(), readIfPresent, registryCommands());
}

/** `readFileSync`, with an absent file reported as `null` rather than `""`. */
function readIfPresent(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

/** The census over every hook file on disk. */
function liveCensus(): HookRegistration[] {
  return registrationCensus(
    HOOK_FILES.map(f => f.replace(/\.hook\.ts$/, "")),
    liveScopeReadings(),
  );
}

describe("#898: the four hook positions agree, named rather than counted", () => {
  test("AC-1: the declaration is non-empty", () => {
    // The anchor. Every agreement below is an equality against this list, and
    // two empty sets are perfectly equal — if the directory read silently
    // returned nothing, every other case here would pass having compared
    // nothing to nothing (#621).
    expect(HOOK_FILES.length, "no hook files were read at all").toBeGreaterThan(0);
  });

  test("AC-2: every hook file has a spec table row, and every row a file", () => {
    // The two directions are one claim and are asserted as one: a floor could
    // not see an addition, and it could not see a DELETION either — a hook
    // removed from `hooks/` leaves a stale row and the count still clears.
    expect(specTableHooks().sort()).toEqual(HOOK_FILES);
  });

  test("AC-3: every registry entry names a hook file that exists", () => {
    const missing = registryHooks().filter(h => !HOOK_FILES.includes(h));
    expect(missing, "the registry names hooks that are not on disk").toEqual([]);
  });

  test("AC-4: every hook file is registered, or says why it is not", () => {
    // NOT a count and NOT an allowlist. Registering a hook makes it RUN, so
    // which hooks should be registered is a behavioural decision this census
    // does not get to make — what it can refuse is a hook being absent from
    // every registry with nobody having said so.
    //
    // Over EVERY scope since #910. The repo-registry-only version of this
    // reported two hooks unregistered that were registered in user settings,
    // and the verdict `unregistered` is now unavailable unless every scope
    // was in fact read.
    //
    // This arm is live only where every scope is readable, which is NOT a
    // runner. AC-4b is the half that holds there, and it is the half with a
    // failing input in the configuration CI actually runs in.
    const silent = liveCensus()
      .filter(c => c.verdict === "unregistered")
      .map(c => `${c.hook}.hook.ts`)
      .filter(f => !unregisteredDeclaration(f));
    expect(
      silent,
      `unregistered in EVERY settings scope and undeclared — register it, or write a ` +
        `"${UNREGISTERED_MARKER}" line in its header saying why not`,
    ).toEqual([]);
  });

  test("AC-4b: every hook file is PLACED by something the repo owns", () => {
    // The CI-enforceable half, and the reason it exists.
    //
    // AC-4 above went fail-open on a runner and the first draft of #910
    // shipped it that way. `~/.claude/settings.json` is absent there, so the
    // machine scopes are UNMEASURED, so nothing is ever `unregistered`, so
    // `silent` is empty and the guard passes having witnessed nothing.
    // Measured with one input — a hook file registered in no scope at all —
    // run twice, differing only in `HOME`:
    //
    //   real HOME (every scope readable):   AC-4  0 pass, 1 fail
    //   HOME=$(mktemp -d) (the CI config):  AC-4  1 pass, 0 fail
    //
    // Absence must never read as clean (#921). So this arm asks a question
    // the runner CAN answer: not "is it registered", which is machine state,
    // but **"does anything the repo owns say where this hook lives?"** All
    // three repo-owned scopes are committed, so this holds everywhere.
    //
    // Three ways to satisfy it, and a hook may take any one:
    //   1. a repo-owned scope registers it;
    //   2. the registry declares `scope: "user"` — the repo asserting it is
    //      machine state, which AC-7 then reports UNMEASURED; or
    //   3. its header declares why it is registered nowhere.
    //
    // NOT a second decider for `reconcile` in
    // `test/hook-registration-reconciler.test.ts`. That enforces a declared
    // project-scoped ENTRY against `.claude/settings.json`; its population is
    // registry entries. This population is hook FILES, and the input only
    // this arm can reach is a file with no registry entry at all — which is
    // invisible to `reconcile` and is exactly the state `ProjectStateSync`
    // and `TestSuiteRelease` were in when #898 declared them unregistered.
    const repoOwned = new Set(
      settingsScopePaths(HARNESS_ROOT, homedir())
        .filter(s => s.ownership === "repo")
        .map(s => s.scope),
    );
    repoOwned.add("repo-registry");

    const readings = liveScopeReadings().filter(r => repoOwned.has(r.scope));
    expect(
      readings.length,
      "no repo-owned scope was read, so this arm compared nothing",
    ).toBe(repoOwned.size);
    expect(
      readings.every(r => r.commands !== null),
      "a repo-owned scope read as unreadable — it is committed, so this is not an absence",
    ).toBe(true);

    const declaredUserScope = new Set(
      registryEntries()
        .filter(e => e.scope === "user")
        .map(e => e.name),
    );

    const unplaced = unplacedHooks({
      hooks: HOOK_FILES.map(f => f.replace(/\.hook\.ts$/, "")),
      repoReadings: readings,
      declaredUnregistered: HOOK_FILES.filter(unregisteredDeclaration).map(f =>
        f.replace(/\.hook\.ts$/, ""),
      ),
    }).map(h => `${h}.hook.ts`);

    expect(
      unplaced,
      `nothing the repo owns says where these hooks live. On a runner the machine scopes ` +
        `cannot be read, so "registered in user settings" and "registered nowhere" are the same ` +
        `observation — the repo has to state which it is. Register it in .claude/settings.json, ` +
        `or declare it in .claude/rungate/hooks.json with scope "user", or write a ` +
        `"${UNREGISTERED_MARKER}" line in its header: ${unplaced.join(", ")}`,
    ).toEqual([]);
  });

  test("AC-5: a registered hook does not also declare itself unregistered", () => {
    // The mirror, and the thing that stops AC-4's declaration becoming a
    // permanent waiver: once a hook IS registered its declaration is stale,
    // and a stale declaration would keep satisfying AC-4 if it were ever
    // deregistered again, which is the state AC-4 exists to catch.
    //
    // This is the case #910 proved could not fire. It read the repo registry
    // alone, so a hook registered in user settings looked unregistered to it
    // and its declaration looked current. Over the complete reading, the two
    // declarations #898 wrote are contradictions and this goes red.
    const contradictory = liveCensus()
      .filter(c => c.verdict === "registered")
      .map(c => ({ file: `${c.hook}.hook.ts`, where: c.registeredIn.join(", ") }))
      .filter(({ file }) => unregisteredDeclaration(file))
      .map(({ file, where }) => `${file} (registered in ${where})`);
    expect(
      contradictory,
      "a registered hook still carries its unregistered declaration",
    ).toEqual([]);
  });

  test("AC-6: each declaration gives a reason, not just the marker", () => {
    // A bare marker is a waiver nobody has to justify, which is a warning
    // nobody reads. The same rule `verify-merge-content` applies to `--accept`.
    for (const file of HOOK_FILES) {
      const line = unregisteredDeclaration(file);
      if (!line) continue;
      expect(declarationLacksReason(line), `${file} declares itself unregistered with no reason`).toBe(
        false,
      );
    }

    // The tree carries no declaration today, so the loop above runs zero
    // times and asserts nothing. A predicate proved only by a population that
    // may be empty is `.claude/rules/checks-must-be-able-to-fail.md`'s third
    // shape, so the predicate is driven over both answers directly.
    expect(declarationLacksReason(` * ${UNREGISTERED_MARKER}`)).toBe(true);
    expect(
      declarationLacksReason(
        ` * ${UNREGISTERED_MARKER} — see #910, pending a decision about the blast radius`,
      ),
    ).toBe(false);
    expect(unregisteredDeclarationIn("a\n * x NOT REGISTERED y\nb")).toBe("* x NOT REGISTERED y");
    expect(unregisteredDeclarationIn("nothing to see here")).toBeNull();
  });

  test("AC-7: a hook the repo cannot place is UNMEASURED and named, never clean", () => {
    // `0`, `{}`, `null`, `SKIP` and a skipped test are indistinguishable from
    // success; a reading is not (`.claude/rules/config-access.md`). On a
    // runner `~/.claude/settings.json` does not exist, so every hook
    // registered only there lands here — and this case asserts the refusal
    // fired rather than letting CI pass over the subject.
    const readings = liveScopeReadings();
    const census = liveCensus();

    expect(
      census.map(c => c.hook).sort(),
      "the census did not answer for every hook file on disk",
    ).toEqual(HOOK_FILES.map(f => f.replace(/\.hook\.ts$/, "")).sort());
    expect(
      readings.filter(r => r.commands !== null).length,
      "no scope was readable at all, so this census compared nothing",
    ).toBeGreaterThan(0);

    const unreadable = readings.filter(r => r.commands === null).map(r => r.scope);
    const unmeasured = census.filter(c => c.verdict === "unmeasured");

    if (unreadable.length === 0) {
      expect(
        unmeasured,
        "every scope was readable, so nothing can be UNMEASURED",
      ).toEqual([]);
      return;
    }
    for (const c of unmeasured) {
      expect(
        c.detail,
        `${c.hook} is UNMEASURED and the reading does not say an absence here is not an absence`,
      ).toContain('not "not registered"');
      expect(c.unreadable).toEqual(unreadable);
    }
  });

  test("AC-8: this census cannot conclude from one scope", () => {
    // The property, asserted rather than left to the module. A caller that
    // opened one file gets a refusal — which is what #898 and #713 both
    // needed and neither had.
    expect(() =>
      hookRegistration("TestSuiteRelease", [
        { scope: "repo-registry", commands: registryCommands() },
      ]),
    ).toThrow(/every scope/);
  });
});

/** Rows of the spec's current-state table, as the hook files they name. */
function specTableHooks(): string[] {
  const spec = readFileSync(join(HARNESS_ROOT, "specs", "HOOK-ARCHITECTURE-SPEC.md"), "utf-8");
  const rows = spec.split("\n").filter(l => l.startsWith("| ") && l.includes(".hook.ts"));
  // A table that stopped matching is an empty list, and an empty list agrees
  // with nothing — so the reading refuses rather than returning it.
  expect(rows.length, "no rows were read from the spec current-state table").toBeGreaterThan(0);
  return rows.map(namedHookFile).filter((h): h is string => h !== null);
}

/**
 * The registry, through the ONE loader.
 *
 * Never a hardcoded `.claude/rungate.json`: both layouts are supported, this
 * repo is on the directory layout, and the hardcoded read is what made #879's
 * hook invisible here (`.claude/rules/config-access.md`).
 */
interface RegistryEntry { name?: string; scope?: string; command?: string }

function registryEntries(): RegistryEntry[] {
  const hooks = (loadRungateConfig(HARNESS_ROOT) as { hooks: RegistryEntry[] }).hooks;
  expect(hooks.length, "the loader resolved no hook entries at all").toBeGreaterThan(0);
  return hooks;
}

function registryCommands(): string[] {
  const hooks = (loadRungateConfig(HARNESS_ROOT) as { hooks: unknown[] }).hooks;
  expect(hooks.length, "the loader resolved no hook entries at all").toBeGreaterThan(0);
  return hooks.map(h => String((h as any)?.command ?? h));
}

function registryHooks(): string[] {
  // Derived from `registryCommands`, not read a second time: the registry is
  // one of five scopes now, and two readers of it would disagree the first
  // time either changed.
  return registryCommands().map(namedHookFile).filter((h): h is string => h !== null);
}

describe("Hook SC Traceability (SC-370)", () => {
  const hooksDir = join(HARNESS_ROOT, "hooks");
  const hookFiles = HOOK_FILES;

  for (const file of hookFiles) {
    test(`${file} contains SC- reference`, () => {
      const content = readFileSync(join(hooksDir, file), "utf-8");
      const hasSC = /SC-\d+/.test(content);
      expect(hasSC).toBe(true);
    });
  }
});

describe("Hook config in the resolved registry (SC-391, SC-392)", () => {
  // Through the loader, not a hardcoded path — see registryHooks above.
  const entries = (loadRungateConfig(HARNESS_ROOT) as { hooks: any[] }).hooks;

  test("the registry resolves a hooks array", () => {
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length, "no hook entries resolved").toBeGreaterThan(0);
  });

  test("EVERY hook entry has hookFor and command fields (SC-391)", () => {
    // `>= 14` of N passes while N-14 entries are malformed. The claim was
    // always "every", so it is asserted as every, and the failure NAMES the
    // entries rather than reporting that a count was short.
    const bad = entries.filter(h => !h?.hookFor || !h?.command).map(h => h?.name ?? JSON.stringify(h));
    expect(bad, "hook entries missing hookFor or command").toEqual([]);
  });

  test("EVERY hook entry has an enabled field (SC-392)", () => {
    const bad = entries.filter(h => !(h && "enabled" in h)).map(h => h?.name ?? JSON.stringify(h));
    expect(bad, "hook entries missing enabled").toEqual([]);
  });
});

describe("HOOK-ARCHITECTURE-SPEC current state table (SC-370)", () => {
  const specPath = join(HARNESS_ROOT, "specs", "HOOK-ARCHITECTURE-SPEC.md");
  const specContent = readFileSync(specPath, "utf-8");

  const tableLines = specContent
    .split("\n")
    .filter(line => line.startsWith("| ") && line.includes(".hook.ts"));

  // The count floor that used to live here is gone: AC-2 above asserts the
  // table names exactly the hooks on disk, which is the agreement the floor
  // was standing in for and is the thing a floor structurally cannot check.

  test("every hook row in spec table has an SC reference", () => {
    expect(tableLines.length, "no table rows were read").toBeGreaterThan(0);
    for (const line of tableLines) {
      expect(line).toMatch(/SC-\d+/);
    }
  });
});

describe("Hook line count limits (SC-367, SC-371)", () => {
  const hooksDir = join(HARNESS_ROOT, "hooks");

  test("AgentBriefGuard.hook.ts is under 50 lines (SC-367)", () => {
    const content = readFileSync(join(hooksDir, "AgentBriefGuard.hook.ts"), "utf-8");
    const lineCount = content.split("\n").length;
    expect(lineCount).toBeLessThan(50);
  });

  test("no hook file exceeds 150 lines (SC-371)", () => {
    const hookFiles = readdirSync(hooksDir).filter(f => f.endsWith(".hook.ts"));
    for (const file of hookFiles) {
      const content = readFileSync(join(hooksDir, file), "utf-8");
      const lineCount = content.split("\n").length;
      expect(lineCount).toBeLessThanOrEqual(150);
    }
  });
});
