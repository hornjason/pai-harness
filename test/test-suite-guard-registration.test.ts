import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// SPEC-REF: HOOK-ARCHITECTURE-SPEC.md § Design Decisions

/**
 * Issue #67-A — the concurrency guard was registered at the wrong scope.
 *
 * TestSuiteGuard and TestSuiteRelease were registered only in rungate's PROJECT
 * `.claude/settings.json`. Project settings load from the directory a session
 * was started in, so the guard was inert for every session rooted anywhere else
 * — including sessions actively working on rungate through an added working
 * directory. The cap that exists to be machine-wide was in fact per-project.
 *
 * Measured, not assumed: with both slots freshly held, `pnpm test` (a spelling
 * the parser guards) reached the shell and failed with `command not found`
 * instead of being blocked.
 *
 * The guard therefore belongs in the USER settings file, next to the other
 * rungate hooks that are already registered there. It must not ALSO stay in the
 * project file: the two scopes are not de-duplicated, so a rungate-rooted
 * session would run the hook twice and burn two slots on one suite.
 */

const repoRoot = join(__dirname, "..");
const projectSettingsPath = join(repoRoot, ".claude", "settings.json");
const userSettingsPath = join(homedir(), ".claude", "settings.json");

const SLOT_HOOKS = ["TestSuiteGuard.hook.ts", "TestSuiteRelease.hook.ts"];

function allHookCommands(settings: any): string[] {
  const out: string[] = [];
  for (const groups of Object.values(settings.hooks ?? {})) {
    for (const group of (groups as any[]) ?? []) {
      for (const hook of group.hooks ?? []) {
        if (typeof hook.command === "string") out.push(hook.command);
      }
    }
  }
  return out;
}

describe("#67-A: slot hooks are registered machine-wide, not per-project", () => {
  const projectCommands = allHookCommands(
    JSON.parse(readFileSync(projectSettingsPath, "utf-8")),
  );

  for (const hook of SLOT_HOOKS) {
    test(`${hook} is NOT registered in project settings`, () => {
      // Project scope is the bug. Re-adding it here would both narrow the cap
      // back to rungate-rooted sessions and double-fire for those that remain.
      expect(projectCommands.some((c) => c.includes(hook))).toBe(false);
    });

    test(`${hook} exists at the path the user settings reference`, () => {
      expect(existsSync(join(repoRoot, "hooks", hook))).toBe(true);
    });
  }
});

describe("#67-A: this machine's user settings register the slot hooks", () => {
  // Only meaningful where the user settings file is the one that references
  // rungate's hooks. In CI there is no such file, so these cases report as
  // skipped rather than passing vacuously — a silently-skipped check is the
  // same failure mode as the guard that was silently never registered.
  const userSettings = existsSync(userSettingsPath)
    ? JSON.parse(readFileSync(userSettingsPath, "utf-8"))
    : null;
  const userCommands = userSettings ? allHookCommands(userSettings) : [];
  const configured = userCommands.some((c) => c.includes("RUNGATE_HOOKS_DIR"));

  for (const hook of SLOT_HOOKS) {
    test.skipIf(!configured)(`${hook} is registered in user settings`, () => {
      expect(userCommands.some((c) => c.includes(hook))).toBe(true);
    });

    test.skipIf(!configured)(`${hook} is registered exactly once`, () => {
      // Two registrations means two slots taken for one suite.
      expect(userCommands.filter((c) => c.includes(hook))).toHaveLength(1);
    });
  }
});
