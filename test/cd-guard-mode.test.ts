/**
 * #992 — the guard can WARN, it is scoped, and the rung has now been chosen.
 *
 * ## The decision, and what moved in this file
 *
 * #1040 built the ladder and took no rung: `warn` was the default and
 * `block` was opt-in, so the choice would be configuration rather than a
 * code change made under pressure. **Jason chose `block`** and the hook is
 * registered at project scope. Three arms inverted here and they are the
 * whole diff worth reading:
 *
 * - AC-1 / AC-2: the default rung is `block`, including for an unrecognised
 *   value, which moves the "err toward refusal" direction into the mode.
 * - AC-3: the default REFUSES; `warn` became the opt-in and keeps its own
 *   case, because the rung has to stay reachable for the decision to be
 *   reversible without code.
 * - AC-10: was *registered nowhere*. It is now *registered in exactly the
 *   repo-owned positions*, asserted by name, so a later deregistration is
 *   as loud as the registration was.
 *
 * AC-11 did NOT move. `~/.claude/settings.json` is machine state no PR
 * carries, and this branch still does not touch it — which is the honest
 * limit of what "registered" means here.
 *
 * ## What was actually missing
 *
 * #992's acceptance was met by PR #997: the parser works, every listed form
 * has a case, and it is registered nowhere. What was missing is not a fix —
 * it is that **the option endorsed on the issue was not expressible**.
 *
 * The issue measured 32.7% of 31,577 unique Bash commands refused, zero
 * false positives, and then corrected its own premise:
 *
 * > *"I wrote: 'a false refusal costs one retyped command'. At 32.7% of
 * > 31,577 commands, a false refusal costs 10,332 retyped commands. My cost
 * > model was wrong by orders of magnitude, and the recommendation that
 * > followed from it — register it as a hard refusal — would produce exactly
 * > the gets-disabled failure I warned about two paragraphs later."*
 *
 * The endorsed plan is option 2 + 3: scope to harness projects, then WARN,
 * then promote on decay evidence. **Neither rung existed in code.** The hook
 * emitted `{decision:'block'}` unconditionally and was unscoped, so "register
 * it as a warning" meant rewriting the hook on the day of the decision — the
 * worst moment to be editing a hook that fires on every Bash call.
 *
 * That argument is left standing above because it is the honest case against
 * what this now does, and the counter-argument is the scoping: the guard
 * fires only inside a harnessed project, where peer worktrees are what a
 * stray `cd` kills. AC-7 is the arm that keeps the scoping true.
 *
 * Issue: #992. Refs #997, #1040, COMP-7.
 */

import { afterAll, describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { CD_GUARD_DEFAULT_MODE, CD_GUARD_MODE_VAR, cdGuardMode } from "../lib/top-level-cd";
import { isHarnessProject } from "../lib/harness-project";

const ROOT = join(import.meta.dir, "..");
const HOOK = join(ROOT, "hooks", "TopLevelCdGuard.hook.ts");
const scratch: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cdguard-"));
  scratch.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** A harnessed project directory, by whichever marker is asked for. */
function harnessed(marker: "file" | "dir"): string {
  const d = tmp();
  mkdirSync(join(d, ".claude"), { recursive: true });
  if (marker === "file") writeFileSync(join(d, ".claude", "rungate.json"), "{}");
  else mkdirSync(join(d, ".claude", "rungate"));
  return d;
}

/** Drive the real hook in `cwd`, with the given mode env. */
function run(cwd: string, command: string, env: Record<string, string> = {}) {
  const r = spawnSync("bun", [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    cwd,
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, ...env },
  });
  const stdout = (r.stdout ?? "").trim();
  let decision: string | undefined;
  try { decision = stdout ? JSON.parse(stdout).decision : undefined; } catch {}
  return { stdout, stderr: r.stderr ?? "", decision, status: r.status };
}

const OFFENDING = "cd /tmp && ls";
const ALLOWED = "git -C /tmp status";

