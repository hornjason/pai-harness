/**
 * #713 — two hook trees, eight duplicated names, and nothing saying which
 * copy wins.
 *
 * Covers SC-1 and SC-2 of #713. SC-3 is answered below and needs no new
 * check; SC-4 is NOT met and says so.
 *
 * ## Where this stops, because most of #713 already has a check
 *
 * `test/hook-registration-reconciler.test.ts` (#199, #479) splits the hook
 * inventory by `scope`, enforces the project-scoped half against the
 * committed `.claude/settings.json`, and reports the user-scoped half as
 * UNMEASURED on every run. **Whether a declared hook is registered is that
 * file's question**, and asking it again here would be two deciders for one
 * question — the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`. Nothing in this file
 * reports a hook as missing.
 *
 * What nothing covered is the dimension #713 is actually about.
 * `registeredIn` matches `/([A-Za-z][A-Za-z0-9]*)\.hook\.ts/`, so
 * `bun ${PAI_HOOKS_DIR}/IssueCloseGuard.hook.ts` satisfies it exactly as well
 * as the rungate path. **Every registration check in this repo is
 * tree-blind**: re-point an owned hook at the superseded 554-line `.pai` copy
 * and the suite stays green.
 *
 * ## SC-3, answered: the issue's premise is wrong
 *
 * #713 says `AgentBriefGuard` is "dead in both trees… wired nowhere". It is
 * registered, at PROJECT scope, in `<repo>/.claude/settings.json` as
 * `bun ${CLAUDE_PROJECT_DIR}/hooks/AgentBriefGuard.hook.ts` — the rungate
 * copy. The measurement read `~/.claude/settings.json` alone, where it is
 * genuinely absent, and took zero hits as absence. That is #646's trap: a
 * negative result over a store you did not write, erring toward believing
 * nothing happened, with the control — *is it wired ANYWHERE?* — never run.
 *
 * It needs no new check. `.claude/rungate/hooks.json` declares it
 * `enabled: true, scope: "project"`, so #479's live reconciliation already
 * reports `unregistered` the moment `.claude/settings.json` stops naming it.
 * The case below asserts the premise is false rather than leaving a wrong
 * sentence in a closed issue, and reads the registration through the same
 * binding the rest of this file uses.
 *
 * ## SC-4 and SC-5 are NOT met, and this file does not pretend otherwise
 *
 * Measured 2026-10-20 with `ls -lO ~/.pai/hooks/`: all eight superseded
 * `.pai` copies carry the `uchg` immutable flag. Removing them needs
 * `chflags nouchg` run deliberately by Jason, and an agent must not silently
 * clear an integrity flag. **SC-4: not met, blocked on Jason.**
 *
 * **SC-5 is also blocked, by something the issue did not know about.** The
 * two stale `.tmp` files (`AutoVerifyGate.hook.ts.tmp`,
 * `MergeGuard.hook.ts.tmp`, both 2026-09-17 11:51) carry NO `uchg` flag — so
 * by the issue's reasoning they should have been deletable. They are not: a
 * `PreToolUse` guard refuses any Bash write to a hook-file path, `.tmp`
 * included, and it refuses a `cp` backup of them as well. That is a second,
 * independent blocker, and routing around an integrity guard is not a repair.
 * **SC-5: not met, blocked — needs Jason, same gesture as SC-4.**
 *
 * The ratchet below is what holds the line until both happen. It is the "say
 * what the number means" form from
 * `.claude/rules/checks-must-be-able-to-fail.md`, not a waiver.
 *
 * ## Where SC-1 is taken literally and where it is not
 *
 * SC-1 asks the test to "refuse rather than pass when either directory cannot
 * be read". Taken at the file level that is a test that fails in CI forever,
 * because `~/.pai` is machine state and no runner has one — and a test that
 * is red in CI for a reason nobody can fix is a test somebody deletes.
 *
 * So the population is split the way #199's own lesson prescribes: *enforce
 * the half the repo owns, and make the other half report UNMEASURED on every
 * run.* The REFUSAL is in the binding — `hookTreeCensus` returns UNMEASURED
 * and never a clean reading when a tree cannot be read — and that is proven
 * by cases that run everywhere. The live census asserts the reading it got,
 * so CI witnesses the refusal rather than skipping the subject.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * #713 names it: **delete the eight `.pai` duplicates and add no check.** The
 * symptom goes away, and nothing stops the ninth appearing next week.
 *
 * The ratchet is what survives it, and in the direction that is easy to get
 * backwards: `DUPLICATE_RATCHET` refuses when the count goes UP *and* when it
 * goes DOWN. Deleting the eight without banking the new number turns this
 * file red, which is the same-commit banking discipline. Applied and counted
 * as row M2 below — measured 1 red, not the 0 the fix's author would see.
 *
 * ## What was broken to prove these can fail
 *
 * Run over this file + `test/hook-registration-reconciler.test.ts` (39
 * tests). Counts predicted in `/tmp/713-battery/predictions.md` before the
 * battery ran, and **the baseline row read first** — an instrument that has
 * stopped reporting takes the baseline down with it, and that is the row
 * nobody mutates anything to produce.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 39 pass, 0 fail | **39 pass, 0 fail** | — |
 * | M1 `wrongTreeViolations` short-circuited to `return []` | 3 | **2 of 39** | a settings doc registering `IssueCloseGuard` from `${PAI_HOOKS_DIR}`: the original returns one violation naming the command, the mutant none |
 * | M2 **the cheapest wrong fix**: the eight duplicates deleted, no check added | 1 | **1 of 39** | a scratch `.pai` tree with the eight genuinely removed — the live census reads 0 duplicates against a banked 8 |
 * | M3 `registrationTree` returns `"rungate"` for every command | 4 | **3 of 39** | the same `${PAI_HOOKS_DIR}` command, and `bun /somewhere/else/X.hook.ts` |
 * | M4 `PAI_ROOTS` emptied, so a `.pai` command reads `unknown` | 2 | **2 of 39** | the same command: `pai` names the superseded copy, `unknown` says nobody classified it |
 * | M5 the UNMEASURED branch removed — an unreadable tree returns `[]` | 3 | **2 of 39** | `listDir` returning `null` for `~/.pai` |
 * | M6 `settingsCommands` stops recursing into nested `hooks[]` | 3 | **5 of 39** | the repo's own `.claude/settings.json`, whose commands sit two levels down |
 * | M7 `settingsCommands` catches the parse error and returns `[]` | 1 | **1 of 39** | `"{not json"` |
 * | M8 duplicates computed even under an UNMEASURED reading | 1 | **0 of 39 — no information** | **none: see below** |
 *
 * **M8's zero is not a gap, and the one-line check is what showed it.**
 * Before recording a 0, name an input on which mutant and original differ —
 * and there is none. When a tree cannot be read, `read` already returns an
 * empty list beside its reason, so `pai.filter(…)` is empty with or without
 * the `reasons.length === 0 ? … : []` guard. Two deciders for one question,
 * the fourth shape, found by the arithmetic rather than by reading. It was
 * COLLAPSED rather than banked; `lib/hook-trees.ts` carries the comment.
 *
 * **M6 came back HIGH at 5, and the extra reds are the real kind** — every
 * one is squarely about nested command reading. The prediction covered the
 * three fixture cases; the extra two are the live-registration case and the
 * SC-3 case, both of which read the repo's own settings, where every command
 * is two levels down. Not a crashing mutant: 34 cases still pass. Per
 * `.claude/rules/checks-must-be-able-to-fail.md` that is "the prediction was
 * wrong and the check is better than you thought", and the fact it records is
 * that the walk is load-bearing for the live claims, not only the fixtures.
 *
 * **M1 and M5 came back LOW by one each, and neither is a collapsed pair.**
 * M1's third predicted red was the live-registration case, which is GREEN
 * under the mutation for a true reason: this tree has no wrong-tree
 * registration, so `[]` is the correct answer either way. M5's was the live
 * census, which is MEASURED on this machine and so never reaches the
 * refusal — it is the case that reaches it in CI.
 *
 * **M3 was 2 before a repair and is 3 after it.** The `unknown` case asked
 * `registrationTree` directly AND drove `wrongTreeViolations`, so one
 * assertion covered two bindings and no row could say which a red belonged
 * to (#484). Split into two cases, and the row went up.
 *
 * None of the eight mutations is left in the tree; all were run and reverted
 * from a `cp` backup, never `git checkout --`, and `lib/hook-trees.ts` and
 * this file were confirmed byte-identical to the measured source by sha256.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import {
  hookTreeCensus,
  registrationTree,
  settingsCommands,
  wrongTreeViolations,
} from "../lib/hook-trees";

const ROOT = join(import.meta.dir, "..");

/**
 * The eight names that exist as files in BOTH trees, measured 2026-10-20 with
 * the command that produced them.
 *
 *   ls ~/.pai/hooks/*.hook.ts ~/Projects/rungate/hooks/*.hook.ts
 *
 * **What the number means.** Every one of the eight `.pai` copies carries the
 * `uchg` immutable flag, so none can be removed without `chflags nouchg` run
 * by Jason (#713 SC-4, not met). This is a known-violations ratchet and it
 * refuses in BOTH directions: a ninth duplicate fails, and clearing one
 * without lowering this number in the same commit fails too. The second
 * direction is the one that matters — it is what the issue's own cheapest
 * wrong fix runs into.
 */
