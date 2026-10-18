#!/usr/bin/env bun
/**
 * Compare the pre-commit hook git ACTUALLY RUNS against what the generator
 * produces today, and refuse when they disagree (#599).
 *
 * The installed hook is untracked, and that is the entire problem. #450 taught
 * `createGitHooks` to decline writing DA-owned state from a linked worktree,
 * and every test of it passed, and this repository's own installed copy was
 * still the pre-#450 version three weeks later — running
 * `bun scripts/update-project-state.ts` and `git add PROJECT-STATE.md
 * project-state.json` on every commit from every worktree, which is exactly
 * what CLAUDE.md forbids in bold and what the #178/SC-413 collection guard
 * refuses a whole run over. An agent could comply perfectly and still trip it.
 *
 * Nothing in the tree could see that. A generator test proves the TEMPLATE is
 * correct; it says nothing about the bytes on disk, and the two had been
 * diverging silently since the day the template was fixed. This script is the
 * reading that closes the gap, and it is deliberately a thing a human or a
 * workflow runs rather than a unit test, because its subject is machine state.
 *
 * It only produced a visible symptom for about four hours a day — the stamp is
 * UTC (#600), so the recomputed date differs from the stored one only in the
 * evening EDT window. A violation that fires for four hours a day is worse
 * than one that always fires: every green run in the other twenty hours was
 * not evidence of compliance, and was read as if it were.
 *
 * Usage:
 *   bun scripts/check-installed-hook-currency.ts [--project <dir>] [--harness <dir>]
 *
 * Prints the verdict on stdout when it is clean; every refusal goes to stderr
 * so stdout stays readable by a caller.
 *
 * TWO PROPERTIES THIS FILE MUST KEEP, both asserted by
 * test/unit/installed-hook-currency.test.ts (see
 * .claude/rules/checks-must-be-able-to-fail.md):
 *
 *   1. Every refusal exits through REFUSE_EXIT, declared exactly once. The
 *      test builds a mutant copy with that constant set to 0 and runs every
 *      negative case twice — real refuses, mutant does not. An exit written
 *      with a literal code would slip past the mutation, and the case
 *      guarding it would be indistinguishable from one passing by accident.
 *   2. No relative imports. The mutant runs from a temp directory, and a
 *      relative import of anything under lib/ would make it die on module
 *      resolution — a non-zero exit that reads as the mutation having been
 *      rejected on the merits. The generator is therefore loaded through a
 *      path COMPUTED from --harness, not through a static specifier.
 *
 * There is exactly ONE decider here — `hookCurrency`. A second guard asking
 * the same question of the same bytes would be behaviourally the same guard,
 * and a mutation of either would leave the other holding every case up, which
 * is the fourth shape in checks-must-be-able-to-fail.md.
 */

import { execFileSync } from "child_process";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";

/** The one exit code every refusal travels through. See note 1 above. */
export const REFUSE_EXIT = 1;

export class CurrencyRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CurrencyRefused";
  }
}

export type Currency =
  | { state: "current" }
  | { state: "absent"; reason: string }
  | { state: "unmanaged"; reason: string }
  | { state: "stale"; reason: string };

/**
 * The single decider. Everything the script concludes about the installed
 * hook is concluded here, from the two strings, and nowhere else.
 *
 * `installed` is `null` when there is no file — which is NOT the same as an
 * empty one, and the two must not be collapsed: an empty hook is a hook that
 * someone truncated, and git runs it and it scans nothing.
 *
 * The stale reason distinguishes "predates the worktree guard" from ordinary
 * drift, because the advice is identical but the urgency is not — a hook
 * without the guard is actively staging DA-owned state right now. That is one
 * decision producing a better sentence, not a second decision: both are
 * `stale`, and both are refused by the same comparison.
 */
export function hookCurrency(
  installed: string | null,
  expected: string,
  managedMarker: string,
  worktreeAnchor: string,
): Currency {
  if (installed === null) {
    return {
      state: "absent",
      reason:
        "no pre-commit hook is installed, so the secret scan is not running either. " +
        "Run `bunx rungate scaffold .` to install it.",
    };
  }
  if (!installed.includes(managedMarker)) {
    return {
      state: "unmanaged",
      reason:
        "the installed pre-commit hook is hand-written — it does not carry the rungate " +
        "managed marker, so a re-scaffold will NOT replace it and this check cannot " +
        "vouch for what it does. Merge the generated hook into it by hand, or delete it " +
        "and re-scaffold.",
    };
  }
  if (installed !== expected) {
    const missingGuard = !installed.includes(worktreeAnchor);
    return {
      state: "stale",
      reason: missingGuard
        ? "the installed pre-commit hook is a stale managed copy that predates the " +
          "linked-worktree guard (#450/#599): it runs the state updater and stages " +
          "PROJECT-STATE.md and project-state.json from EVERY worktree, which CLAUDE.md " +
          "forbids and the #178/SC-413 collection guard refuses a whole run over. " +
          "Run `bunx rungate scaffold .` to replace it."
        : "the installed pre-commit hook is a stale managed copy — it carries the " +
          "worktree guard but differs from what the generator produces today, so some " +
          "other fix to the hook has not reached this checkout. " +
          "Run `bunx rungate scaffold .` to replace it.",
    };
  }
  return { state: "current" };
}

