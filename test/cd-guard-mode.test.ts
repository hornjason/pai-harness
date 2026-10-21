/**
 * #992 — the guard can WARN, and it is scoped. Still registered nowhere.
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
 * This battery is about that: `warn` is expressible, `block` is opt-in, the
 * scope check is shared rather than copied, and **nothing is registered**.
 * AC-7 is the arm that keeps the last part true.
 *
 * Issue: #992. Refs #997, COMP-7.
 */

import { afterAll, describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { CD_GUARD_MODE_VAR, cdGuardMode } from "../lib/top-level-cd";
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
  test("AC-1: absent config is WARN, and the three rungs resolve", () => {
    expect(cdGuardMode({}).mode).toBe("warn");
    expect(cdGuardMode({ [CD_GUARD_MODE_VAR]: "" }).mode).toBe("warn");
    expect(cdGuardMode({ [CD_GUARD_MODE_VAR]: "block" }).mode).toBe("block");
    expect(cdGuardMode({ [CD_GUARD_MODE_VAR]: " OFF " }).mode).toBe("off");
  });

  test("AC-2: an unrecognised value does NOT degrade silently", () => {
    // `.claude/rules/config-access.md`: a typo resolving quietly to the
    // default is the same observation as a deliberate choice. The value is
    // carried back so the caller can say it out loud.
    const r = cdGuardMode({ [CD_GUARD_MODE_VAR]: "blcok" });
    expect(r.mode, "an unknown rung should take the least disruptive one").toBe("warn");
    expect(r.unrecognised, "the bad value is swallowed — a typo is indistinguishable from a choice").toBe("blcok");
    expect(cdGuardMode({ [CD_GUARD_MODE_VAR]: "block" }).unrecognised).toBeUndefined();
  });
});

describe("#992 — WARN runs the command; BLOCK is opt-in", () => {
  test("AC-3: the default rung WARNS and does not block", () => {
    const r = run(harnessed("dir"), OFFENDING);
    expect(r.decision, "the default is still a hard refusal — the ladder's first rung is missing").toBeUndefined();
    expect(r.stderr, "the warning says nothing").toContain("top-level-cd");
    // The refusal message is the whole point of warning rather than
    // refusing: #992 says a refusal "that does not name `git -C` as the
    // alternative will just be worked around", and a warning even more so.
    expect(r.stderr).toContain("git -C");
  });

  test("AC-4: `block` still blocks, with the same message", () => {
    const r = run(harnessed("dir"), OFFENDING, { [CD_GUARD_MODE_VAR]: "block" });
    expect(r.decision, "opting into block no longer blocks").toBe("block");
    expect(r.stdout).toContain("git -C");
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
      expect(r.stderr, `the ${marker} marker is not recognised as a harness`).toContain("top-level-cd");
    }
    expect(isHarnessProject(tmp()), "an empty directory reads as harnessed").toBe(false);
    expect(isHarnessProject(ROOT), "this repository does not read as harnessed").toBe(true);
  });
});

describe("#992 — one decider, and still registered nowhere", () => {
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

  test("AC-10: the hook is registered NOWHERE — registration is Jason's call", () => {
    // This PR deliberately does not register the hook. Building a WARN rung
    // is not choosing it. The arm fails the moment someone adds a
    // registration without taking the decision.
    //
    // Repo scopes only: machine settings are UNMEASURABLE on a CI runner,
    // and an arm whose input is absent there passes vacuously. This one a
    // runner can answer, which is the #976 lesson.
    for (const rel of [".claude/settings.json", ".claude/rungate/hooks.json", ".claude/rungate.json"]) {
      let src: string;
      try { src = readFileSync(join(ROOT, rel), "utf-8"); } catch { continue; }
      expect(src, `TopLevelCdGuard is registered in ${rel} — #992's scope note makes that Jason's call`)
        .not.toContain("TopLevelCdGuard");
    }
    // The header declaration #898's AC-4 requires of an unregistered hook.
    expect(readFileSync(HOOK, "utf-8")).toContain("NOT REGISTERED");
  });

  test("AC-11: the machine's own settings are UNCHANGED by this branch", () => {
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
