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

import { loadRungateConfig } from "../lib/config-loader";
import {
  type RegistrationScope,
  type ScopeReading,
  IncompleteScopeReadingError,
  REGISTRATION_SCOPES,
  readRegistrationScopes,
  settingsScopePaths,
} from "../lib/hook-scopes";
import {
  type EnvReading,
  pathSpelling,
  readEnvScopes,
  registeredTreeCensus,
  resolvePath,
  settingsEnv,
} from "../lib/hook-target-tree";
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
  // #713's migration of the PRODUCT-classified hooks adds seven names to this
  // list ON PURPOSE, and the count going from 8 to 15 is the honest reading of
  // what that migration does rather than a regression it hides.
  //
  // A duplicate here means "this name exists in both trees". Before the
  // migration these seven existed ONLY in `~/.pai/hooks`, so the repo could
  // not test them, could not publish them, and could not fix them — which is
  // the condition #713 was filed about. Bringing them into `hooks/` is what
  // makes them duplicates, and the duplicate is strictly better than the
  // absence it replaces.
  //
  // Clearing them is the OTHER half of #713 and is deliberately not done here:
  // the `.pai` copies carry `uchg` and are refused by a live PreToolUse guard
  // (SC-4, still not met), and re-pointing the registrations is a write to
  // `~/.claude/settings.json`, a file this repo does not own. This entry is
  // not a waiver of that work — the ratchet refuses in BOTH directions, so
  // deleting a `.pai` copy without lowering this list in the same commit
  // fails, which is exactly the pressure that should exist.
  "ActionVerificationGate",
  "BashWriteGuard",
  "DocHygiene",
  "GateResultProtection",
  "HarnessAFKGate",
  "SkillGuard",
  "TeamInit",
] as const;

/**
 * The path VARIABLES through which a registration on this machine resolves to
 * a directory outside this checkout, measured 2026-10-21 with
 *
 *   /usr/bin/python3 -I -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude/settings.json')))['env']['RUNGATE_HOOKS_DIR'])"
 *
 * **What the entry means.** `~/.claude/settings.json` defines
 * `RUNGATE_HOOKS_DIR` as a checkout that is not this one, and both that file
 * and this repo's own `.claude/rungate/hooks.json` register through it. So
 * the hooks that run are a different tree's bytes, and PR #999's
 * shell-injection fix to `hooks/ProjectStateSync.hook.ts` has not reached
 * them — the registered copy still carries the `execSync` template literal.
 *
 * Repointing the variable at this checkout is Jason's, one line in a file the
 * repo does not own, and it is NOT what this entry waives: the ratchet
 * refuses in BOTH directions, so a second misdirected spelling fails and
 * clearing this one without deleting the entry in the same commit fails too.
 *
 * Keyed on the variable and not on the resolved directory, which is a machine
 * path, nor on the hook names, of which there are thirty behind this one
 * fact.
 */
const FOREIGN_SPELLING_RATCHET: string[] = ["RUNGATE_HOOKS_DIR", "PAI_HOOKS_DIR"];

/**
 * `PAI_HOOKS_DIR` banked by #713's migration, measured 2026-10-21 by parsing
 * `~/.claude/settings.json` rather than grepping it.
 *
 * **What it costs, stated plainly.** The seven hooks #713 migrated are
 * registered in user settings as `${PAI_HOOKS_DIR}/<Name>.hook.ts`, which
 * resolves into `~/.pai/hooks`. So for those seven, the bytes this repository
 * now tests and publishes are NOT the bytes that execute on this machine —
 * every case in `test/product-hook-migration.test.ts` is green against a copy
 * no live session reaches. That is the same defect #999 hit on
 * `ProjectStateSync`, where a merged security fix never reached the running
 * code, and it is worth being blunt that the migration does not fix it.
 *
 * **Why the entry is nevertheless correct rather than a dodge.** Before this
 * PR those seven files were outside the repository altogether, so the gap was
 * total and invisible. Now the repo owns a tested, published copy and this
 * line names the remaining distance. Closing it is one line in
 * `~/.claude/settings.json` — a file this repo does not own, under a standing
 * do-not-touch while `~/.pai/hooks` holds `uchg` flags and orphaned staged
 * work (`cd24a91e`, tag `orphaned-staged-20261021`).
 *
 * Keyed on the VARIABLE, like the entry above it, because the resolved
 * directory is a machine path and there are nine hook names behind this one
 * fact. The ratchet refuses in both directions, so re-pointing the variable
 * without deleting this entry in the same commit fails.
 */

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

/**
 * Every settings document this run can read, with the scopes it could not
 * named.
 *
 * The scope list is `settingsScopePaths`', not this file's. It used to be a
 * three-entry literal here, and #910 is what a second opinion about which
 * scopes exist costs: a census read a different, narrower set and reported
 * confident absence. `~/.claude/settings.local.json` was missing from this
 * list and is on the author's machine.
 */