function git(projectRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", projectRoot, ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  });
}

/**
 * Where git looks for the hook, which is the SHARED common dir.
 *
 * A linked worktree's `.git` is a file and `.git/worktrees/<name>` holds no
 * hooks of its own; git runs the common dir's copy from every worktree. A
 * check that resolved `<project>/.git/hooks` would report "absent" from every
 * worktree — declining to look in the one place the stale hook does damage.
 */
export function installedHookPath(projectRoot: string): string {
  let common = "";
  try {
    common = git(projectRoot, ["rev-parse", "--git-common-dir"]).trim();
  } catch (e) {
    throw new CurrencyRefused(`${projectRoot} is not a git repository: ${firstLine(e)}`);
  }
  if (!common) throw new CurrencyRefused(`git reported no common dir for ${projectRoot}`);
  // `--git-common-dir` answers relative to the repo when run inside it.
  const abs = common.startsWith("/") ? common : join(projectRoot, common);
  return join(abs, "hooks", "pre-commit");
}

/** Read the installed hook, or `null` when there is no file there. */
export function readInstalled(path: string): string | null {
  let link;
  try {
    link = lstatSync(path);
  } catch {
    return null;
  }
  if (link.isSymbolicLink()) {
    // A symlinked hook is a hook whose content lives somewhere this check
    // cannot speak for. Refusing is the honest answer; following it would
    // make the verdict describe a file git may not even be able to execute.
    throw new CurrencyRefused(
      `${path} is a symlink. This check compares the bytes git runs against the ` +
        `generator's output, and it will not follow a link out of the repository to do it.`,
    );
  }
  if (!link.isFile()) {
    throw new CurrencyRefused(`${path} exists but is not a regular file`);
  }
  return readFileSync(path, "utf-8");
}

/**
 * The generator's output today, obtained by RUNNING the generator.
 *
 * Loaded through a computed path rather than a static relative import, so the
 * mutant copy of this script can run from a temp directory (note 2 above) and
 * so there is no second copy of the hook text anywhere to drift.
 */
export async function generatorOutput(
  harnessRoot: string,
): Promise<{ expected: string; managedMarker: string }> {
  const modulePath = join(harnessRoot, "lib", "scaffold", "steps.ts");
  try {
    statSync(modulePath);
  } catch {
    throw new CurrencyRefused(
      `the generator is not at ${modulePath} — pass --harness <rungate checkout>`,
    );
  }
  const mod = await import(modulePath);
  if (typeof mod.createGitHooks !== "function" || typeof mod.PRE_COMMIT_MANAGED_MARKER !== "string") {
    throw new CurrencyRefused(`${modulePath} does not export createGitHooks and PRE_COMMIT_MANAGED_MARKER`);
  }
  const dir = mkdtempSync(join(tmpdir(), "rungate-hook-expected-"));
  try {
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    mod.createGitHooks(dir, []);
    return {
      expected: readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf-8"),
      managedMarker: mod.PRE_COMMIT_MANAGED_MARKER,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The text that is present in a hook carrying the worktree guard and absent
 * from one that predates it. Read off the generator's own output at runtime —
 * see the assertion in `main` — so this cannot name a thing the hook no longer
 * contains and silently stop distinguishing anything.
 */
export const WORKTREE_ANCHOR = "--git-common-dir";

function firstLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split("\n")[0];
}

const OPTIONS = new Set(["project", "harness"]);

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const m = /^--([A-Za-z][A-Za-z-]*)$/.exec(arg);
    if (!m) {
      throw new CurrencyRefused(`unexpected argument "${arg.slice(0, 80)}" — every input is a --flag with a value`);
    }
    if (!OPTIONS.has(m[1])) {
      throw new CurrencyRefused(`unknown option --${m[1]}`);
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new CurrencyRefused(`--${m[1]} needs a value`);
    }
    out[m[1]] = value;
  }
  return out;
}

// CLI entry point. Guarded so the module can be imported by tests without
// running the check and calling process.exit.
if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const project = args.project ?? process.cwd();
    const harness = args.harness ?? dirname(import.meta.dir);

    const { expected, managedMarker } = await generatorOutput(harness);
    if (!expected.includes(WORKTREE_ANCHOR)) {
      // The anchor is read off the generator every run rather than trusted.
      // If the generator stopped emitting it, every installed hook would look
      // like it "predates the worktree guard" and the message would be wrong
      // for every reader — a detector whose view of the input silently shrank.
      throw new CurrencyRefused(
        `the generator's own output no longer contains ${WORKTREE_ANCHOR}, so this check ` +
          `cannot tell a hook that predates the worktree guard from one that carries it.`,
      );
    }

    const path = installedHookPath(project);
    const verdict = hookCurrency(readInstalled(path), expected, managedMarker, WORKTREE_ANCHOR);
    if (verdict.state !== "current") {
      console.error(`REFUSED: ${path} — ${verdict.reason}`);
      process.exit(REFUSE_EXIT);
    }
    console.log(`OK: ${path} is current — byte-identical to the generated pre-commit hook.`);
  } catch (e) {
    console.error(e instanceof CurrencyRefused ? `REFUSED: ${e.message}` : `REFUSED: ${firstLine(e)}`);
    process.exit(REFUSE_EXIT);
  }
}
