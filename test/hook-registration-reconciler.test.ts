import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { buildDefaultHooks } from "../lib/scaffold/defaults";

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
 *
 * ## What #479 added, and why the paragraph above is only half right
 *
 * "Registration is machine state" is true of the eleven hooks registered in
 * `~/.claude/settings.json`. It is not true of all sixteen, and reading it as
 * though it were is what left the five still inert four weeks later.
 *
 * Every one of the five acts on the CURRENT PROJECT — this project's agent
 * spawns, this project's `specs/*.md`, this project's `workflow-state.json`,
 * `runAllCompletionChecks(process.cwd())`. None is machine-wide, so SC-518
 * does not reach them, and project `.claude/settings.json` is a file the repo
 * owns and commits. For a project-scoped hook, "is it registered" is a fact CI
 * can check.
 *
 * What the inventory never said is which kind an entry is. With a `scope` on
 * each entry the reconciliation splits, and each half is honest about what it
 * can see:
 *
 * | scope | what the repo can measure |
 * |---|---|
 * | `project` | registration in `.claude/settings.json` — ENFORCED |
 * | `user` | nothing; `~/.claude/settings.json` is not ours — UNMEASURED |
 *
 * UNMEASURED is reported, not skipped. A user-scoped entry produces a finding
 * every run, because an entry the repo cannot check must not be countable as
 * an entry the repo has checked (`.claude/rules/config-access.md`).
 */

const ROOT = join(import.meta.dir, "..");
const HOOKS_JSON = join(ROOT, ".claude", "rungate", "hooks.json");

interface HookEntry {
  name?: string;
  enabled?: boolean;
  command?: string;
  scope?: string;
  disabledReason?: string;
}

function entries(): HookEntry[] {
  return JSON.parse(readFileSync(HOOKS_JSON, "utf-8")) as HookEntry[];
}

/**
 * Every way an enabled entry can fail to be a running hook, kept apart.
 *
 * Collapsing these into one boolean is the thing #199's SC-651 asked not to
 * happen: "registered, but the path variable is unset" and "registered under a
 * name nothing resolves" and "not registered at all" have three different
 * fixes, and a reconciler that reports one word for all three sends you to the
 * wrong one.
 */
export type FindingKind =
  | "unregistered" // declared enabled, named in no settings document we can read
  | "unresolvable" // registered, but its command names a variable the env lacks
  | "missing-file" // registered and resolved, and the file is not there
  | "no-scope" // the entry does not say which settings scope owns it
  | "dual-scope" // claims user scope and is also registered in the repo's own settings
  | "unmeasured"; // user-scoped: registration is machine state, not ours to read

export interface Finding {
  hook: string;
  kind: FindingKind;
  detail: string;
}

/**
 * Expand `${VAR}` / `$VAR` in a hook command against a supplied environment.
 *
 * Takes the env rather than reading `process.env` for the same reason
 * `registeredIn` takes documents rather than paths: a function that reads
 * ambient state can only be tested against ambient state.
 *
 * Returns the names it could NOT expand rather than leaving them in the
 * string. A half-expanded path is a path that does not exist, and "does not
 * exist" would then be the only thing reported — losing the distinction
 * between a missing file and a missing variable, which is the whole point.
 */
export function resolveCommandPath(
  command: string,
  env: Record<string, string | undefined>,
): { path: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const expanded = command
    .replace(/^bun\s+/, "")
    .trim()
    .replace(/\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g, (_m, braced, bare) => {
      const name = braced ?? bare;
      const value = env[name];
      if (value === undefined) {
        unresolved.push(name);
        return "";
      }
      return value;
    });
  return { path: expanded, unresolved };
}

/**
 * The reconciliation, over documents and an env the caller supplies.
 *
 * Delegates to `registeredIn` and `resolveCommandPath` rather than repeating
 * either. Two functions answering "is this registered" would be behaviourally
 * one function, and no test here could tell which of them was load-bearing —
 * the fourth shape in `.claude/rules/checks-must-be-able-to-fail.md`.
 */
