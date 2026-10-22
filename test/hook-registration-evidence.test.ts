import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";

import {
  IncompleteScopeReadingError,
  REGISTRATION_SCOPES,
  hookRegistration,
  readRegistrationScopes,
  registrationCensus,
  settingsScopePaths,
  unplacedHooks,
  type ScopeReading,
} from "../lib/hook-scopes";
import {
  appendEvidence,
  commandDigestFacts,
  errorFacts,
  firingLine,
  parseFirings,
  suiteTokens,
} from "../lib/hook-evidence";
import { commandNamesHook, executedHookFile, settingsCommands } from "../lib/hook-trees";

/**
 * #910 and #713 are one defect read from two sides, and this file holds the
 * two things neither of them had: a reading that cannot be taken from one
 * scope, and evidence that a hook ran.
 *
 * ## What was actually true, measured before anything was written
 *
 * #910's body says `ProjectStateSync.hook.ts` and `TestSuiteRelease.hook.ts`
 * are "in NO registry" and have "never been able to fire". Parsed out of
 * `~/.claude/settings.json` on 2026-10-21:
 *
 *   PostToolUse  matcher='Bash'   bun ${RUNGATE_HOOKS_DIR}/TestSuiteRelease.hook.ts
 *   PostToolUse  matcher='Write'  bun ${RUNGATE_HOOKS_DIR}/ProjectStateSync.hook.ts
 *   PostToolUse  matcher='Edit'   bun ${RUNGATE_HOOKS_DIR}/ProjectStateSync.hook.ts
 *
 * Both have been registered throughout. The four counts in #910 are correct
 * and the conclusion drawn from them is not: they are counts over THIS
 * REPOSITORY's registries, and "registered nowhere" is a claim about every
 * scope. #713 made the identical error pointing the other way — it read
 * `~/.claude/settings.json` alone and reported `AgentBriefGuard` dead, when
 * the repo's own project settings register it.
 *
 * **The repository already held the contradiction and nothing compared the
 * two.** `test/test-suite-guard-registration.test.ts` has asserted since #67-A
 * that `TestSuiteRelease.hook.ts` IS registered in user settings. It is green.
 * It was green while #898's census reported the same hook registered nowhere,
 * while two hook files were given `NOT REGISTERED` headers on the strength of
 * that census, and while #910 attributed a month of TTL waits to it.
 *
 * ## The property this file adds, which a wider check would not have
 *
 * The repair that suggests itself is "read more scopes". That is satisfiable
 * by reading more scopes *this time*, and the next census points somewhere
 * narrower and reports confident absence again. So the binding refuses:
 * `hookRegistration` throws unless it is handed a reading for every scope in
 * `REGISTRATION_SCOPES`, and an unreadable scope must carry a reason.
 *
 * The consequence is the one sentence that matters: **no reading taken from
 * fewer than every scope can produce the verdict `unregistered`.** A scope
 * that could not be read makes the verdict `unmeasured`, which is reported
 * and is never clean (`.claude/rules/config-access.md`).
 *
 * ## Execution was UNMEASURED, and registration does not answer it
 *
 * Registration is now measured. Whether either hook RUNS was not, by anybody,
 * because neither hook wrote anything anywhere — there was no control string
 * a search could ask for, which is `.claude/rules/checks-must-be-able-to-fail.md`'s
 * #646 shape with no store to search at all. The evidence cases below drive
 * both hooks as real subprocesses and read what they left behind, so
 * "declined" and "never fired" stop being the same observation.
 */

const ROOT = join(import.meta.dir, "..");
const HOOKS = join(ROOT, "hooks");

/** A complete reading in which every scope is readable and holds `commands`. */
function complete(commands: Partial<Record<string, string[]>>): ScopeReading[] {
  return REGISTRATION_SCOPES.map(scope => ({ scope, commands: commands[scope] ?? [] }));
}