describe("#992 — the mode is a reading, not a rewrite", () => {
  test("AC-1: absent config is BLOCK, and the three rungs resolve", () => {
    expect(cdGuardMode({}).mode, "the default rung is no longer the decision Jason took").toBe(
      CD_GUARD_DEFAULT_MODE,
    );
    expect(CD_GUARD_DEFAULT_MODE, "#992's decision was block").toBe("block");
    expect(cdGuardMode({ [CD_GUARD_MODE_VAR]: "" }).mode).toBe("block");
    // The two opt-outs, each asserted, because the decision is only
    // reversible-without-code for as long as both still resolve.
    expect(cdGuardMode({ [CD_GUARD_MODE_VAR]: "warn" }).mode).toBe("warn");
    expect(cdGuardMode({ [CD_GUARD_MODE_VAR]: " OFF " }).mode).toBe("off");
  });

  test("AC-2: an unrecognised value does NOT degrade silently", () => {
    // `.claude/rules/config-access.md`: a typo resolving quietly to the
    // default is the same observation as a deliberate choice. The value is
    // carried back so the caller can say it out loud.
    //
    // The direction moved with the default and that is deliberate: an
    // unreadable rung now REFUSES, which is where `lib/top-level-cd.ts`
    // errs everywhere else. A typo must not be the quiet way to turn a
    // guard down.
    const r = cdGuardMode({ [CD_GUARD_MODE_VAR]: "blcok" });
    expect(r.mode, "an unknown rung should take the default").toBe(CD_GUARD_DEFAULT_MODE);
    expect(r.unrecognised, "the bad value is swallowed — a typo is indistinguishable from a choice").toBe("blcok");
    expect(cdGuardMode({ [CD_GUARD_MODE_VAR]: "block" }).unrecognised).toBeUndefined();
  });
});

describe("#992 — BLOCK is the default rung; WARN and OFF are the opt-outs", () => {
  test("AC-3: the default rung REFUSES, and names the alternative", () => {
    const r = run(harnessed("dir"), OFFENDING);
    expect(r.decision, "the default rung is not refusing — #992 chose block").toBe("block");
    // #992: a refusal "that does not name `git -C` as the alternative will
    // just be worked around". The whole case for a hard rung rests on the
    // refusal being actionable in the moment it fires.
    expect(r.stdout).toContain("git -C");
    expect(r.stderr.trim(), "it refused AND warned — one event, two channels").toBe("");
  });

  test("AC-4: `warn` is still reachable and runs the command", () => {
    // The reversibility the mode was built for. If this arm goes red the
    // decision has stopped being a configuration choice, whatever the
    // docblocks say.
    const r = run(harnessed("dir"), OFFENDING, { [CD_GUARD_MODE_VAR]: "warn" });
    expect(r.decision, "opting out to warn still blocked").toBeUndefined();
    expect(r.stderr, "the warning says nothing").toContain("top-level-cd");
    expect(r.stderr).toContain("git -C");
  });

  test("AC-4b: an explicit `block` and the default are the same observation", () => {
    const explicit = run(harnessed("dir"), OFFENDING, { [CD_GUARD_MODE_VAR]: "block" });
    const defaulted = run(harnessed("dir"), OFFENDING);
    expect(explicit.decision).toBe("block");
    expect(explicit.stdout).toBe(defaulted.stdout);
  });

  test("AC-5: `off` says nothing at all", () => {
    const r = run(harnessed("dir"), OFFENDING, { [CD_GUARD_MODE_VAR]: "off" });
    expect(r.decision).toBeUndefined();
    expect(r.stderr.trim()).toBe("");
  });

  test("AC-6 CONTROL: an allowed command is silent under every rung", () => {
    // Without this, AC-3 to AC-5 are equally consistent with a hook that
    // speaks on every input. `git -C` is the form #992 recommends, so a
    // guard that warns about it would teach the wrong habit.
    for (const mode of ["warn", "block", "off"]) {
      const r = run(harnessed("dir"), ALLOWED, { [CD_GUARD_MODE_VAR]: mode });
      expect(r.decision, `${mode} blocked the recommended form`).toBeUndefined();
      expect(r.stderr.trim(), `${mode} warned about the recommended form`).toBe("");
    }
  });

  test("AC-7: OUTSIDE a harnessed project it is silent, even in block mode", () => {
    // The scope half of the endorsed plan. A top-level `cd` costs something
    // only where concurrent agents hold worktrees.
    const bare = tmp();
    for (const mode of ["warn", "block"]) {
      const r = run(bare, OFFENDING, { [CD_GUARD_MODE_VAR]: mode });
      expect(r.decision, `${mode} fired outside a harnessed project`).toBeUndefined();
      expect(r.stderr.trim(), `${mode} warned outside a harnessed project`).toBe("");
    }
  });

  test("AC-8: BOTH config markers count as harnessed", () => {
    // Checking one marker only would go quiet for every project on the
    // other layout, and a hook that stopped firing looks exactly like a
    // project that is not harnessed.
    for (const marker of ["file", "dir"] as const) {
      const r = run(harnessed(marker), OFFENDING);
      expect(r.decision, `the ${marker} marker is not recognised as a harness`).toBe("block");
    }
    expect(isHarnessProject(tmp()), "an empty directory reads as harnessed").toBe(false);
    expect(isHarnessProject(ROOT), "this repository does not read as harnessed").toBe(true);
  });
});