export function reconcile(
  hookEntries: HookEntry[],
  docs: { project: string[]; user: string[] },
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean,
): Finding[] {
  const findings: Finding[] = [];
  const projectNames = registeredIn(docs.project);

  for (const entry of hookEntries) {
    const hook = entry.name ?? "";
    if (!hook || entry.enabled !== true) continue;

    if (entry.scope !== "project" && entry.scope !== "user") {
      findings.push({
        hook,
        kind: "no-scope",
        detail: `declares scope ${JSON.stringify(entry.scope)}, which is neither "project" nor "user"`,
      });
      continue;
    }

    if (entry.scope === "user") {
      // The one thing the repo CAN say about a user-scoped entry: whether it
      // is ALSO registered here. SC-518 says the two scopes are not
      // de-duplicated, so a hook in both fires twice. Half a check is still a
      // check, and this half needs no machine state.
      if (projectNames.has(hook)) {
        findings.push({
          hook,
          kind: "dual-scope",
          detail: "declares user scope and .claude/settings.json registers it too — SC-518 says it will fire twice",
        });
        continue;
      }
      findings.push({
        hook,
        kind: "unmeasured",
        detail: "registered in user settings, which the repo does not own and cannot read in CI",
      });
      continue;
    }

    if (!projectNames.has(hook)) {
      findings.push({
        hook,
        kind: "unregistered",
        detail: "scope is project and .claude/settings.json does not name it",
      });
      continue;
    }

    for (const doc of docs.project) {
      for (const m of doc.matchAll(/"command"\s*:\s*"([^"]*?)"/g)) {
        if (!m[1].includes(`${hook}.hook.ts`)) continue;
        const { path, unresolved } = resolveCommandPath(m[1], env);
        if (unresolved.length > 0) {
          findings.push({
            hook,
            kind: "unresolvable",
            detail: `command names ${unresolved.join(", ")}, absent from the environment`,
          });
        } else if (!exists(path)) {
          findings.push({ hook, kind: "missing-file", detail: `resolved to ${path}, which is not there` });
        }
      }
    }
  }

  return findings;
}