const DUPLICATE_RATCHET = [
  "AgentBriefGuard",
  "AgentVerdictCapture",
  "AutoVerifyGate",
  "GateEnforcement",
  "IssueCloseGuard",
  "MergeGuard",
  "StaleTTLCleanup",
  "VerifyPhaseLock",
] as const;

const PAI_HOOKS = join(homedir(), ".pai", "hooks");
const RUNGATE_HOOKS = join(ROOT, "hooks");

/** `readdirSync`, with an unreadable directory reported as `null` rather than `[]`. */
function listDir(dir: string): string[] | null {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}

/** The hook names this repository owns, read off the tree rather than listed. */
function ownedHooks(): string[] {
  return readdirSync(RUNGATE_HOOKS)
    .filter(n => n.endsWith(".hook.ts"))
    .map(n => n.replace(/\.hook\.ts$/, ""));
}

/** Every settings document this run can read, with the scopes it could not named. */
function readableScopes(): { docs: string[]; names: string[]; missing: string[] } {
  const candidates = [
    ["project", join(ROOT, ".claude", "settings.json")],
    ["project-local", join(ROOT, ".claude", "settings.local.json")],
    ["user", join(homedir(), ".claude", "settings.json")],
  ] as const;
  const docs: string[] = [];
  const names: string[] = [];
  const missing: string[] = [];
  for (const [label, path] of candidates) {
    if (!existsSync(path)) { missing.push(label); continue; }
    docs.push(readFileSync(path, "utf-8"));
    names.push(label);
  }
  return { docs, names, missing };
}

