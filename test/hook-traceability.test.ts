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
import { commandNamesHook, executedHookFile } from "../lib/hook-trees";
import { remedyMessage } from "../lib/check-remedy";

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
 * The hook file a row or a registry entry MENTIONS — ONE binding for that
 * question, so there is one thing to mutate and the agreement cannot hold up
 * on whichever copy was not broken.
 *
 * Deliberately NOT `commandNamesHook`. Its population includes markdown rows
 * from the spec's current-state table, which are not commands and which no
 * argv parse can read. The question here is *which hook file does this line
 * mention*; the question `lib/hook-trees.ts` answers is *which hook file does
 * this command EXECUTE*. Two questions, two bindings — not the fourth shape.
 *
 * **Nothing decides REGISTRATION from this.** That goes through
 * `commandNamesHook` everywhere, which is the whole point of #976.
 */
function namedHookFile(text: unknown): string | null {
  return String(text).match(/([A-Za-z0-9_-]+\.hook\.ts)/)?.[1] ?? null;
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
  //
  // `executedHookFile`, NOT `namedHookFile`. This population is COMMANDS, so
  // the question is the registration one and it goes through the one parse
  // that answers it. `namedHookFile`'s unanchored match was reported by the
  // fifth review and it was right about this call site: a registry command
  // reading `bun run x.ts # Foo.hook.ts` would have contributed `Foo` to the
  // repo's own inventory of registered hooks.
  //
  // The OTHER call site keeps `namedHookFile` and that is not an oversight —
  // see its docblock. Spec-table rows are markdown, not commands, and no
  // argv parse can read them. Two questions, two bindings; the defect was
  // that one call site was on the wrong side of the line.
  //
  // A command this parse refuses contributes nothing, which errs toward
  // reporting a registered hook as absent — the loud direction, and the one
  // AC-4/AC-4b turn red. Measured: 0 of 19 registry commands carry a flag or
  // any other spelling this refuses, so the list is unchanged today.
  const parsed = registryCommands()
    .map(executedHookFile)
    .filter((h): h is string => h !== null);
  expect(
    parsed.length,
    "the parse read no hook out of any registry command, so every comparison " +
      "below would be against an empty list — which agrees with anything",
  ).toBeGreaterThan(0);
  return parsed;
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

/**
 * #1047 — the package shipped no hooks at all, and the thing that let it was
 * not the missing `files[]` entry.
 *
 * Measured on `origin/main` before this change: `hooks/` absent from
 * `package.json` `files[]`, and **0 of 20** registry entries setting
 * `deployToConsumers`. SC-472's deployment path was built, wired into three
 * scaffold modules, and reached zero hooks on every run — reporting success,
 * because a scaffold that deploys no hooks is byte-identical to a correct run
 * on a project that wanted none.
 *
 * **The cheapest wrong fix is adding `hooks/` to `files[]` and stopping.**
 * The tarball grows, `CLOSURE-1` stays green — it asks whether imports
 * resolve, never whether anything runs — and every consumer still installs
 * zero hooks, now with the manifest saying otherwise. AC-10 below is the case
 * that fix does not pass: it reds on all twenty entries under it, because
 * packaging a directory is not deciding what travels out of it.
 *
 * The field is required rather than optional for the reason `scope` is
 * (#479): an optional field makes "decided no" and "nobody looked" one value.
 */
describe("#1047: every hook declares whether a consumer receives it", () => {
  const entries = (loadRungateConfig(HARNESS_ROOT) as { hooks: any[] }).hooks;
  const packaged: string[] = JSON.parse(
    readFileSync(join(HARNESS_ROOT, "package.json"), "utf-8"),
  ).files;

  test("AC-10: the population is non-empty", () => {
    // The anchor, for the same reason AC-1 has one. Three equalities against
    // an empty list all pass, and a registry read that silently returned
    // nothing would take every case below with it (#621).
    expect(entries.length, "no registry entries were read at all").toBeGreaterThan(0);
  });

  test("AC-11: no entry leaves deployToConsumers unset", () => {
    const silent = entries
      .filter(h => typeof h?.deployToConsumers !== "boolean")
      .map(h => h?.name ?? JSON.stringify(h));
    expect(
      silent,
      remedyMessage({
        root: HARNESS_ROOT,
        check: "#1047 AC-11",
        violations: silent,
        fix:
          "set `deployToConsumers: true` in .claude/rungate/hooks.json if a scaffolded " +
          "consumer should receive this hook, or `false` with a `notDeployedReason` " +
          "saying whether it is harness-only or opt-in. Absent is not an answer: " +
          "deployHooksToConsumers reads it with `!== true`, so an omission deploys " +
          "nothing and says nothing.",
      }),
    ).toEqual([]);
  });

  test("AC-12: a hook that does not travel says why", () => {
    // Mirrors `disabledReason` (#479 SC-1662), and for the identical reason:
    // false-because-decided and false-because-nobody-looked are the same
    // byte. The reason is also where harness-only and opt-in are told apart,
    // which `deployToConsumers` alone cannot carry.
    const bare = entries
      .filter(h => h?.deployToConsumers === false)
      .filter(h => typeof h?.notDeployedReason !== "string" || h.notDeployedReason.trim().length < 40)
      .map(h => h?.name ?? JSON.stringify(h));
    expect(
      bare,
      remedyMessage({
        root: HARNESS_ROOT,
        check: "#1047 AC-12",
        violations: bare,
        fix:
          "add a `notDeployedReason` of at least 40 characters saying whether this hook " +
          "is HARNESS-ONLY (about this repository's own checkout, worktree pool or " +
          "swarm) or OPT-IN (ships in the tarball, registered once the consumer has the " +
          "thing it guards).",
      }),
    ).toEqual([]);
  });

  test("AC-13: a hook marked for consumers is actually in the tarball", () => {
    // The half that makes AC-11 more than bookkeeping. A registry entry can
    // claim `deployToConsumers: true` while `files[]` publishes neither the
    // hook nor the directory holding it, and the deployment would then write
    // a settings.local.json command pointing at a path the consumer does not
    // have — a hook that fails at hook time rather than one that is absent.
    //
    // Checked against `files[]` rather than against disk: the hook file is on
    // disk in this checkout whatever the manifest says, so disk is the
    // artifact that always agrees (#530) and the manifest is the statement.
    const unpublished = entries
      .filter(h => h?.deployToConsumers === true)
      .map(h => ({ name: h.name, file: `hooks/${h.name}.hook.ts` }))
      .filter(({ file }) => !packaged.some(f => f === file || (f.endsWith("/") && file.startsWith(f))))
      .map(({ name, file }) => `${name} (${file})`);
    expect(
      unpublished,
      remedyMessage({
        root: HARNESS_ROOT,
        check: "#1047 AC-13",
        violations: unpublished,
        fix:
          "add `hooks/` to `files[]` in package.json, or clear `deployToConsumers` on " +
          "the entry. Deploying a hook the tarball omits writes a consumer a command " +
          "that ENOENTs on every invocation.",
      }),
    ).toEqual([]);
  });

  /**
   * The regression test for the way AC-11 was sincerely wrong (#1047 review).
   *
   * `StaleTTLCleanup` was classified SHIP by reading its header — "Cleans up
   * stale workflow-state.json and ship-active files" — and its first screen,
   * which imports `cleanStaleFiles`. Sixty lines down, behind
   * `await import('../lib/branch-cleanup.ts')`, it runs
   * `git push origin --delete` per stale branch at every SessionStart, gated
   * by an open-PR check whose slug defaults to THIS repository, so on a
   * consumer the guard asks about the wrong repo and can never say stop.
   *
   * AC-11 through AC-14 cannot see that: they check that somebody WROTE an
   * answer, never that the answer is true. This one reads the code the hook
   * reaches. It is deliberately narrow — remote-destructive git only, the
   * class that cost somebody else's branches — because a broad "is this
   * dangerous" scan would be noise, and noise is how the next real one gets
   * waved through.
   */
  test("AC-15: no hook marked for consumers reaches a remote-destructive git call", () => {
    // `push --delete`, `branch -D`, `reset --hard`, `clean -fd`, spelled as
    // the argv arrays this tree actually uses.
    const DESTRUCTIVE =
      /"--delete"|'--delete'|"-D"\s*,|'-D'\s*,|"--hard"|'--hard'|"clean"\s*,\s*"-|'clean'\s*,\s*'-/;

    const seen = new Set<string>();
    /** Every repo-relative module a file reaches, static or `await import`. */
    function reach(relPath: string, depth: number): string[] {
      if (depth === 0 || seen.has(relPath)) return [];
      seen.add(relPath);
      const abs = join(HARNESS_ROOT, relPath);
      if (!existsSync(abs)) return [];
      const src = readFileSync(abs, "utf-8");
      const out = [relPath];
      // Both syntaxes. The defect lived in the second one, and a scan that
      // knew only `import … from` would have reported this hook clean —
      // which is #484's lesson arriving in a new file.
      for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
        const spec = m[1].replace(/\.ts$/, "");
        const base = relPath.slice(0, relPath.lastIndexOf("/"));
        const resolved = resolve("/" + base, spec).slice(1);
        for (const cand of [`${resolved}.ts`, `${resolved}/index.ts`]) {
          if (existsSync(join(HARNESS_ROOT, cand))) out.push(...reach(cand, depth - 1));
        }
      }
      return out;
    }

    const offenders: string[] = [];
    for (const h of entries.filter(e => e?.deployToConsumers === true)) {
      seen.clear();
      for (const mod of reach(`hooks/${h.name}.hook.ts`, 4)) {
        if (DESTRUCTIVE.test(readFileSync(join(HARNESS_ROOT, mod), "utf-8"))) {
          offenders.push(`${h.name} reaches ${mod}`);
        }
      }
    }
    expect(
      offenders,
      remedyMessage({
        root: HARNESS_ROOT,
        check: "#1047 AC-15",
        violations: offenders,
        fix:
          "set `deployToConsumers: false` with a notDeployedReason naming the destructive " +
          "call, or move the destructive arm behind explicit arming the way " +
          "lib/orphan-reaper.ts does with armedFromEnv. A consumer must not receive a hook " +
          "that deletes their branches because our header said it tidied files.",
      }),
    ).toEqual([]);

    // The population is currently empty, which is the third shape — so the
    // walk and the pattern are driven over the real offender directly. If
    // either broke, this is where it shows, not in a clean census above.
    seen.clear();
    const stale = reach("hooks/StaleTTLCleanup.hook.ts", 4);
    expect(stale, "the walk must follow `await import`").toContain("lib/branch-cleanup.ts");
    expect(DESTRUCTIVE.test(readFileSync(join(HARNESS_ROOT, "lib/branch-cleanup.ts"), "utf-8")))
      .toBe(true);
    // And that it is held back, which is the fact the walk exists to protect.
    expect(entries.find(e => e?.name === "StaleTTLCleanup")?.deployToConsumers).toBe(false);
    // A negative control: a hook that ships must NOT trip the pattern, or
    // the check is matching everything and witnessing nothing.
    seen.clear();
    const benign = reach("hooks/WorkflowStateGuard.hook.ts", 4);
    expect(benign.some(m => DESTRUCTIVE.test(readFileSync(join(HARNESS_ROOT, m), "utf-8")))).toBe(false);
  });

  test("AC-14: the three verdicts are each reachable, and the predicate separates them", () => {
    // AC-11 through AC-13 are equalities against `[]` over a tree that is
    // currently clean, so each runs its filter and finds nothing — the third
    // shape in `.claude/rules/checks-must-be-able-to-fail.md`. The classifier
    // is therefore driven over inputs of all three kinds directly, so a
    // predicate that collapsed to `false` would be caught here rather than
    // reported as a clean census.
    const probe = (h: any) => ({
      unset: typeof h?.deployToConsumers !== "boolean",
      bare:
        h?.deployToConsumers === false &&
        (typeof h?.notDeployedReason !== "string" || h.notDeployedReason.trim().length < 40),
    });
    const reason = "x".repeat(40);
    expect(probe({ name: "A" })).toEqual({ unset: true, bare: false });
    expect(probe({ name: "B", deployToConsumers: false })).toEqual({ unset: false, bare: true });
    expect(probe({ name: "C", deployToConsumers: false, notDeployedReason: "too short" }))
      .toEqual({ unset: false, bare: true });
    expect(probe({ name: "D", deployToConsumers: false, notDeployedReason: reason }))
      .toEqual({ unset: false, bare: false });
    expect(probe({ name: "E", deployToConsumers: true })).toEqual({ unset: false, bare: false });

    // And that the live tree holds both answers rather than one. A registry
    // where every entry deploys would pass AC-12 having classified nothing.
    const deploys = entries.filter(h => h?.deployToConsumers === true).length;
    const held = entries.filter(h => h?.deployToConsumers === false).length;
    expect(deploys, "no hook ships to a consumer — the classification is one-sided").toBeGreaterThan(0);
    expect(held, "no hook is held back — the classification is one-sided").toBeGreaterThan(0);
    expect(deploys + held).toBe(entries.length);
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

describe("#976 review 5: the two name-extractors answer different questions", () => {
  test("AC-9: a hook name in a non-executing position is a MENTION, not a registration", () => {
    // `registryHooks` was rewired from `namedHookFile` to `executedHookFile`
    // because its population is COMMANDS. Reverting that is **0 red** over
    // this file — measured, in both the real and the CI environment — and
    // that zero is a fact about the live registry, not about the change:
    // all 19 of its commands are `bun ${VAR}/X.hook.ts`, on which the two
    // bindings agree, so no live input can tell them apart.
    //
    // Per `.claude/rules/checks-must-be-able-to-fail.md`, a zero needs an
    // input on which mutant and original differ before it means anything.
    // Here is that input, asserted rather than described, so the split is a
    // boundary a reader can see instead of a silent 0 in a battery table.
    const mention = "bun run x.ts # IssueCloseGuard.hook.ts";
    expect(
      namedHookFile(mention),
      "namedHookFile answers 'which hook does this line MENTION' — correct for " +
        "the spec's markdown table, and wrong for a command",
    ).toBe("IssueCloseGuard.hook.ts");
    expect(
      executedHookFile(mention),
      "executedHookFile answers 'which hook does this command EXECUTE' — the " +
        "registration question, and the only one registryHooks may ask",
    ).toBeNull();

    // And the spec-table row, which is why `namedHookFile` is kept rather
    // than collapsed into one binding: no argv parse can read markdown.
    const row = "| `IssueCloseGuard.hook.ts` | PreToolUse | thin trigger |";
    expect(namedHookFile(row)).toBe("IssueCloseGuard.hook.ts");
    expect(executedHookFile(row)).toBeNull();
  });
});