/** Entries that are off and do not say why. */
export function unexplainedDisabled(hookEntries: HookEntry[]): string[] {
  return hookEntries
    .filter(h => h.enabled === false && !(h.disabledReason ?? "").trim())
    .map(h => h.name ?? "(unnamed)");
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

/**
 * #479 — the half #199 left: the inventory says which scope owns each entry,
 * so the project-scoped half becomes a fact CI can check.
 */
describe("#479: scope splits the reconciliation into a measured half and a reported one", () => {
  const PROJECT_DOC = (name: string) =>
    `{"hooks":{"PreToolUse":[{"matcher":"Agent","hooks":[{"type":"command","command":"bun \${CLAUDE_PROJECT_DIR}/hooks/${name}.hook.ts"}]}]}}`;
  const ENV = { CLAUDE_PROJECT_DIR: "/repo" };
  const ALWAYS = () => true;

  test("SC-1658: a project-scoped hook declared enabled and absent from the repo settings is reported", () => {
    const found = reconcile(
      [{ name: "Alpha", enabled: true, scope: "project", command: "bun x/Alpha.hook.ts" }],
      { project: [PROJECT_DOC("Other")], user: [] },
      ENV,
      ALWAYS,
    );
    expect(found).toEqual([
      {
        hook: "Alpha",
        kind: "unregistered",
        detail: "scope is project and .claude/settings.json does not name it",
      },
    ]);
  });

  test("the same hook present in the project settings produces nothing at all", () => {
    // The positive control, and the one that stops every case above being
    // satisfied by a reconciler that reports everything. It is also the only
    // assertion in this describe that can go red if `registeredIn` stops
    // matching — the negative cases would read a broken extractor as a hook
    // that is genuinely missing.
    expect(
      reconcile(
        [{ name: "Alpha", enabled: true, scope: "project", command: "bun x/Alpha.hook.ts" }],
        { project: [PROJECT_DOC("Alpha")], user: [] },
        ENV,
        ALWAYS,
      ),
    ).toEqual([]);
  });

  test("SC-1659: a user-scoped hook is UNMEASURED from the repo - never clean", () => {
    // `0`, `{}`, `null` and `SKIP` are indistinguishable from success;
    // UNMEASURED is not (`.claude/rules/config-access.md`). A user-scoped
    // entry reports on every run even when the hook is in fact registered,
    // because the repo has no way to tell those two apart and saying nothing
    // would claim it could.
    const found = reconcile(
      [{ name: "Alpha", enabled: true, scope: "user", command: "bun x/Alpha.hook.ts" }],
      { project: [], user: [PROJECT_DOC("Alpha")] },
      ENV,
      ALWAYS,
    );
    expect(found.map(f => f.kind)).toEqual(["unmeasured"]);
    expect(found[0].detail).toContain("does not own");
  });

  test("a user-scoped hook the repo ALSO registers is reported, not waved through", () => {
    // The dual registration SC-518 names, and the only half of a user-scoped
    // entry the repo can measure. `.claude/settings.json` registered
    // BashToolGuard alongside `~/.claude/settings.json` until #479, so the
    // guard fired twice on every Bash call.
    const found = reconcile(
      [{ name: "Alpha", enabled: true, scope: "user", command: "bun x/Alpha.hook.ts" }],
      { project: [PROJECT_DOC("Alpha")], user: [] },
      ENV,
      ALWAYS,
    );
    expect(found.map(f => f.kind)).toEqual(["dual-scope"]);
    expect(found[0].detail).toContain("SC-518");
  });

  test("an entry that names no scope is reported rather than defaulted", () => {
    // Defaulting an absent scope to "user" would silently excuse every entry
    // that forgot one, which is how all sixteen came to claim `enabled: true`
    // with five of them inert.
    const found = reconcile(
      [{ name: "Alpha", enabled: true, command: "bun x/Alpha.hook.ts" }],
      { project: [], user: [] },
      ENV,
      ALWAYS,
    );
    expect(found.map(f => f.kind)).toEqual(["no-scope"]);
  });

  test("a disabled entry is reconciled against nothing — off is a state, not a failure", () => {
    expect(
      reconcile(
        [{ name: "Alpha", enabled: false, scope: "project", command: "bun x/Alpha.hook.ts" }],
        { project: [], user: [] },
        ENV,
        ALWAYS,
      ),
    ).toEqual([]);
  });
});

describe("#479: three ways to not be running, told apart", () => {
  const REGISTERED = (cmd: string) => `{"hooks":{"PreToolUse":[{"hooks":[{"command":"${cmd}"}]}]}}`;
  const ENTRY = [{ name: "Alpha", enabled: true, scope: "project", command: "bun x/Alpha.hook.ts" }];

  test("SC-1660: registered but unresolvable is a different finding from unregistered", () => {
    // #199's SC-651 in one assertion. All three arms run through the same
    // reconciler over the same entry, so none of them can be passing because
    // the entry never reached the check.
    const unregistered = reconcile(ENTRY, { project: [], user: [] }, {}, () => true);
    const unresolvable = reconcile(
      ENTRY,
      { project: [REGISTERED("bun ${RUNGATE_HOOKS_DIR}/Alpha.hook.ts")], user: [] },
      {},
      () => true,
    );
    const missingFile = reconcile(
      ENTRY,
      { project: [REGISTERED("bun ${RUNGATE_HOOKS_DIR}/Alpha.hook.ts")], user: [] },
      { RUNGATE_HOOKS_DIR: "/nowhere" },
      () => false,
    );

    expect(unregistered.map(f => f.kind)).toEqual(["unregistered"]);
    expect(unresolvable.map(f => f.kind)).toEqual(["unresolvable"]);
    expect(missingFile.map(f => f.kind)).toEqual(["missing-file"]);

    // Named, not merely counted: "something is wrong with Alpha" sends you to
    // the wrong fix twice out of three times.
    expect(unresolvable[0].detail).toContain("RUNGATE_HOOKS_DIR");
    expect(missingFile[0].detail).toContain("/nowhere");
  });

  test("a resolvable command pointing at a file that is there is clean", () => {
    // The fourth arm, and the positive control for the three above.
    expect(
      reconcile(
        ENTRY,
        { project: [REGISTERED("bun ${RUNGATE_HOOKS_DIR}/Alpha.hook.ts")], user: [] },
        { RUNGATE_HOOKS_DIR: "/somewhere" },
        p => p === "/somewhere/Alpha.hook.ts",
      ),
    ).toEqual([]);
  });

  test("the expander leaves no half-expanded path behind", () => {
    // If an unexpanded `${VAR}` survived into the path, every unresolvable
    // case would arrive at the existence check and report `missing-file`, and
    // the distinction the case above asserts would be decorative.
    const { path, unresolved } = resolveCommandPath("bun ${NOPE}/Alpha.hook.ts", {});
    expect(unresolved).toEqual(["NOPE"]);
    expect(path).not.toContain("$");
    expect(resolveCommandPath("bun $HOME/x.hook.ts", { HOME: "/h" })).toEqual({
      path: "/h/x.hook.ts",
      unresolved: [],
    });
  });
});

describe("#479: the live reconciliation, over what the repo owns", () => {
  function live(): Finding[] {
    const settings = readFileSync(join(ROOT, ".claude", "settings.json"), "utf-8");
    return reconcile(
      entries(),
      { project: [settings], user: [] },
      { CLAUDE_PROJECT_DIR: ROOT },
      existsSync,
    );
  }

  test("every project-scoped hook declared enabled is registered and resolves", () => {
    // Deterministic in CI: `CLAUDE_PROJECT_DIR` is bound to the repo root by
    // this test rather than read from the environment, so the answer does not
    // depend on which machine runs it. That is what makes this check possible
    // at all, and what the first attempt at it got wrong.
    const blocking = live().filter(f => f.kind !== "unmeasured");
    expect(
      blocking,
      blocking.map(f => `${f.hook}: ${f.kind} — ${f.detail}`).join("\n"),
    ).toEqual([]);
  });

  test("the live run reaches real project-scoped entries, so the check above is not vacuous", () => {
    // An inventory with no project-scoped entry satisfies the assertion above
    // for free. This is the arm that fails if someone quietly re-tags the
    // three back to `user` to make a red run green.
    const project = entries().filter(h => h.enabled === true && h.scope === "project");
    expect(project.length, "no project-scoped hook is declared enabled").toBeGreaterThanOrEqual(3);
  });

  test("the user-scoped entries are reported UNMEASURED rather than counted as checked", () => {
    const unmeasured = live().filter(f => f.kind === "unmeasured");
    expect(unmeasured.length, "no entry reported UNMEASURED").toBeGreaterThan(0);
    const names = new Set(unmeasured.map(f => f.hook));
    // BashToolGuard is the registration this repo has been running longest,
    // and it lives in user settings. If it ever reads as measured, something
    // has started claiming to see a file the repo does not own.
    expect(names.has("BashToolGuard")).toBe(true);
  });
});

describe("#479: an entry that is off records why", () => {
  test("SC-1662: an entry that is off must say why", () => {
    const unexplained = unexplainedDisabled(entries());
    expect(
      unexplained,
      `disabled with no disabledReason: ${unexplained.join(", ")}`,
    ).toEqual([]);
  });

  test("the inventory actually has disabled entries, so the check above is not vacuous", () => {
    const off = entries().filter(h => h.enabled === false);
    expect(off.length, "nothing is disabled, so nothing was decided").toBeGreaterThan(0);
    for (const h of off) {
      // A reason has to be a reason. One word satisfies "truthy" and explains
      // nothing to whoever finds it in six months.
      expect((h.disabledReason ?? "").length, h.name).toBeGreaterThan(40);
    }
  });

  test("the predicate reports a reasonless disabled entry", () => {
    expect(unexplainedDisabled([{ name: "Alpha", enabled: false }])).toEqual(["Alpha"]);
    expect(unexplainedDisabled([{ name: "Alpha", enabled: false, disabledReason: "   " }])).toEqual([
      "Alpha",
    ]);
    expect(unexplainedDisabled([{ name: "Alpha", enabled: false, disabledReason: "because" }])).toEqual(
      [],
    );
    // An ENABLED entry is not asked for a reason — otherwise the live check
    // above would be satisfied by an inventory where everything is off.
    expect(unexplainedDisabled([{ name: "Alpha", enabled: true }])).toEqual([]);
  });

  test("SC-1661: lib/scaffold/defaults.ts contains [disabledReason]", () => {
    // The inventory is GENERATED. A decision recorded only in
    // `.claude/rungate/hooks.json` is a decision the next scaffold repair
    // overwrites, so the field has to exist where the generator defines the
    // shape.
    const src = readFileSync(join(ROOT, "lib", "scaffold", "defaults.ts"), "utf-8");
    expect(src).toContain("disabledReason");
    expect(src).toContain('scope: "project" | "user"');
    for (const hook of buildDefaultHooks()) {
      expect(hook.scope, `${hook.name} declares no scope`).toMatch(/^(project|user)$/);
    }
  });
});