const PAI_DOC = (name: string) =>
  JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: `bun \${PAI_HOOKS_DIR}/${name}.hook.ts` }] },
      ],
    },
  });

const RUNGATE_DOC = (name: string) =>
  JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: `bun \${RUNGATE_HOOKS_DIR}/${name}.hook.ts` }] },
      ],
    },
  });

describe("#713 SC-1: a name in both trees is found, and an unread tree is not 'clean'", () => {
  const TREE = (names: string[]) => names.map(n => `${n}.hook.ts`);

  test("a duplicated name is reported, and a disjoint pair is not", () => {
    // Both directions in one case. The negative half alone is satisfied by a
    // census that reports nothing; the positive half alone is satisfied by
    // one that reports everything.
    const dup = hookTreeCensus("/pai", "/rg", d =>
      d === "/pai" ? TREE(["Alpha", "Beta"]) : TREE(["Beta", "Gamma"]),
    );
    expect(dup.reading).toBe("MEASURED");
    expect(dup.duplicates).toEqual(["Beta"]);

    const clean = hookTreeCensus("/pai", "/rg", d =>
      d === "/pai" ? TREE(["Alpha"]) : TREE(["Gamma"]),
    );
    expect(clean.reading).toBe("MEASURED");
    expect(clean.duplicates).toEqual([]);
  });

  test("a tree that cannot be read is UNMEASURED, never an empty duplicate list", () => {
    // The refusal SC-1 asks for, in the binding rather than at the file
    // level. `0`, `{}` and silence are indistinguishable from success
    // (`.claude/rules/config-access.md`); a reading is not.
    const r = hookTreeCensus("/pai", "/rg", d => (d === "/pai" ? null : TREE(["Beta"])));
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons.join(" ")).toContain("could not be read");
    expect(
      r.unmeasuredReasons.join(" "),
      "the reason does not say why an empty list is the wrong reading",
    ).toContain('not "no duplicates"');
  });

  test("an UNMEASURED reading reports no duplicates, so nobody can read it as a count", () => {
    // The pair that varies exactly one thing: the SAME rungate tree, with the
    // `.pai` side readable in one and not in the other. A census that
    // computed duplicates anyway would return `[]` here for a second reason —
    // the unreadable side contributed nothing — and that `[]` is
    // indistinguishable from the clean case above.
    const unread = hookTreeCensus("/pai", "/rg", d => (d === "/pai" ? null : TREE(["Beta"])));
    const read = hookTreeCensus("/pai", "/rg", d =>
      d === "/pai" ? TREE(["Beta"]) : TREE(["Beta"]),
    );
    expect(unread.duplicates).toEqual([]);
    expect(read.duplicates).toEqual(["Beta"]);
    expect(unread.reading).not.toBe(read.reading);
  });

  test("only *.hook.ts counts, so the two stale .tmp files are not hooks", () => {
    // SC-5's leftovers were `AutoVerifyGate.hook.ts.tmp` and
    // `MergeGuard.hook.ts.tmp` — previous sessions hitting the `uchg` wall.
    // A census matching `.hook.ts` anywhere in the name would have counted
    // them as two more duplicates and the ratchet below would be 10.
    const r = hookTreeCensus("/pai", "/rg", d =>
      d === "/pai" ? ["MergeGuard.hook.ts", "MergeGuard.hook.ts.tmp", "README.md"] : ["MergeGuard.hook.ts"],
    );
    expect(r.pai).toEqual(["MergeGuard"]);
    expect(r.duplicates).toEqual(["MergeGuard"]);
  });

  test("the live census: the two trees have not re-diverged past the banked set", () => {
    // Machine state. On a runner `~/.pai` does not exist, the reading is
    // UNMEASURED, and this case asserts the refusal fired rather than
    // skipping — which is what makes CI witness the subject instead of
    // passing over it.
    const census = hookTreeCensus(PAI_HOOKS, RUNGATE_HOOKS, listDir);

    if (census.reading === "UNMEASURED") {
      expect(
        census.duplicates,
        "an unreadable tree produced a duplicate list, which cannot have been measured",
      ).toEqual([]);
      expect(census.unmeasuredReasons.length).toBeGreaterThan(0);
      return;
    }

    const banked: string[] = [...DUPLICATE_RATCHET];
    const appeared = census.duplicates.filter(n => !banked.includes(n));
    const cleared = banked.filter(n => !census.duplicates.includes(n));

    expect(
      appeared,
      `a hook name now exists in BOTH ${PAI_HOOKS} and ${RUNGATE_HOOKS} and is not banked: ` +
        `${appeared.join(", ")}. Decide which copy wins, delete the other, and leave ` +
        `DUPLICATE_RATCHET naming what is genuinely still duplicated.`,
    ).toEqual([]);

    expect(
      cleared,
      `${cleared.join(", ")} is no longer duplicated — remove it from DUPLICATE_RATCHET in ` +
        `this file, in the same commit that cleared it. A ratchet nobody lowers is a number ` +
        `nobody can interpret (.claude/rules/checks-must-be-able-to-fail.md).`,
    ).toEqual([]);
  });
});