describe("#713 / #910 AC-1: a verdict cannot be taken from one scope", () => {
  test("AC-1a: a reading short of one scope is refused, not answered", () => {
    // The structural half. #910 counted this repo's registries and read zero
    // as absence; #713 read user settings and did the same. Both calls are
    // this one, and both now throw instead of returning a verdict.
    const oneScope: ScopeReading[] = [{ scope: "repo-registry", commands: [] }];
    expect(() => hookRegistration("TestSuiteRelease", oneScope)).toThrow(
      IncompleteScopeReadingError,
    );
    expect(() => hookRegistration("TestSuiteRelease", oneScope)).toThrow(/project-settings/);
  });

  test("AC-1b: a scope supplied twice does not stand in for a scope missing", () => {
    // The accidental way to satisfy a count-based completeness check. The
    // refusal is over the SET of scopes, so five readings naming four scopes
    // is still four scopes.
    const standingIn: ScopeReading[] = [
      ...REGISTRATION_SCOPES.filter(s => s !== "user-settings").map(scope => ({
        scope,
        commands: [] as string[],
      })),
      { scope: "repo-registry", commands: [] },
    ];
    expect(standingIn.length).toBe(REGISTRATION_SCOPES.length);
    expect(() => hookRegistration("Alpha", standingIn)).toThrow(IncompleteScopeReadingError);

    // And the input the case above does NOT reach, which is the one the
    // duplicate branch owns. Measured: with full coverage plus one repeat,
    // the missing-scope branch is silent, so without this the duplicate
    // branch is deletable and the battery reads 0 red (row M2).
    const repeated: ScopeReading[] = [
      ...REGISTRATION_SCOPES.map(scope => ({ scope, commands: [] as string[] })),
      { scope: "user-settings", commands: ["bun ${RUNGATE_HOOKS_DIR}/Alpha.hook.ts"] },
    ];
    expect(repeated.length).toBe(REGISTRATION_SCOPES.length + 1);
    expect(() => hookRegistration("Alpha", repeated)).toThrow(/more than once/);
  });

  test("AC-1c: an unreadable scope with no reason is refused", () => {
    // A `null` reading with nothing beside it is indistinguishable from a
    // scope nobody tried to read, and the whole point of the verdict is which
    // of those happened.
    const readings = complete({}).map(r =>
      r.scope === "user-settings" ? { ...r, commands: null } : r,
    );
    expect(() => hookRegistration("Alpha", readings)).toThrow(IncompleteScopeReadingError);
    expect(() => hookRegistration("Alpha", readings)).toThrow(/why/);
  });

  test("AC-1d: a reading claiming both commands and unreadability is refused", () => {
    const readings = complete({}).map(r =>
      r.scope === "user-settings" ? { ...r, unreadable: "ENOENT" } : r,
    );
    expect(() => hookRegistration("Alpha", readings)).toThrow(IncompleteScopeReadingError);
  });
});