describe("#992 — one decider, and registered where the repo can see it", () => {
  test("AC-9: `isHarnessProject` is defined ONCE", () => {
    // The prerequisite the issue names: "a second inline copy would be two
    // deciders for one question, which is this repo's most frequent defect".
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
        if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
        const rel = p.slice(ROOT.length + 1);
        if (rel === "lib/harness-project.ts") continue;
        if (/function\s+isHarnessProject\s*\(/.test(readFileSync(p, "utf-8"))) offenders.push(rel);
      }
    };
    for (const d of ["lib", "hooks", "gates", "scripts"]) walk(join(ROOT, d));
    expect(offenders, `a second definition of isHarnessProject: ${offenders.join(", ")}`).toEqual([]);
    // And the original caller uses the lifted one rather than having lost it.
    expect(readFileSync(join(ROOT, "hooks", "BashToolGuard.hook.ts"), "utf-8"))
      .toContain("from '../lib/harness-project'");
  });

  test("AC-10: the hook is DECLARED in the inventory and NOT registered at project scope (#1578)", () => {
    // Inverted a second time, and the reason is a measurement rather than a
    // preference.
    //
    // This arm first asserted the hook was registered nowhere, then — when
    // #992 took the decision — that `.claude/settings.json` and
    // `.claude/rungate/hooks.json` both named it. #1578 measured what that
    // project registration actually bought: nothing. A session in a worktree
    // carrying that exact file did not load it, while a user-scoped refusal
    // fired on the same Bash matcher in the same session. The hook was green,
    // registered and inert from #1050 to #1578.
    //
    // So the two scopes now part company and the split is the claim:
    //
    //  - `.claude/rungate/hooks.json` — the INVENTORY. Still names the hook;
    //    the entry is what declares it exists and carries `scope: "user"`.
    //  - `.claude/settings.json` — the project REGISTRATION. Must NOT name
    //    it. SC-518: the two scopes are not de-duplicated, so a leftover
    //    project registration fires the hook twice the moment a human adds
    //    the real one to `~/.claude/settings.json`.
    //
    // Repo scopes only, unchanged from the #976 lesson: machine settings are
    // UNMEASURABLE on a CI runner and an arm whose input is absent there
    // passes vacuously. The honest reading of the machine scope is the
    // UNMEASURED finding in `test/hook-registration-reconciler.test.ts`.
    const inventory = readFileSync(join(ROOT, ".claude", "rungate", "hooks.json"), "utf-8");
    expect(
      inventory,
      ".claude/rungate/hooks.json no longer declares TopLevelCdGuard — the inventory entry is " +
        "what carries the scope, and deleting it hides the hook rather than reclassifying it",
    ).toContain("TopLevelCdGuard.hook.ts");
    expect(
      JSON.parse(inventory).find((e: { name?: string }) => e.name === "TopLevelCdGuard")?.scope,
      'the inventory no longer declares user scope; #1578 measured project scope dead for this hook',
    ).toBe("user");

    const settings = readFileSync(join(ROOT, ".claude", "settings.json"), "utf-8");
    expect(
      settings,
      ".claude/settings.json registers TopLevelCdGuard while the inventory declares user scope. " +
        "SC-518 says that fires the hook twice; remove the project registration.",
    ).not.toContain("TopLevelCdGuard.hook.ts");

    // The mirror of #898's AC-5: a registered hook carrying the
    // unregistered declaration is a stale waiver that would satisfy AC-4
    // again the day someone deregisters it.
    expect(readFileSync(HOOK, "utf-8")).not.toContain("NOT REGISTERED");
  });

  test("AC-11: the machine's own settings are UNCHANGED by this branch", () => {
    // Did NOT move with AC-10, and that is the honest limit of the word
    // "registered" in this PR. Project scope covers sessions started in a
    // harnessed project — including every worktree, which carries the
    // committed `.claude/settings.json`. It does NOT cover a session started
    // anywhere else on the machine. That registration is
    // `~/.claude/settings.json`, which no PR carries and which 45 other
    // hooks share, so it stays a separate, deliberate action.
    //
    // Stated as a reading rather than a promise. If a future change
    // registers it at user level this arm says so on the author's machine
    // and is simply absent on a runner — recorded as a limit, not hidden.
    const user = join(homedir(), ".claude", "settings.json");
    let src: string;
    try { src = readFileSync(user, "utf-8"); } catch { return; } // no user settings here (CI)
    expect(src, "~/.claude/settings.json registers TopLevelCdGuard — not done by this branch")
      .not.toContain("TopLevelCdGuard");
  });
});