describe("#713 SC-2: which TREE a registration names, which nothing else asks", () => {
  test("a registration from the .pai tree is reported for a hook this repo owns", () => {
    const v = wrongTreeViolations(["IssueCloseGuard"], settingsCommands([PAI_DOC("IssueCloseGuard")]));
    expect(v.length, "a hook rungate owns, wired from the superseded tree, was not reported").toBe(1);
    expect(v[0].tree).toBe("pai");
    expect(v[0].detail).toContain("superseded");
    expect(v[0].detail, "the violation does not name the command, so nobody can find it").toContain(
      "${PAI_HOOKS_DIR}/IssueCloseGuard.hook.ts",
    );
  });

  test("the same hook wired from the rungate tree is reported by nothing", () => {
    // The positive control. Without it every case here is satisfied by a
    // binding that reports every registration.
    expect(
      wrongTreeViolations(["IssueCloseGuard"], settingsCommands([RUNGATE_DOC("IssueCloseGuard")])),
    ).toEqual([]);
    expect(
      wrongTreeViolations(
        ["AgentBriefGuard"],
        settingsCommands([
          '{"hooks":{"PreToolUse":[{"hooks":[{"command":"bun ${CLAUDE_PROJECT_DIR}/hooks/AgentBriefGuard.hook.ts"}]}]}}',
        ]),
      ),
      "the project-scope spelling of the rungate tree was read as the wrong tree",
    ).toEqual([]);
  });

  test("a hook with no registration at all is reported by nothing HERE", () => {
    // Deliberate. Absence is `reconcile`'s finding in
    // `test/hook-registration-reconciler.test.ts`; answering it again would
    // make this the second decider for a question that already has one, and
    // a mutation of either would leave the other holding the case up.
    expect(wrongTreeViolations(["IssueCloseGuard"], settingsCommands([RUNGATE_DOC("Other")]))).toEqual([]);
    expect(wrongTreeViolations(["IssueCloseGuard"], [])).toEqual([]);
  });

  test("the three readings of a command are distinct, and 'unknown' is one of them", () => {
    // `registrationTree`'s own answers, asked directly. Split from the case
    // below after a battery row: both questions in one case meant
    // `registrationTree` and `wrongTreeViolations` were covered by a single
    // assertion, so no row could say which of them a red belonged to —
    // #484's "two questions, one assertion".
    expect(registrationTree("bun ${PAI_HOOKS_DIR}/X.hook.ts")).toBe("pai");
    expect(registrationTree("bun ${RUNGATE_HOOKS_DIR}/X.hook.ts")).toBe("rungate");
    expect(registrationTree("bun ${CLAUDE_PROJECT_DIR}/hooks/X.hook.ts")).toBe("rungate");
    expect(registrationTree("bun /somewhere/else/X.hook.ts")).toBe("unknown");
  });

  test("a command naming neither tree is reported as 'unknown', not quietly accepted", () => {
    // The third reading must not collapse into either of the other two.
    // Defaulting it to rungate is the silent substitution; calling it pai
    // would accuse the wrong tree.
    const v = wrongTreeViolations(
      ["X"],
      settingsCommands(['{"hooks":{"PreToolUse":[{"hooks":[{"command":"bun /somewhere/else/X.hook.ts"}]}]}}']),
    );
    expect(v.map(x => x.tree)).toEqual(["unknown"]);
    expect(v[0].detail).toContain("neither tree");
  });

  test("commands are read from every nesting level the schema uses", () => {
    // The live settings nest event → matcher-group → hooks[] → command. A
    // reader that knew only the top level would return nothing, and nothing
    // is indistinguishable from a tree with no `.pai` registrations in it.
    const cmds = settingsCommands([PAI_DOC("Alpha")]);
    expect(cmds, "the nested command was not reached").toEqual([
      "bun ${PAI_HOOKS_DIR}/Alpha.hook.ts",
    ]);
    expect(settingsCommands([]), "an empty scope list invented a command").toEqual([]);
  });

  test("a settings document that does not parse throws rather than reading as empty", () => {
    // A corrupt settings file is not a settings file with no hooks in it.
    // Swallowing it would make every `.pai` registration in that scope
    // invisible, which is the exact failure mode this file exists for.
    expect(() => settingsCommands(["{not json"])).toThrow();
  });

  test("the live registrations: every hook this repo owns is wired to this repo's copy", () => {
    // Enforced in CI. The committed `.claude/settings.json` is always
    // readable, so this makes a real claim on a runner; the machine scopes
    // are folded in when they exist and the scopes that were read are
    // asserted, so a run that could read nothing cannot pass quietly.
    const { docs, names, missing } = readableScopes();
    expect(
      names,
      `no settings scope was readable (missing: ${missing.join(", ")}), so this read nothing`,
    ).toContain("project");

    const commands = settingsCommands(docs);
    expect(
      commands.length,
      `${names.join(", ")} parsed to zero hook commands — the reading is empty, not clean`,
    ).toBeGreaterThan(0);

    const owned = ownedHooks();
    expect(owned.length, "this repo owns no hooks, so the scan compares nothing").toBeGreaterThan(10);

    const v = wrongTreeViolations(owned, commands);
    expect(
      v,
      `these hooks are owned by this repo and wired to another tree's copy:\n` +
        v.map(x => `  ${x.hook} [${x.tree}] — ${x.detail}`).join("\n"),
    ).toEqual([]);
  });
});