describe("#713 / #910 AC-2: the three verdicts are distinct and named", () => {
  test("AC-2a: a hook named only by the LAST scope is registered", () => {
    // The input #910 got wrong. A reader that stopped at the repo registry
    // reports absence; the complete reading reports where it actually is.
    const r = hookRegistration(
      "TestSuiteRelease",
      complete({ "user-settings": ["bun ${RUNGATE_HOOKS_DIR}/TestSuiteRelease.hook.ts"] }),
    );
    expect(r.verdict).toBe("registered");
    expect(r.registeredIn).toEqual(["user-settings"]);
  });

  test("AC-2b: no hit with every scope read IS unregistered", () => {
    // The positive control for AC-2c. Without it, a binding that answered
    // `unmeasured` for everything satisfies every other case here.
    const r = hookRegistration("Alpha", complete({ "repo-registry": ["bun Other.hook.ts"] }));
    expect(r.verdict).toBe("unregistered");
    expect(r.unreadable).toEqual([]);
  });

  test("AC-2c: no hit with one scope UNREADABLE is unmeasured, never unregistered", () => {
    // The pair that varies exactly one thing: the same absent hook, the same
    // four other scopes, with `user-settings` readable in AC-2b and not here.
    // `0`, `{}` and silence are indistinguishable from success; a reading is
    // not (`.claude/rules/config-access.md`).
    const readings = complete({ "repo-registry": ["bun Other.hook.ts"] }).map(r =>
      r.scope === "user-settings"
        ? { ...r, commands: null, unreadable: "not present on this machine" }
        : r,
    );
    const r = hookRegistration("Alpha", readings);
    expect(r.verdict).toBe("unmeasured");
    expect(r.unreadable).toEqual(["user-settings"]);
    expect(
      r.detail,
      'the reading does not say why an absence here is not "not registered"',
    ).toContain('not "not registered"');
  });

  test("AC-2d: a hit in a readable scope outranks an unreadable one", () => {
    // Asymmetric on purpose, and the asymmetry is the correctness argument: a
    // positive is conclusive from one scope, a negative is not conclusive from
    // any number short of all of them.
    const readings = complete({
      "project-settings": ["bun ${CLAUDE_PROJECT_DIR}/hooks/Alpha.hook.ts"],
    }).map(r => (r.scope === "user-settings" ? { ...r, commands: null, unreadable: "absent" } : r));
    const r = hookRegistration("Alpha", readings);
    expect(r.verdict).toBe("registered");
    expect(r.unreadable).toEqual(["user-settings"]);
  });

  test("AC-2e: the scope list has one declaring position and no duplicates", () => {
    // Every other case here compares against `REGISTRATION_SCOPES`, so a list
    // that silently gained a duplicate would weaken the completeness refusal
    // without any case noticing.
    expect(new Set(REGISTRATION_SCOPES).size).toBe(REGISTRATION_SCOPES.length);
    const onDisk = settingsScopePaths("/repo", "/home").map(s => s.scope);
    expect(
      [...onDisk, "repo-registry"].sort(),
      "a scope exists that no reader knows how to find, or vice versa",
    ).toEqual([...REGISTRATION_SCOPES].sort());
  });

  test("AC-2f: an absent REPO scope reads empty; an absent MACHINE scope does not", () => {
    // The pair that varies exactly one thing: the same absent file, owned by
    // the repo in one half and by the machine in the other.
    //
    // Collapsing these is a check that cannot fail, and it is not
    // hypothetical — this repository has no `.claude/settings.local.json`, so
    // reading that absence as UNMEASURED left every verdict on every machine
    // carrying an unreadable scope and `unregistered` permanently
    // unreachable. Found by battery row M6 coming back 4 against 1.
    const absentEverything = readRegistrationScopes("/repo", "/home", () => null, []);
    const byScope = new Map(absentEverything.map(r => [r.scope, r]));

    for (const { scope, ownership } of settingsScopePaths("/repo", "/home")) {
      const reading = byScope.get(scope)!;
      if (ownership === "repo") {
        expect(reading.commands, `${scope} is repo-owned and its absence is a reading`).toEqual([]);
      } else {
        expect(reading.commands, `${scope} is machine state and its absence is not a reading`).toBeNull();
      }
    }

    // Both ownerships are present in the list, so the loop above is not
    // asserting one branch twice.
    const ownerships = new Set(settingsScopePaths("/repo", "/home").map(s => s.ownership));
    expect(ownerships, "every settings scope has the same owner, so the split decides nothing").toEqual(
      new Set(["repo", "machine"]),
    );

    // And the consequence: with only the repo scopes readable, a hook named
    // by none of them is UNMEASURED, not unregistered.
    expect(hookRegistration("Alpha", absentEverything).verdict).toBe("unmeasured");
  });
});