function readableScopes(): { docs: string[]; names: string[]; missing: string[] } {
  const docs: string[] = [];
  const names: string[] = [];
  const missing: string[] = [];
  for (const { scope, path } of settingsScopePaths(ROOT, homedir())) {
    if (!existsSync(path)) { missing.push(scope); continue; }
    docs.push(readFileSync(path, "utf-8"));
    names.push(scope);
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
    ).toContain("project-settings");

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

/**
 * #981 — `wrongTreeViolations` selected by substring, so a string that merely
 * MENTIONED a hook was classified as a registration of it.
 *
 * The fix is deliberately NOT "reuse `executedHookFile`", and the issue says
 * so in as many words. The error directions at the two call sites are
 * opposite: for `hookRegistration` an over-broad match is a guard reporting
 * clean about its own subject (#910), while here a narrow parse would
 * SILENTLY STOP REPORTING a hook genuinely wired to the superseded `.pai`
 * tree, which is #713 entire. So selection stays over-broad and nothing is
 * dropped; what changed is that a selected string is now CLASSIFIED by the
 * argv parse, into a third reading — `unparsed` — instead of being described
 * as a registration naming neither tree.
 *
 * Every case below says which reading it is about, and the escapes the fix
 * does NOT close are asserted as cases rather than left in prose, so the
 * `WHAT THIS DOES NOT COVER` block in `lib/hook-trees.ts` cannot drift from
 * the code without a red.
 *
 * ## What was broken to prove these can fail
 *
 * Run over this file + `test/hook-shell-injection.test.ts` (32 tests). Every
 * count predicted before the battery ran, and **the baseline row read first.**
 * Each row names the CASES it reddens.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 32 pass, 0 fail | **32 pass, 0 fail** | — |
 * | M6 the genuinely pre-#981 body — substring selection, whole-command classification, two readings | 4 | **4 of 32** — AC-1, AC-4, AC-5, AC-7 | `# TestSuiteRelease.hook.ts`: the original reads `unparsed`, the pre-#981 body reads `unknown` and says *"is registered by a command naming neither tree's path variable"* about a comment |
 * | M7 **the cheapest wrong fix, which is the one #981 exists to refuse**: select with the parse and DROP what it rejects | 5 | **5 of 32** — AC-1, AC-2, AC-5, AC-6, AC-7 | the same comment: the original reports one reading, the mutant reports none |
 * | M8 the tree read off the whole command again, selection unchanged | 1 | **1 of 32** — AC-4 | `bun ${PAI_HOOKS_DIR}/IssueCloseGuard.hook.ts # superseded, cf ${RUNGATE_HOOKS_DIR}`: the original reports `pai`, the mutant reports nothing |
 *
 * **M7 is the row that matters, and AC-2 is the assertion that owns it.** The
 * one-line generalisation makes the noise go away and converts this site's
 * error direction from loud to silent — a hook genuinely wired to the
 * superseded tree in a spelling the parse cannot read would stop being
 * reported, which is #713 entire. AC-3 and AC-4 stay GREEN under it, because
 * an ordinary `.pai` registration still parses; only a case asserting that a
 * REJECT is still reported can see it.
 *
 * **M8 is 1 and that is the point of splitting it out.** The whole-command
 * classification is a second over-broad substring one level below the one
 * #981 names, and no case in this file other than AC-4 can tell the two
 * halves of the fix apart.
 *
 * None of the three mutations is left in the tree; all were applied and
 * reverted, and `lib/hook-trees.ts` was confirmed byte-identical to the
 * measured source afterwards by sha256.
 */
describe("#981: a string that MENTIONS a hook is not a registration of it", () => {
  const COMMENT = "# TestSuiteRelease.hook.ts";
  const LATER_SEGMENT = "bun run x.ts && cat TestSuiteRelease.hook.ts";

  test("AC-1: a comment is reported as 'unparsed', not as a tree violation", () => {
    // WITNESS. On the pre-#981 binding both of these came back
    // `tree: "unknown"` with the detail *"registered by a command naming
    // neither tree's path variable"* — a sentence about a string that is not
    // a registration at all.
    const v = wrongTreeViolations(["TestSuiteRelease"], [COMMENT, LATER_SEGMENT]);
    expect(v.map(x => x.tree), "a mention was still classified as a tree").toEqual([
      "unparsed",
      "unparsed",
    ]);
    for (const x of v) {
      expect(
        x.detail,
        "the detail still describes a mention as a registration",
      ).not.toContain("is registered by a command");
      expect(x.detail).toContain("not a command that executes it");
    }
  });

  test("AC-2: it is still REPORTED — dropping it is the direction that goes silent", () => {
    // The whole argument of #981. The cheapest wrong fix is to select with
    // `executedHookFile` and drop whatever it rejects; that is one line, it
    // makes the noise disappear, and it converts this site's error direction
    // from loud to silent. This case is RED under that fix.
    expect(
      wrongTreeViolations(["TestSuiteRelease"], [COMMENT]).length,
      "a string naming the hook was dropped rather than reported, so absence now reads as clean",
    ).toBe(1);
  });

  test("AC-3: a .pai registration is still reported, which the narrowing must not cost", () => {
    // The positive control for the witness above. Without it, AC-1 and AC-2
    // are satisfied by a binding that reports everything as `unparsed`.
    const v = wrongTreeViolations(["IssueCloseGuard"], settingsCommands([PAI_DOC("IssueCloseGuard")]));
    expect(v.map(x => x.tree)).toEqual(["pai"]);
  });

  test("AC-4: the TREE is read off the executed path, not off a word in a comment", () => {
    // The recursion question, asked of the fix itself. `registrationTree`
    // decides by substring too, so handing it the WHOLE command let a
    // `${RUNGATE_HOOKS_DIR}` in a trailing comment classify a genuine `.pai`
    // registration as rungate — and rungate is the arm that `continue`s.
    // Pre-#981 this pair returned NOTHING: a real wrong-tree registration,
    // silenced by a word nobody executes. That is #981's own warned direction
    // arriving one level down, so it is closed here rather than filed.
    const v = wrongTreeViolations(
      ["IssueCloseGuard"],
      ["bun ${PAI_HOOKS_DIR}/IssueCloseGuard.hook.ts # superseded, cf ${RUNGATE_HOOKS_DIR}"],
    );
    expect(
      v.map(x => x.tree),
      "a comment naming the rungate root made a .pai registration disappear",
    ).toEqual(["pai"]);
    expect(v[0].detail).toContain("superseded");
  });

  test("AC-5: a first segment executing a DIFFERENT hook is reported, never dropped", () => {
    // The input that makes "drop whatever the parse rejects" unsafe, stated
    // as a case. `executedHookFile` truncates at `&&`, so it reads
    // `other.hook.ts` and is CONFIDENT about it — and the real `.pai`
    // registration is in the segment it never looked at. A conclusive
    // reading of the wrong segment is still the wrong segment, so the
    // reading is `unparsed` and the string is reported.
    const v = wrongTreeViolations(
      ["IssueCloseGuard"],
      ["bun /x/other.hook.ts && bun ${PAI_HOOKS_DIR}/IssueCloseGuard.hook.ts"],
    );
    expect(v.map(x => x.tree)).toEqual(["unparsed"]);
    expect(
      v[0].detail,
      "the reading does not say what the parse read instead, so nobody can triage it",
    ).toContain("the first command executes other.hook.ts");
  });

  test("AC-6: WHAT THIS DOES NOT COVER — the two escapes that are not selected at all", () => {
    // Both are UNDER-reports and both are stated in the binding's docblock.
    // They are asserted here so the stated limit and the code cannot drift:
    // a string that does not contain `<hook>.hook.ts` cannot be selected by
    // any reading of these commands, and recovering it needs a shell.
    expect(
      wrongTreeViolations(["IssueCloseGuard"], ['HOOK=IssueCloseGuard.hook.ts; bun "${PAI_HOOKS_DIR}/$HOOK"']),
      "the variable-built path case changed behaviour without the docblock changing",
    ).toHaveLength(1); // selected only because the assignment spells the name
    expect(
      wrongTreeViolations(["IssueCloseGuard"], ["bun ${PAI_HOOKS_DIR}/run-the-hook.sh"]),
      "a wrapper script that never names the hook is not selected, and must not be",
    ).toEqual([]);
  });

  test("AC-7: WHAT THIS DOES NOT COVER — a quoted sh -c is reported, not classified", () => {
    // Selected, because the string contains the name; `unparsed`, because the
    // quoting is not unwrapped. Loud, which is the direction this site is
    // allowed to be wrong in.
    const v = wrongTreeViolations(["IssueCloseGuard"], ['sh -c "bun ${PAI_HOOKS_DIR}/IssueCloseGuard.hook.ts"']);
    expect(v.map(x => x.tree)).toEqual(["unparsed"]);
    expect(v[0].detail).toContain("no executed hook file could be read from it");
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

/**
 * #713 point 4, the half #778 and #970 left open: **the tree the settings
 * register is the tree the repo tests.**
 *
 * ## What the earlier waves closed, and the input they cannot see
 *
 * #778 shipped `hookTreeCensus` (two directories, duplicate names) and
 * `wrongTreeViolations` (which ROOT a registration is spelled with). #970
 * shipped `lib/hook-scopes.ts`, so no verdict can come out of a reading short
 * of every scope. All three decide by SPELLING, and that is the dimension the
 * issue's last comment attached a cost to.
 *
 * `~/.claude/settings.json` on the author's machine defines
 * `RUNGATE_HOOKS_DIR` as a checkout that is **not this one**, and registers
 * fourteen hook commands through it. Every existing check reads
 * `${RUNGATE_HOOKS_DIR}/X.hook.ts` as `"rungate"` and is satisfied — the live
 * case above is literally titled *"every hook this repo owns is wired to this
 * repo's copy"* and it passes. Nothing resolves the variable.
 *
 * The cost, measured 2026-10-21 and not hypothesised: PR #999 merged a
 * shell-injection fix into `hooks/ProjectStateSync.hook.ts`, replacing an
 * `execSync` template literal carrying tool input with an argv
 * `execFileSync`. `git show origin/main:hooks/ProjectStateSync.hook.ts`
 * carries it. The file the registration RESOLVES to still carries the
 * `execSync` form. **A merged security fix did not reach the code that runs,
 * and the suite was green through it.**
 *
 * So this block asks the question none of the three bindings above can be
 * asked: given the variables the machine actually defines, which DIRECTORY
 * does each registration name?
 *
 * ## The three fail-opens, and why the third needed a field inventing
 *
 * | the silent pass | the reading instead |
 * |---|---|
 * | a variable nothing defines, assumed to mean this repo | `unresolved` → UNMEASURED |
 * | a scope nobody opened, counted as registering nothing | UNMEASURED, scope named |
 * | **zero registrations examined** | UNMEASURED — zero trees compared is not agreement |
 *
 * The third has no analogue in `hookTreeCensus` and no natural assertion:
 * `foreign.length === 0` is the same value for a correctly wired tree and for
 * a run that opened nothing. `examined` exists so the two are
 * distinguishable, and AC-R4 is the pair that varies only that.
 *
 * ## Deliberately NOT done, and why each alternative is worse
 *
 * - **Deploying the fixed tree to the registered path.** That directory holds
 *   orphaned staged work preserved as `cd24a91e` / tag
 *   `orphaned-staged-20261021`, under a standing do-not-touch. This issue
 *   asks for a CHECK, and a deployment would also destroy the evidence.
 * - **Teaching `registrationTree` about the resolved path.** It answers
 *   *which root is this spelled with* — a real question with four cases
 *   above. Folding a second question into it makes one binding no mutation
 *   can attribute (#484).
 * - **Banking the resolved directory, or the hook names.** A machine path in
 *   a committed file is wrong on the next machine; a hook-name list churns on
 *   every hook added. Thirty registrations behind one misdirected variable
 *   are ONE fact, so the ratchet keys on the VARIABLE.
 *
 * ## SC-4 and SC-5 are still not met, and this does not pretend otherwise
 *
 * Unchanged from #778: the eight `.pai` copies carry `uchg`, and the two
 * `.tmp` files are refused by a live PreToolUse guard — which refused one of
 * this session's own writes, so it is working. Both need Jason's hands.
 * Nothing below touches either.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Add `${RUNGATE_HOOKS_DIR}` to a list of roots that count as this repo.**
 * One line; it is what `RUNGATE_ROOTS` in `lib/hook-trees.ts` already does,
 * and it is the exact state in which #999 went nowhere. Every case below is
 * red under it, because not one of them matches a spelling — each drives
 * `resolvePath` or `registeredTreeCensus`, which compare directories. AC-R1
 * asserts the two readings DISAGREE on one input, so widening a root list
 * cannot satisfy it: the disagreement is the assertion.
 *
 * A second repair worth naming because it is quieter: **resolve
 * `${CLAUDE_PROJECT_DIR}` to the repo root in every scope.** It removes a
 * refusal and reads as a simplification. AC-R6 is the pair that varies only
 * the scope and goes red under it.
 *
 * ## What was broken to prove these can fail
 *
 * Run over this file + `test/hook-registration-evidence.test.ts` (59 tests).
 * Every count predicted in `/tmp/713-battery/predictions.md` before the
 * battery ran, naming **which cases** each row should redden rather than only
 * how many — and **the baseline row read first**, because an instrument that
 * has stopped reporting takes the baseline down with it. Every mutation is to
 * `lib/hook-target-tree.ts`.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 59 pass, 0 fail | **59 pass, 0 fail** | — |
 * | M1 **the cheapest wrong fix, APPLIED**: `${RUNGATE_HOOKS_DIR}` and `${CLAUDE_PROJECT_DIR}/hooks` accepted by SPELLING, pushed `in-repo` unresolved | 5 — AC-R1, AC-R3, AC-R6, AC-R7, live | **5 of 59**, those five | `bun ${RUNGATE_HOOKS_DIR}/ProjectStateSync.hook.ts` with the variable pointing outside the checkout: the original reads `foreign` and names the directory, the mutant reads `in-repo` |
 * | M2 the second wrong fix: `PROJECT_DIR_SCOPES` widened to every scope | 1 — AC-R6 | **1 of 59**, AC-R6 | the same `${CLAUDE_PROJECT_DIR}` command in `user-settings`: original `unresolved`/UNMEASURED, mutant `in-repo`/MEASURED |
 * | M3 the `examined === 0` refusal removed | 1 — AC-R4 | **1 of 59**, AC-R4 | a scope registering only a hook this repo does not own: original UNMEASURED, mutant MEASURED with an empty violation list |
 * | M4 unresolved readings no longer raise the reading | 3 — AC-R3, AC-R6, AC-R7 | **3 of 59**, those three | an undefined `RUNGATE_HOOKS_DIR`: original UNMEASURED carrying a reason, mutant MEASURED carrying none |
 * | M5 the env `assertEveryScopeRead` call removed | 1 — AC-R8 | **1 of 59**, AC-R8 | an env reading covering one scope: original throws `IncompleteScopeReadingError`, mutant returns a verdict |
 * | M6 a variable with two values takes the first | 1 — AC-R7 | **1 of 59**, AC-R7 | `RUNGATE_HOOKS_DIR` defined as the repo's hooks dir in one scope and another checkout in a second: original UNMEASURED, mutant `in-repo` |
 * | M7 `settingsEnv` catches the parse error and returns `{}` | 1 — AC-R9 | **1 of 59**, AC-R9 | `"{not json"`: original throws, mutant returns `{}`, so a corrupt file reads as one defining nothing |
 * | M8 the unreadable-scope reasons loop removed | 1 — AC-R5 | **1 of 59**, AC-R5 | `user-settings` unreadable beside a clean project-scope reading: original UNMEASURED, mutant MEASURED |
 *
 * **Every row matched, which this repo's own rule says to distrust** — a
 * battery that agrees with its author is the shape a battery that never ran
 * also has. Two things make these readings rather than agreement: each row
 * predicted the NAMED cases and not just a count, and all eight name an input
 * on which mutant and original differ, run rather than described. M1 in
 * particular is the wrong fix applied against the real binding, not a
 * sentence about it, and the live case is among its five.
 *
 * **The live reading, measured 2026-10-21 on the author's machine**:
 * `MEASURED`, 37 registrations examined, 4 `in-repo`, **33 `foreign`**, 0
 * unresolved, every foreign one reached through `RUNGATE_HOOKS_DIR` and
 * landing in a single directory outside this checkout. That is what
 * `FOREIGN_SPELLING_RATCHET` banks, and it is the number the ratchet refuses
 * to let move in either direction.
 *
 * None of the eight mutations is left in the tree. All were applied and
 * reverted from a `cp` backup, never `git checkout --`, and
 * `lib/hook-target-tree.ts` was confirmed byte-identical to the measured
 * source afterwards by sha256.
 */
describe("#713 point 4: the tree the settings REGISTER is the tree the repo TESTS", () => {
  const ALL: RegistrationScope[] = [...REGISTRATION_SCOPES];
  const REPO = "/repo";
  const OTHER_CHECKOUT = "/elsewhere/rungate/hooks";

  /** A complete command reading. Any scope not named registers nothing. */
  const cmds = (per: Partial<Record<RegistrationScope, string[] | null>>): ScopeReading[] =>
    ALL.map(scope => {
      const c = scope in per ? per[scope] : [];
      return c === null || c === undefined
        ? { scope, commands: null, unreadable: `${scope} is unreadable in this fixture` }
        : { scope, commands: c };
    });

  /** A complete env reading. Any scope not named defines nothing. */
  const envs = (
    per: Partial<Record<RegistrationScope, Record<string, string> | null>>,
  ): EnvReading[] =>
    ALL.map(scope => {
      const e = scope in per ? per[scope] : {};
      return e === null || e === undefined
        ? { scope, env: null, unreadable: `${scope} is unreadable in this fixture` }
        : { scope, env: e };
    });

  const RG = (name: string) => `bun \${RUNGATE_HOOKS_DIR}/${name}.hook.ts`;

  test("AC-R1: a root SPELLED rungate that RESOLVES elsewhere is foreign, while the spelling check calls it fine", () => {
    // THE WITNESS, and the assertion is the DISAGREEMENT rather than either
    // verdict alone. One command, two bindings, opposite answers:
    // `registrationTree` reports the tree this repo owns and
    // `wrongTreeViolations` reports nothing to look at, while the resolved
    // reading reports a directory outside the checkout. A reader who widens a
    // root list cannot make this pass — there is no root list in it.
    const command = RG("ProjectStateSync");

    expect(
      registrationTree(command),
      "the spelling check stopped calling this rungate, so the disagreement this case is about " +
        "no longer exists and the case is measuring nothing",
    ).toBe("rungate");
    expect(
      wrongTreeViolations(["ProjectStateSync"], [command]),
      "the spelling check started reporting this, which it cannot honestly do — it has no way to " +
        "know where the variable points",
    ).toEqual([]);

    const census = registeredTreeCensus(
      ["ProjectStateSync"],
      cmds({ "user-settings": [command] }),
      envs({ "user-settings": { RUNGATE_HOOKS_DIR: OTHER_CHECKOUT } }),
      REPO,
    );

    expect(census.reading).toBe("MEASURED");
    expect(census.examined).toBe(1);
    expect(census.foreign.map(f => f.hook)).toEqual(["ProjectStateSync"]);
    expect(census.foreign[0].resolved).toBe(`${OTHER_CHECKOUT}/ProjectStateSync.hook.ts`);
    expect(
      census.foreign[0].detail,
      "the violation does not say that merged code never reaches the file, which is the whole " +
        "cost and the only part that makes it actionable",
    ).toContain("Nothing merged into this repository reaches that file");
  });

  test("AC-R2: the POSITIVE control — the same spelling pointing INTO the repo is clean", () => {
    // Without this, AC-R1 is satisfied by a binding that reports every
    // registration as foreign. The pair varies exactly one thing: the VALUE
    // of `RUNGATE_HOOKS_DIR`. Same command, same scope, same owned list.
    const census = registeredTreeCensus(
      ["ProjectStateSync"],
      cmds({ "user-settings": [RG("ProjectStateSync")] }),
      envs({ "user-settings": { RUNGATE_HOOKS_DIR: `${REPO}/hooks` } }),
      REPO,
    );

    expect(census.reading).toBe("MEASURED");
    expect(census.examined).toBe(1);
    expect(census.foreign).toEqual([]);
    expect(census.inRepo.map(r => r.hook)).toEqual(["ProjectStateSync"]);
  });

  test("AC-R3: a variable nothing defines is UNRESOLVED, never 'this repo'", () => {
    // Fail-open one. An undefined variable is the state CI is in, and the
    // tempting reading is that `${RUNGATE_HOOKS_DIR}` obviously means the
    // rungate checkout, which is this one. It does not obviously mean
    // anything: a variable with no value names no directory.
    const census = registeredTreeCensus(
      ["ProjectStateSync"],
      cmds({ "user-settings": [RG("ProjectStateSync")] }),
      envs({}),
      REPO,
    );

    expect(census.reading).toBe("UNMEASURED");
    expect(census.inRepo, "an unresolved path was counted as this repo's copy").toEqual([]);
    expect(census.foreign, "an unresolved path was counted as a violation").toEqual([]);
    expect(census.unresolved.map(r => r.hook)).toEqual(["ProjectStateSync"]);
    expect(census.unmeasuredReasons.join(" ")).toContain("RUNGATE_HOOKS_DIR is not defined");
    expect(
      census.unmeasuredReasons.join(" "),
      "the reason does not say why an unresolved path is not a clean reading",
    ).toContain("no reading at all");
  });

  test("AC-R4: ZERO registrations examined is UNMEASURED — zero trees compared is not agreement", () => {
    // Fail-open three, and the one with no natural assertion. The pair varies
    // exactly one thing against the clean reading: whether any command naming
    // an owned hook exists at all. `foreign` is `[]` in BOTH, which is the
    // problem — so the two lists are asserted EQUAL and the discriminators
    // are asserted to differ, rather than each being checked on its own.
    const clean = registeredTreeCensus(
      ["ProjectStateSync"],
      cmds({ "user-settings": [RG("ProjectStateSync")] }),
      envs({ "user-settings": { RUNGATE_HOOKS_DIR: `${REPO}/hooks` } }),
      REPO,
    );
    const nothing = registeredTreeCensus(
      ["ProjectStateSync"],
      cmds({ "user-settings": ["bun ${RUNGATE_HOOKS_DIR}/SomethingElse.hook.ts"] }),
      envs({ "user-settings": { RUNGATE_HOOKS_DIR: `${REPO}/hooks` } }),
      REPO,
    );

    expect(
      nothing.foreign,
      "the two readings differ in their violation lists, so this pair varies more than one thing " +
        "and proves nothing about the empty case",
    ).toEqual(clean.foreign);
    expect(nothing.examined).toBe(0);
    expect(clean.examined).toBe(1);
    expect(nothing.reading).toBe("UNMEASURED");
    expect(clean.reading).toBe("MEASURED");
    expect(nothing.unmeasuredReasons.join(" ")).toContain(
      "Zero trees compared is not perfect agreement",
    );
  });

  test("AC-R5: an unreadable machine scope is UNMEASURED even when every reading taken was clean", () => {
    // Fail-open two, and the state CI is in: no runner has a
    // `~/.claude/settings.json`. Everything this run COULD read resolves into
    // the repo, and that is still not a verdict — the scope that defines the
    // variable on the author's machine is the one that could not be opened.
    const census = registeredTreeCensus(
      ["AgentBriefGuard"],
      cmds({
        "project-settings": ["bun ${CLAUDE_PROJECT_DIR}/hooks/AgentBriefGuard.hook.ts"],
        "user-settings": null,
      }),
      envs({ "user-settings": null }),
      REPO,
    );

    expect(census.inRepo.map(r => r.hook)).toEqual(["AgentBriefGuard"]);
    expect(census.foreign).toEqual([]);
    expect(
      census.reading,
      "every reading taken was clean and the run called that a measurement — which is the reading " +
        "CI would produce for a tree wired entirely to another checkout",
    ).toBe("UNMEASURED");
    expect(census.unmeasuredReasons.join(" ")).toContain("user-settings");
  });

  test("AC-R6: CLAUDE_PROJECT_DIR is this repo in a scope the repo owns, and SESSION STATE in a machine scope", () => {
    // The second cheapest wrong fix, as a pair. Resolving it to the repo root
    // everywhere removes a refusal and reads as a simplification — and it
    // turns a user-scope registration that may execute ANY checkout into a
    // confident `in-repo`. The halves vary only the scope: identical command,
    // identical env, identical owned list.
    const command = "bun ${CLAUDE_PROJECT_DIR}/hooks/AgentBriefGuard.hook.ts";

    const project = registeredTreeCensus(
      ["AgentBriefGuard"],
      cmds({ "project-settings": [command] }),
      envs({}),
      REPO,
    );
    const user = registeredTreeCensus(
      ["AgentBriefGuard"],
      cmds({ "user-settings": [command] }),
      envs({}),
      REPO,
    );

    expect(project.inRepo.map(r => r.resolved)).toEqual([`${REPO}/hooks/AgentBriefGuard.hook.ts`]);
    expect(project.reading).toBe("MEASURED");

    expect(
      user.unresolved.map(r => r.hook),
      "a user-scope CLAUDE_PROJECT_DIR was resolved to this repository, so a hook that executes " +
        "whichever checkout the session started in now reads as this one",
    ).toEqual(["AgentBriefGuard"]);
    expect(user.reading).toBe("UNMEASURED");
    expect(user.unmeasuredReasons.join(" ")).toContain("session state");
  });

  test("AC-R7: a variable with two different values is UNRESOLVED, not a precedence guess", () => {
    // Picking a winner means encoding an order nobody wrote down, and being
    // wrong about it produces a confident path — the thing this block exists
    // to stop. The control beside it is the SAME variable defined twice with
    // the SAME value, which is agreement and must still resolve: a refusal
    // that fires on agreement is a check nobody can satisfy.
    const conflict = registeredTreeCensus(
      ["ProjectStateSync"],
      cmds({ "user-settings": [RG("ProjectStateSync")] }),
      envs({
        "user-settings": { RUNGATE_HOOKS_DIR: `${REPO}/hooks` },
        "user-local-settings": { RUNGATE_HOOKS_DIR: OTHER_CHECKOUT },
      }),
      REPO,
    );
    const agreeing = registeredTreeCensus(
      ["ProjectStateSync"],
      cmds({ "user-settings": [RG("ProjectStateSync")] }),
      envs({
        "user-settings": { RUNGATE_HOOKS_DIR: `${REPO}/hooks` },
        "user-local-settings": { RUNGATE_HOOKS_DIR: `${REPO}/hooks` },
      }),
      REPO,
    );

    expect(conflict.reading).toBe("UNMEASURED");
    expect(conflict.unresolved.map(r => r.hook)).toEqual(["ProjectStateSync"]);
    expect(conflict.unmeasuredReasons.join(" ")).toContain("defined 2 times with different values");
    expect(
      agreeing.reading,
      "two scopes AGREEING about a variable was refused, which makes every real machine " +
        "unmeasurable and the check a thing nobody can satisfy",
    ).toBe("MEASURED");
    expect(agreeing.inRepo).toHaveLength(1);
  });

  test("AC-R8: a reading short of every scope is REFUSED, and the env half is refused too", () => {
    // Both readings go through `assertEveryScopeRead`, #970's one binding for
    // what complete means. The env half is the one that would silently
    // acquire a narrower scope list, because a variable defined in a scope
    // nobody read is indistinguishable from a variable nobody defined — and
    // only the first of those is innocent.
    expect(() =>
      registeredTreeCensus(["X"], [{ scope: "user-settings", commands: [] }], envs({}), REPO),
    ).toThrow(IncompleteScopeReadingError);

    expect(
      () => registeredTreeCensus(["X"], cmds({}), [{ scope: "user-settings", env: {} }], REPO),
      "an env reading covering one scope produced a verdict, so a variable defined in a scope " +
        "nobody opened reads as a variable nobody defined",
    ).toThrow(IncompleteScopeReadingError);

    // An unreadable env scope with no reason is refused as well: an
    // unreadable scope and a scope nobody opened produce the same empty
    // reading, and which happened is the whole question.
    expect(() =>
      registeredTreeCensus(
        ["X"],
        cmds({}),
        ALL.map(scope => ({ scope, env: null })),
        REPO,
      ),
    ).toThrow(IncompleteScopeReadingError);
  });

  test("AC-R9: a settings document that does not parse THROWS, and a non-string value is dropped", () => {
    // Same reason `settingsCommands` throws. Swallowing a corrupt file turns
    // every variable it defines into `unresolved` — a refusal, but for a
    // reason nobody can act on, and indistinguishable from a file defining
    // nothing.
    expect(() => settingsEnv("{not json")).toThrow();
    expect(settingsEnv('{"hooks":{}}'), "an absent env block invented variables").toEqual({});
    expect(
      settingsEnv('{"env":{"A":"/x","B":3,"C":null}}'),
      "a non-string value was coerced into a path fragment",
    ).toEqual({ A: "/x" });
  });

  test("AC-R10: the SPELLING a foreign target is reached through is what a ratchet can key on", () => {
    // Not the resolved directory — a machine path in a committed file is
    // wrong on the next machine. Not the hook name — thirty registrations
    // behind one misdirected variable are one fact. `pathSpelling` is the
    // binding the live case below banks against.
    expect(pathSpelling("${RUNGATE_HOOKS_DIR}/X.hook.ts")).toBe("RUNGATE_HOOKS_DIR");
    expect(pathSpelling("$PAI_HOOKS_DIR/X.hook.ts")).toBe("PAI_HOOKS_DIR");
    expect(pathSpelling("/Users/someone/hooks/X.hook.ts")).toBe("literal");

    // A relative path is unresolved rather than joined to something: which
    // directory it names depends on whatever spawns the hook.
    const rel = resolvePath("hooks/X.hook.ts", {}, null);
    expect(rel.kind).toBe("unresolved");
    expect(rel.kind === "unresolved" && rel.reason).toContain("not absolute");
  });

  test("the live reading: every registration on THIS machine, resolved rather than spelled", () => {
    // Machine state, and the case that makes CI witness the subject rather
    // than skip it. On a runner `~/.claude/settings.json` does not exist, the
    // reading is UNMEASURED, and the refusal is asserted. On a machine that
    // has one, the ratchet holds the line in both directions.
    const readIfPresent = (p: string): string | null =>
      existsSync(p) ? readFileSync(p, "utf-8") : null;
    const registry = (loadRungateConfig(ROOT) as { hooks: { command?: string }[] }).hooks.map(h =>
      String(h?.command ?? h),
    );
    expect(
      registry.length,
      "the loader resolved no hook entries, so this compares nothing",
    ).toBeGreaterThan(0);

    const owned = ownedHooks();
    expect(owned.length, "this repo owns no hooks, so the scan compares nothing").toBeGreaterThan(
      10,
    );

    const census = registeredTreeCensus(
      owned,
      readRegistrationScopes(ROOT, homedir(), readIfPresent, registry),
      readEnvScopes(ROOT, homedir(), readIfPresent),
      ROOT,
    );

    if (census.reading === "UNMEASURED") {
      expect(
        census.unmeasuredReasons.length,
        "the reading is UNMEASURED and says nothing about why, which is a refusal nobody can act on",
      ).toBeGreaterThan(0);
      expect(
        census.foreign,
        "an UNMEASURED run reported violations, so somebody could read a count off a reading that " +
          "was never taken",
      ).toEqual([]);
      return;
    }

    const seen = [...new Set(census.foreign.map(f => f.spelling))].sort();
    const appeared = seen.filter(s => !FOREIGN_SPELLING_RATCHET.includes(s));
    const cleared = FOREIGN_SPELLING_RATCHET.filter(s => !seen.includes(s));

    expect(
      appeared,
      `a registration of a hook this repo owns resolves OUTSIDE ${join(ROOT, "hooks")} through a ` +
        `path this file has not banked: ${appeared.join(", ")}. Nothing merged here reaches those ` +
        `files. Either point the variable at this checkout, or add it to ` +
        `FOREIGN_SPELLING_RATCHET in this file saying what it costs.\n` +
        census.foreign
          .filter(f => appeared.includes(f.spelling))
          .map(f => `  ${f.hook} [${f.scope}] — ${f.detail}`)
          .join("\n"),
    ).toEqual([]);

    expect(
      cleared,
      `${cleared.join(", ")} no longer resolves outside this repository — remove it from ` +
        `FOREIGN_SPELLING_RATCHET in this file, in the same commit that fixed it. A ratchet ` +
        `nobody lowers is a number nobody can interpret ` +
        `(.claude/rules/checks-must-be-able-to-fail.md).`,
    ).toEqual([]);
  });
});