describe("#713 SC-3: AgentBriefGuard is wired, and the issue's premise was a one-scope read", () => {
  test("it is registered at project scope, pointing at the rungate copy", () => {
    // #713 says "wired nowhere". The control the issue never ran — *is it
    // wired ANYWHERE?* — is this case. Asserted through the same binding the
    // rest of the file uses, over the committed settings only, so it holds
    // in CI and does not depend on this machine.
    const project = join(ROOT, ".claude", "settings.json");
    expect(existsSync(project)).toBe(true);

    const hits = settingsCommands([readFileSync(project, "utf-8")]).filter(c =>
      c.includes("AgentBriefGuard.hook.ts"),
    );
    expect(hits.length, "AgentBriefGuard is not registered at project scope after all").toBe(1);
    expect(registrationTree(hits[0])).toBe("rungate");

    // And it resolves to a file that is there — a registration naming a
    // handler that does not exist is a command line failing on every spawn.
    expect(existsSync(join(RUNGATE_HOOKS, "AgentBriefGuard.hook.ts"))).toBe(true);
  });

  test("the inventory agrees it is project-scoped, which is why #479 already guards it", () => {
    // The reason this file adds no registration check for it: the declaration
    // says `scope: "project"`, so #479's live reconciliation reports
    // `unregistered` the moment `.claude/settings.json` stops naming it. If
    // this ever flips to `user`, that guard silently stops applying and the
    // hook can go dark again — which is the failure this case watches for.
    const decl = (
      JSON.parse(readFileSync(join(ROOT, ".claude", "rungate", "hooks.json"), "utf-8")) as {
        name?: string;
        enabled?: boolean;
        scope?: string;
      }[]
    ).find(h => h.name === "AgentBriefGuard");

    expect(decl, "AgentBriefGuard is not declared in .claude/rungate/hooks.json at all").toBeDefined();
    expect(decl!.enabled).toBe(true);
    expect(
      decl!.scope,
      "AgentBriefGuard is no longer project-scoped, so #479's reconciliation no longer covers it " +
        "and nothing checks that it is registered",
    ).toBe("project");
  });
});