describe("#910 AC-3: the live reading of the two hooks #910 called unregistered", () => {
  /** Every scope, read for real, with the ones that are not there named. */
  function liveReadings(): ScopeReading[] {
    const registry = join(ROOT, ".claude", "rungate", "hooks.json");
    return readRegistrationScopes(
      ROOT,
      homedir(),
      p => (existsSync(p) ? readFileSync(p, "utf-8") : null),
      (JSON.parse(readFileSync(registry, "utf-8")) as { command?: string }[])
        .map(h => h.command ?? "")
        .filter(Boolean),
    );
  }

  test("AC-3a: neither hook is unregistered under a complete reading", () => {
    // #910's headline. On this machine both resolve to `registered` naming
    // `user-settings`; on a runner, where that file does not exist, both
    // resolve to `unmeasured`. Neither is `unregistered`, which is the claim
    // the issue made and the one no complete reading can produce.
    const readings = liveReadings();
    const readable = readings.filter(r => r.commands !== null);
    expect(
      readable.length,
      "no scope was readable at all, so this case compared nothing",
    ).toBeGreaterThan(0);

    for (const hook of ["TestSuiteRelease", "ProjectStateSync"]) {
      const r = hookRegistration(hook, readings);
      expect(
        r.verdict,
        `${hook}: ${r.detail}. #910 concluded "registered nowhere" from the repo registry alone.`,
      ).not.toBe("unregistered");
    }
  });

  test("AC-3b: where the user scope IS readable, it is the scope that names them", () => {
    // The half that cannot be satisfied by anything the repo owns: the only
    // scope that can say these two hooks are WIRED is the one #910 never
    // opened. `.claude/rungate/hooks.json` now carries a row for each, but a
    // row is the repo declaring where a hook is supposed to live; it is not a
    // registration, and this case is what keeps the two apart.
    const readings = liveReadings();
    const user = readings.find(r => r.scope === "user-settings")!;
    if (user.commands === null) {
      // A runner, and this arm has now been wrong TWICE in opposite
      // directions. Both are worth keeping written down, because the second
      // is this PR's own subject reproduced one level down.
      //
      // 1. It asserted `verdict === "unmeasured"`. The registry rows added
      //    for AC-4b made that stale in CI and nowhere else: `repo-registry`
      //    names both hooks now, so a runner reads `registered`. CI red.
      // 2. The repair asserted `unreadable` contains `user-settings` and
      //    `registeredIn` does not. **Those cannot disagree.** `registeredIn`
      //    is built from `(r.commands ?? [])`, so a null-commands scope can
      //    never appear in it, and `unreadable` is the same filter the branch
      //    condition above already took. A tautology, inside the PR that
      //    closes a fail-open. A green that cannot go red reads as evidence.
      //
      // Re-grounded on the claim the case actually owns: **nothing the repo
      // owns can say these two hooks are WIRED.** So empty the repo
      // registry's declaration — a row there is the repo saying where a hook
      // is SUPPOSED to live, not a registration — and what is left is the
      // question only the user scope can answer. On a runner it cannot be
      // answered, and `unmeasured` is the reading rather than a skip.
      const withoutDeclaration = readings.map(r =>
        r.scope === "repo-registry" ? { ...r, commands: [] } : r,
      );
      for (const hook of ["TestSuiteRelease", "ProjectStateSync"]) {
        const r = hookRegistration(hook, withoutDeclaration);
        // Each of these has an input that makes it red, and they are
        // different inputs: collapse the repo/machine ownership split and
        // the verdict becomes `unregistered`; let any repo-owned scope name
        // the hook and `registeredIn` stops being empty.
        expect(r.verdict, `${hook}: ${r.detail}`).toBe("unmeasured");
        expect(
          r.registeredIn,
          `${hook} is named by a repo-owned scope, so this case no longer ` +
            `witnesses that only the user scope can register it`,
        ).toEqual([]);
      }
      return;
    }
    for (const hook of ["TestSuiteRelease", "ProjectStateSync"]) {
      expect(
        hookRegistration(hook, readings).registeredIn,
        `${hook} is no longer registered in ~/.claude/settings.json`,
      ).toContain("user-settings");
    }
  });

  test("AC-3c: a census answers for every hook handed to it", () => {
    const readings = liveReadings();
    const hooks = ["TestSuiteRelease", "ProjectStateSync", "AgentBriefGuard"];
    const census = registrationCensus(hooks, readings);
    expect(census.map(c => c.hook)).toEqual(hooks);
    // #713's own mirror of the same error: it reported AgentBriefGuard dead.
    expect(census.find(c => c.hook === "AgentBriefGuard")!.verdict).not.toBe("unregistered");
  });
});

describe("#910 AC-4: a fired hook leaves evidence", () => {
  test("AC-4a: a firing renders as one JSON line carrying hook, outcome and time", () => {
    const line = firingLine("Alpha", "released", { slot: 1 }, new Date("2026-10-21T12:00:00Z"));
    expect(line.endsWith("\n"), "a line that does not end the record corrupts the next one").toBe(
      true,
    );
    expect(line.split("\n").filter(Boolean).length).toBe(1);
    const parsed = parseFirings(line);
    expect(parsed).toEqual([
      { at: "2026-10-21T12:00:00.000Z", hook: "Alpha", outcome: "released", detail: { slot: 1 } },
    ]);
  });

  test("AC-4b: appending creates the directory and keeps both records", () => {
    const dir = mkdtempSync(join(tmpdir(), "hook-evidence-"));
    try {
      const path = join(dir, "nested", "hook-firings.jsonl");
      expect(appendEvidence(path, firingLine("Alpha", "one", {}, new Date()))).toBe(true);
      expect(appendEvidence(path, firingLine("Alpha", "two", {}, new Date()))).toBe(true);
      expect(parseFirings(readFileSync(path, "utf-8")).map(f => f.outcome)).toEqual(["one", "two"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC-4c: a write that cannot happen returns false and never throws", () => {
    // A hook that throws fails the tool call it is attached to. A hook whose
    // evidence silently vanished would also be reporting nothing, so the
    // refusal is returned rather than swallowed.
    const dir = mkdtempSync(join(tmpdir(), "hook-evidence-"));
    try {
      const blocker = join(dir, "blocker");
      writeFileSync(blocker, "not a directory");
      let threw = false;
      let result = true;
      try {
        result = appendEvidence(join(blocker, "under-a-file.jsonl"), "x\n");
      } catch {
        threw = true;
      }
      expect(threw, "appendEvidence threw, which would fail the tool call it is attached to").toBe(
        false,
      );
      expect(result).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#970 review: the evidence file carries no secret, and the match is by name", () => {
  test("AC-6a: a command with a leading env assignment is not recorded", () => {
    // Finding 1. `TOKEN=... bun test` is an ordinary spelling, and the
    // evidence file is append-only, long-lived, and read by somebody who was
    // not there. The pair varies exactly one thing: the secret.
    // Built rather than spelled, so no credential-shaped literal sits in
    // the source for an external secret scanner to report (#1036). The
    // VALUE is unchanged — redaction here is allowlist-based, but the
    // sibling fixtures are matched by a detector, so the whole class keeps
    // its exact bytes and only its spelling changes.
    const secret = "ghp_" + "aaaabbbbccccddddeeeeffff0000111122";
    const facts = commandDigestFacts(`GITHUB_TOKEN=${secret} bun test --parallel`);
    const rendered = firingLine("Alpha", "released", facts, new Date());

    expect(rendered, "the raw secret reached the record").not.toContain(secret);
    expect(rendered, "the env assignment reached the record").not.toContain("GITHUB_TOKEN");
    // And the questions the record exists to answer still have answers.
    expect(facts.suiteTokens).toEqual(["bun", "test", "--parallel"]);
    expect(facts.commandDigest).toHaveLength(16);
    expect(commandDigestFacts("GITHUB_TOKEN=other bun test --parallel").commandDigest).not.toBe(
      facts.commandDigest,
    );
    expect(commandDigestFacts(`GITHUB_TOKEN=${secret} bun test --parallel`).commandDigest).toBe(
      facts.commandDigest,
    );
  });

  test("AC-6b: suiteTokens draws from a fixed vocabulary, so nothing can be pushed through it", () => {
    // The property that makes a classification safe where a pass-through is
    // not: the output is a SUBSET of the vocabulary whatever the input.
    const hostile = "AWS_SECRET=zzz bun test ./node_modules/.bin/weird --parallel";
    for (const token of suiteTokens(hostile)) {
      expect(hostile.split(/\s+/)).toContain(token);
      expect(token, `${token} is not a vocabulary word`).toMatch(
        /^(bun|npm|pnpm|yarn|npx|test|vitest|jest|--parallel|--no-isolate|--coverage)$/,
      );
    }
    expect(suiteTokens(hostile)).not.toContain("AWS_SECRET=zzz");
    // Non-vacuous: it really does find the words it is meant to.
    expect(suiteTokens(hostile)).toEqual(["bun", "test", "--parallel"]);
  });

  test("AC-6c: an error is recorded as a class and a digest, never its message", () => {
    // Finding 2. `execSync`'s message quotes the whole command line.
    const e = new Error("Command failed: bun /x/scripts/update-project-state.ts --token=sek-ret-9");
    const facts = errorFacts(e);
    expect(JSON.stringify(facts)).not.toContain("sek-ret-9");
    expect(JSON.stringify(facts)).not.toContain("Command failed");
    expect(facts.errorClass).toBe("Error");
    expect(facts.errorDigest).toHaveLength(16);

    // `name` is writable, so a hostile or merely odd value is classified
    // rather than passed through.
    const odd = new Error("x");
    odd.name = "tok en: sek-ret-9";
    expect(errorFacts(odd).errorClass).toBe("UNCLASSIFIED");
    expect(JSON.stringify(errorFacts(odd))).not.toContain("sek-ret-9");
  });

  test("AC-6d: the evidence file is 0600 and its directory 0700", () => {
    const dir = mkdtempSync(join(tmpdir(), "hook-evidence-mode-"));
    try {
      const path = join(dir, "nested", "hook-firings.jsonl");
      expect(appendEvidence(path, firingLine("Alpha", "one", {}, new Date()))).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC-6f: the placement predicate has a witness in the suite, not only on a machine", () => {
    // `AC-4b` in test/hook-traceability.test.ts drives this over the live
    // tree, where nothing is unplaced — so short-circuiting the predicate to
    // `[]` is 0 red there and the live case witnesses nothing (battery row
    // N6). These fixtures are the three ways to be placed and the one way
    // not to be, so a mutation of the predicate has somewhere to land.
    const registers = (cmd: string): ScopeReading[] => [
      { scope: "project-settings", commands: [cmd] },
      { scope: "repo-registry", commands: [] },
    ];
    const base = {
      hooks: ["Alpha"],
      repoReadings: registers("bun ${CLAUDE_PROJECT_DIR}/hooks/Other.hook.ts"),
      declaredUnregistered: [] as string[],
    };

    // Unplaced: nothing the repo owns mentions it.
    expect(unplacedHooks(base)).toEqual(["Alpha"]);

    // Each placement, one at a time, so neither is covering for the other.
    // Both repo-owned scopes are driven, because the registry is one of them
    // and a reader that only consulted the settings would miss it.
    expect(
      unplacedHooks({
        ...base,
        repoReadings: registers("bun ${CLAUDE_PROJECT_DIR}/hooks/Alpha.hook.ts"),
      }),
    ).toEqual([]);
    expect(
      unplacedHooks({
        ...base,
        repoReadings: [
          { scope: "project-settings", commands: [] },
          { scope: "repo-registry", commands: ["bun ${RUNGATE_HOOKS_DIR}/Alpha.hook.ts"] },
        ],
      }),
    ).toEqual([]);
    expect(unplacedHooks({ ...base, declaredUnregistered: ["Alpha"] })).toEqual([]);

    // And the fail-open this exists to close: a repo-owned scope read as
    // unreadable refuses rather than returning an empty list.
    expect(() =>
      unplacedHooks({
        ...base,
        repoReadings: [
          { scope: "project-settings", commands: null, unreadable: "gone" },
          { scope: "repo-registry", commands: [] },
        ],
      }),
    ).toThrow(IncompleteScopeReadingError);
    expect(() => unplacedHooks({ ...base, repoReadings: [] })).toThrow(IncompleteScopeReadingError);
  });

  test("AC-6g: a name in a NON-EXECUTING position is not a registration", () => {
    // The third review of this work. Token membership — the matcher that
    // replaced `includes` — accepts any `.hook.ts`-shaped token anywhere in
    // the string, so a hook counted as registered because its name appeared
    // near a command that never runs it. Measured on that matcher: all four
    // of these returned true.
    for (const command of [
      "bun run x.ts # IssueCloseGuard.hook.ts",
      "bun run x.ts ; echo IssueCloseGuard.hook.ts",
      "bun run x.ts && cat IssueCloseGuard.hook.ts",
      "bun run x.ts || bun IssueCloseGuard.hook.ts",
      "bun run x.ts | grep IssueCloseGuard.hook.ts",
      "SOME=1 bun run x.ts --note IssueCloseGuard.hook.ts",
      "bun run x.ts --hook=IssueCloseGuard.hook.ts",
      // A separator GLUED to the token before it. This is the input that
      // distinguishes the truncation from the first-positional rule: with
      // the truncation removed the whole of `bun;${D}/…` becomes the first
      // positional, its basename IS the hook file, and the mutant returns
      // it. Without this case, removing the truncation is 0 red and the
      // clause is deletable (battery row P1).
      "bun;${RUNGATE_HOOKS_DIR}/IssueCloseGuard.hook.ts",
      // The fifth review, and the differential the FIRST version of this
      // parse had: `--preload` takes the next token, so a loop that skipped
      // every flag and then took the next positional reported a PRELOADED
      // file as the executed one. `real.ts` runs; IssueCloseGuard does not.
      "bun --preload IssueCloseGuard.hook.ts run real.ts",
      "bun -r IssueCloseGuard.hook.ts run real.ts",
    ]) {
      expect(executedHookFile(command), command).not.toBe("IssueCloseGuard.hook.ts");
      expect(commandNamesHook(command, "IssueCloseGuard"), command).toBe(false);
    }

    // A neighbouring file name is not this hook, asserted on the EXTRACTOR
    // and not only through `commandNamesHook` — the equality in the
    // predicate agrees with a looser extractor on this input, so the looser
    // extractor is only visible here (battery row P6).
    expect(executedHookFile("bun ${D}/IssueCloseGuard.hook.ts.bak")).toBeNull();
    expect(executedHookFile("bun ${D}/other-IssueCloseGuard.hook.ts")).toBe(
      "other-IssueCloseGuard.hook.ts",
    );

    // The positive controls, in every spelling the tree really uses. Without
    // them a parse that returned null for everything satisfies the loop.
    for (const command of [
      "bun ${RUNGATE_HOOKS_DIR}/IssueCloseGuard.hook.ts",
      "bun ${CLAUDE_PROJECT_DIR}/hooks/IssueCloseGuard.hook.ts",
      "TOKEN=x env FOO=2 bun ${D}/IssueCloseGuard.hook.ts",
      "bun run ${D}/IssueCloseGuard.hook.ts",
      // A flag between the interpreter and the script. Without this the flag
      // skip is deletable at 0 red (battery row P3). It must be the `=` form:
      // a `--flag=value` carries its value in its own token, so skipping it
      // cannot swallow the script, and that is the ONLY flag shape this parse
      // skips. A bare one is refused — see the `--preload` rows above.
      "bun --conditions=node ${D}/IssueCloseGuard.hook.ts",
    ]) {
      expect(executedHookFile(command), command).toBe("IssueCloseGuard.hook.ts");
    }
  });

  test("AC-6h: the parse's OWN differentials are the stated ones, and they err loud", () => {
    // Three PRs in one day replaced a matcher that was wrong about its
    // subject with one carrying the same property a level down. An argv
    // parse has its own differentials and this does not close them all — so
    // the ones left open are asserted, as a boundary a reader can see rather
    // than coverage they infer. If one of these ever starts returning the
    // hook, that is a real improvement and this case should be updated.
    //
    // This list is the one in `lib/hook-trees.ts`'s `WHAT THIS DOES NOT
    // COVER` table. The two are deliberately the same population, so the
    // doc cannot claim a boundary the code does not have.
    const notClosed = [
      `sh -c "bun \${D}/IssueCloseGuard.hook.ts"`, // the command is inside a string
      "/usr/local/bin/run-hook IssueCloseGuard", // a wrapper execs it
      "bun ${HOOK_PATH}", // the path is built in a variable
      "make build && bun ${D}/IssueCloseGuard.hook.ts", // a later segment
      "bun --inspect ${D}/IssueCloseGuard.hook.ts", // a BARE flag, refused
      "bun -- ${D}/IssueCloseGuard.hook.ts", // the end-of-flags separator
      'bun "$(resolve IssueCloseGuard.hook.ts)"', // a computed specifier
    ];
    for (const command of notClosed) {
      expect(commandNamesHook(command, "IssueCloseGuard"), command).toBe(false);
    }

    // The direction matters more than the list. Every one of them reports a
    // registration that EXISTS as absent, so `hookRegistration` returns
    // `unregistered` or `unmeasured` and AC-4/AC-4b go red — loud, and
    // somebody adds the spelling to the parse. The opposite error is a guard
    // reporting clean about its own subject, which is what #910 cost.
    expect(
      hookRegistration(
        "IssueCloseGuard",
        complete({ "user-settings": [`sh -c "bun \${D}/IssueCloseGuard.hook.ts"`] }),
      ).verdict,
      "an unparsed spelling must fail loud, never read as registered",
    ).toBe("unregistered");
  });

  test("AC-6e: a registration is matched by hook NAME, not by substring", () => {
    // Finding 3. `c.includes("TestSuiteRelease.hook.ts")` is satisfied by a
    // different file whose name ends in the same characters — so a hook that
    // is NOT registered reads as registered, and `registered` is the one
    // verdict conclusive from a single scope.
    const imposters = [
      "bun ${RUNGATE_HOOKS_DIR}/other-TestSuiteRelease.hook.ts",
      "bun ${RUNGATE_HOOKS_DIR}/TestSuiteRelease.hook.ts.bak",
      "bun ${RUNGATE_HOOKS_DIR}/Other.hook.ts --note=TestSuiteRelease.hook.ts.disabled",
    ];
    for (const command of imposters) {
      expect(commandNamesHook(command, "TestSuiteRelease"), command).toBe(false);
      expect(
        hookRegistration("TestSuiteRelease", complete({ "user-settings": [command] })).verdict,
        command,
      ).toBe("unregistered");
    }

    // The positive control, in both spellings the tree really uses. Without
    // it, a matcher that refused everything satisfies the loop above.
    for (const command of [
      "bun ${RUNGATE_HOOKS_DIR}/TestSuiteRelease.hook.ts",
      "bun ${CLAUDE_PROJECT_DIR}/hooks/TestSuiteRelease.hook.ts",
    ]) {
      expect(commandNamesHook(command, "TestSuiteRelease"), command).toBe(true);
    }
  });
});

/**
 * The hooks themselves, driven as subprocesses — #910's own SC-2 restated.
 *
 * "An entry exists in a JSON file" is what #910 refused to accept as proof,
 * and rightly: it is the question restated (#530). These spawn the real hook
 * with real stdin and read the file it wrote.
 */
describe("#910 AC-5: both hooks are observed running, and a decline is not a silence", () => {
  function drive(
    hook: string,
    input: unknown,
    env: Record<string, string>,
  ): { stdout: string; firings: { hook: string; outcome: string; detail?: any }[] } {
    const work = env.RUNGATE_WORK_DIR;
    const r = Bun.spawnSync({
      cmd: ["bun", join(HOOKS, hook)],
      stdin: Buffer.from(JSON.stringify(input)),
      env: { ...process.env, ...env },
    });
    const path = join(work, "hook-firings.jsonl");
    const firings = existsSync(path) ? parseFirings(readFileSync(path, "utf-8")) : [];
    return { stdout: r.stdout.toString(), firings };
  }

  test("AC-5a: TestSuiteRelease records a release, and records a decline differently", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-evidence-"));
    try {
      const env = { RUNGATE_WORK_DIR: dir, RUNGATE_LOCK_DIR: join(dir, "locks") };
      const bash = (over: Record<string, unknown>) => ({
        tool_name: "Bash",
        tool_input: { command: "bun test", ...over },
        session_id: "evidence-session",
        cwd: ROOT,
      });

      // Out of population: not a full-suite command. The hook is attached to
      // every Bash call in every session, so recording these would be a log
      // nobody can read — and the question is only about full suites.
      expect(drive("TestSuiteRelease.hook.ts", {
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
        session_id: "evidence-session",
        cwd: ROOT,
      }, env).firings).toEqual([]);

      // Backgrounded: the hook DECLINES to release, deliberately, and before
      // this change that decision was indistinguishable from the hook never
      // having been registered at all. That is the whole of #910.
      const backgrounded = drive("TestSuiteRelease.hook.ts", bash({ run_in_background: true }), env);
      expect(backgrounded.firings.map(f => f.outcome)).toEqual(["declined-background"]);

      // And the release itself.
      const released = drive("TestSuiteRelease.hook.ts", bash({}), env);
      expect(released.firings.map(f => f.outcome)).toEqual(["declined-background", "released"]);
      expect(released.firings.every(f => f.hook === "TestSuiteRelease")).toBe(true);

      // stdout stays empty: a PostToolUse hook's stdout is injected as
      // context, so the evidence goes to a file and nowhere near the session.
      expect(released.stdout).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("AC-5b: ProjectStateSync records the write it acted on, and the one it declined", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-evidence-"));
    try {
      const project = join(dir, "project");
      mkdirSync(join(project, "scripts"), { recursive: true });
      writeFileSync(join(project, "project-state.json"), "{}");
      // Since #1001 the generator only runs at the ROOT OF A REAL
      // REPOSITORY, so the fixture has to be one. Without this the hook
      // declines at the root anchor and never reaches the two outcomes this
      // arm is about — it would go red on `declined-outside-repo`, which is
      // the anchor working rather than the evidence failing.
      execFileSync("git", ["-C", project, "init", "-q"], { stdio: "ignore" });
      const track = () => execFileSync("git", ["-C", project, "add", "-A"], { stdio: "ignore" });
      track();
      const env = { RUNGATE_WORK_DIR: dir };
      const write = (file: string) => ({
        tool_name: "Write",
        tool_input: { file_path: file },
        session_id: "evidence-session",
        cwd: project,
      });

      // Out of population: every agent Write and Edit reaches this hook.
      expect(drive("ProjectStateSync.hook.ts", write(join(project, "README.md")), env).firings).toEqual(
        [],
      );

      // In population, no generator present: declined, and SAID so.
      const noScript = drive("ProjectStateSync.hook.ts", write(join(project, "project-state.json")), env);
      expect(noScript.firings.map(f => f.outcome)).toEqual(["declined-no-generator"]);

      // In population, generator present: it ran.
      writeFileSync(join(project, "scripts", "update-project-state.ts"), "process.exit(0);\n");
      // TRACKED: #1001's anchor refuses an untracked generator, so "present"
      // now means present AND part of the project.
      track();
      const synced = drive("ProjectStateSync.hook.ts", write(join(project, "project-state.json")), env);
      expect(synced.firings.map(f => f.outcome)).toEqual(["declined-no-generator", "synced"]);

      // #296: PROJECT-STATE.md is DA-owned and an agent in a worktree must
      // never write it, and this hook is registered on every agent's Edit.
      // The record names the path and the cwd, so whether a worktree triggered
      // it is a question somebody can now answer from the evidence rather than
      // from an argument about blast radius.
      const last = synced.firings[synced.firings.length - 1];
      expect(last.detail?.filePath).toBe(join(project, "project-state.json"));
      expect(last.detail?.cwd).toBe(project);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
