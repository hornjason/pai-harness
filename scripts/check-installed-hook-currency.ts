#!/usr/bin/env bun
/**
 * Compare the INSTALLED pre-commit hook against what the generator produces
 * today, and refuse when they differ (#599).
 *
 * `.git/hooks/pre-commit` is untracked. Nothing in the repository can see it,
 * no CI job installs it, and `createGitHooks` only runs on a re-scaffold — so
 * a fix to the generator reaches a developer's own commits when somebody
 * remembers, and not otherwise. "The generator is fixed" and "my commits are
 * fixed" are two claims and only the first has ever had evidence here: #450
 * landed the linked-worktree guard on 2026-10-17 and this repository went on
 * committing through the pre-#450 hook, which is the only reason #599 was
 * observable at all.
 *
 * The comparison is BYTE-EXACT, and the named guards below are diagnosis
 * rather than the test. A check that asked only "does the installed hook
 * contain the worktree guard" would be satisfiable by pasting the string into
 * a hook that does nothing with it — the proxy trap
 * `.claude/rules/checks-must-be-able-to-fail.md` records against #492. What
 * the named guards buy is a refusal that says WHICH fix the installed copy
 * predates, which is the difference between a message someone acts on and one
 * they learn to click past.
 *
 * Usage:
 *   bun scripts/check-installed-hook-currency.ts [--project <dir>] [--generator <dir>] [--install]
 *
 * `--project`   the checkout whose installed hook is read. Defaults to cwd.
 *               A LINKED WORKTREE is resolved to the shared `.git` it points
 *               at, because that is where the hook it will actually run lives.
 * `--generator` the rungate checkout holding `lib/scaffold/steps.ts`. Defaults
 *               to this script's own repository.
 * `--install`   write the generator output to the installed path. The remedy
 *               the refusal names, so it is one command rather than a
 *               paragraph.
 *
 * THREE PROPERTIES THIS FILE MUST KEEP, all asserted by
 * test/unit/installed-hook-currency.test.ts (see
 * .claude/rules/checks-must-be-able-to-fail.md, "For a script whose job is to
 * exit non-zero"):
 *
 *   1. Every refusal exits through REFUSE_EXIT, declared exactly once. The
 *      test builds a mutant copy with that constant set to 0 and runs every
 *      negative case twice — real refuses, mutant does not. An exit written
 *      with a literal code would slip past the mutation and the case guarding
 *      it would be indistinguishable from one passing by accident.
 *   2. No relative imports, static or dynamic. The mutant runs from a temp
 *      directory, and a relative import of anything under lib/ would make it
 *      die on module resolution — a non-zero exit that reads as the mutation
 *      having been rejected on the merits. The generator is reached through a
 *      path computed from `--generator` instead, which is why that option
 *      exists at all.
 *   3. Every refusal carries a CLASS, and the class decides the label (#613).
 *      The exit code says a refusal happened; it cannot say what was refused,
 *      and one label over every class is the same defect as one exit code
 *      over every outcome. See REFUSAL_PREFIX below.
 */

import { execFileSync } from "child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { isAbsolute, join } from "path";
import { fileURLToPath } from "url";

/** The one exit code every refusal travels through. See note 1 above. */
export const REFUSE_EXIT = 1;

/**
 * What a refusal is ABOUT. See note 3 above.
 *
 * Before #613 every refusal in this file was printed under the staleness
 * label, including the three `parseArgs` raises — so `--harness` instead of
 * `--generator` reported the installed hook as stale on a checkout whose hook
 * was current, and the remedy the label implies is `--install`, which replaces
 * a hook that was fine. Three more classes were collapsed the same way and two
 * of them are worse than the typo:
 *
 *  - the GENERATOR failing to load or run is the INSTRUMENT, not the subject.
 *    "The installed hook differs from the generator" is a measurement; "the
 *    generator could not be run" is the ABSENCE of one, and reporting an
 *    absent measurement as the stalest available verdict is
 *    `.claude/rules/config-access.md`'s UNMEASURED distinction with the sign
 *    flipped.
 *  - `installHook` failing reports STALENESS in `--install` mode, so the
 *    remedy the message names is the command that just failed.
 *
 * `0`, `{}`, `null` and silence are indistinguishable from success. One label
 * over four classes is the same defect one level up: the reader cannot tell an
 * argument error from a measured failure from a reading that was never taken.
 */
export type RefusalClass = "ARGUMENTS" | "UNMEASURED" | "STALE" | "INSTALL";

/**
 * The one place a refusal label is written. Each literal appears exactly once
 * in this file — asserted by the test, because a second copy at a print site
 * would survive any mutation of this table and both would read as covered
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
 */
export const REFUSAL_PREFIX: Record<RefusalClass, string> = {
  ARGUMENTS: "ARGUMENT ERROR",
  UNMEASURED: "HOOK CURRENCY UNMEASURED",
  STALE: "INSTALLED HOOK STALE",
  INSTALL: "HOOK INSTALL REFUSED",
};

export class HookRefused extends Error {
  readonly refusalClass: RefusalClass;
  constructor(refusalClass: RefusalClass, message: string) {
    super(message);
    this.name = "HookRefused";
    this.refusalClass = refusalClass;
  }
}

/**
 * The fixes an installed hook can predate, each named by the issue that
 * landed it and probed by a fragment of the generator's own output.
 *
 * Every probe is asserted present in the generated hook before any comparison
 * is made. Without that, a generator rewrite would silently empty this table
 * and the refusal would stop being able to say anything — the table would
 * become a check that cannot fail, inside a script about checks that cannot
 * fail.
 */
export interface GuardProperty {
  name: string;
  probe: string;
}

export const GUARD_PROPERTIES: GuardProperty[] = [
  {
    name: "the linked-worktree guard (#450)",
    probe: "--git-common-dir",
  },
  {
    name: "the updater resolution (#599)",
    probe: 'updater="scripts/update-project-state.ts"',
  },
  {
    name: "the decline on stderr (#599)",
    probe: "are DA-owned (#296); update them from the primary checkout.\" >&2",
  },
];

/**
 * Where the hook that will actually run lives.
 *
 * `--git-common-dir`, not `--git-dir`: in a linked worktree the latter is
 * `.git/worktrees/<name>`, which has no `hooks/` and never will. A check that
 * joined `<project>/.git/hooks/pre-commit` would report "not installed" from
 * every worktree in the repository, which is exactly where an agent runs it.
 */
export function installedHookPath(projectRoot: string): string {
  let common = "";
  try {
    common = execFileSync("git", ["-C", projectRoot, "rev-parse", "--git-common-dir"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
    }).trim();
  } catch (e) {
    throw new HookRefused(
      "UNMEASURED",
      `${projectRoot} is not a git checkout, so it has no installed hook to read: ${firstLine(e)}`,
    );
  }
  if (!common) {
    throw new HookRefused("UNMEASURED", `git reported no common dir for ${projectRoot}`);
  }
  return join(isAbsolute(common) ? common : join(projectRoot, common), "hooks", "pre-commit");
}

export interface GeneratorOutput {
  content: string;
  marker: string;
}

/**
 * What `createGitHooks` writes today, obtained by RUNNING it into a scratch
 * directory rather than by re-deriving the template here.
 *
 * A second copy of the hook text in this file would be a second decider that
 * always agrees with the first: the comparison would pass while the generator
 * drifted, and no mutation of either could tell them apart.
 */
export async function generatorHook(generatorRoot: string): Promise<GeneratorOutput> {
  const modulePath = join(generatorRoot, "lib", "scaffold", "steps.ts");
  let mod: any;
  try {
    mod = await import(modulePath);
  } catch (e) {
    throw new HookRefused(
      "UNMEASURED",
      `could not load the hook generator at ${modulePath}: ${firstLine(e)}. ` +
        `Pass --generator <rungate checkout> if this project is not the harness.`,
    );
  }
  if (typeof mod.createGitHooks !== "function" || typeof mod.PRE_COMMIT_MANAGED_MARKER !== "string") {
    throw new HookRefused(
      "UNMEASURED",
      `${modulePath} does not export createGitHooks and PRE_COMMIT_MANAGED_MARKER, so there is ` +
        `nothing to compare the installed hook against`,
    );
  }

  const scratch = mkdtempSync(join(tmpdir(), "rungate-hookgen-"));
  try {
    mkdirSync(join(scratch, ".git", "hooks"), { recursive: true });
    mod.createGitHooks(scratch, []);
    const content = readFileSync(join(scratch, ".git", "hooks", "pre-commit"), "utf-8");
    const marker: string = mod.PRE_COMMIT_MANAGED_MARKER;
    if (!content.includes(marker)) {
      throw new HookRefused(
        "UNMEASURED",
        `the generator's own output does not carry PRE_COMMIT_MANAGED_MARKER, so no installed ` +
          `hook could ever be recognised as managed`,
      );
    }
    const blind = GUARD_PROPERTIES.filter(p => !content.includes(p.probe));
    if (blind.length > 0) {
      throw new HookRefused(
        "UNMEASURED",
        `the generator no longer contains ${blind.map(b => b.name).join(", ")}. The probe` +
          `${blind.length > 1 ? "s" : ""} in GUARD_PROPERTIES ha${blind.length > 1 ? "ve" : "s"} ` +
          `gone stale, and a stale probe reports every installed hook as predating a fix it may ` +
          `well carry. Update the table in the same change as the generator.`,
      );
    }
    return { content, marker };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The single decider. Returns null when the installed hook IS the generator
 * output, and the reason otherwise.
 *
 * One function, one binding to mutate. The CLI below does not re-ask any of
 * these questions — a second guard answering the same question would survive
 * any mutation of this one, and both would read as covered.
 */
export function currencyRefusal(
  installed: string | null,
  generated: string,
  marker: string,
  path: string,
): string | null {
  if (installed === null) {
    return (
      `no pre-commit hook is installed at ${path}. The generator is not the thing that runs on ` +
      `your commits; the file is. Re-run \`bun bin/rungate.ts scaffold .\`, or this script with ` +
      `--install.`
    );
  }
  if (!installed.includes(marker)) {
    return (
      `the hook installed at ${path} is hand-written — it does not carry the rungate managed ` +
      `marker, so it is not compared and not replaced. Nothing here can tell you whether it ` +
      `enforces the DA-owned state rule. Move it aside and re-run with --install if you want ` +
      `the generated one.`
    );
  }
  if (installed === generated) return null;

  const missing = GUARD_PROPERTIES.filter(p => !installed.includes(p.probe));
  const how = `Re-run this script with --install, or \`bun bin/rungate.ts scaffold .\`.`;
  if (missing.length > 0) {
    return (
      `the hook installed at ${path} predates ${missing.map(m => m.name).join(", ")}. ` +
      `Every commit from this checkout is running the old behaviour, whatever the generator ` +
      `says. ${how}`
    );
  }
  return (
    `the hook installed at ${path} carries every named guard but is not byte-identical to the ` +
    `generator's output, so something edited it or it predates a change this table does not ` +
    `name. ${how}`
  );
}

/**
 * Write the generator output to the installed path.
 *
 * Refuses a symlink rather than following one — BUG-440-A's shape. A
 * `pre-commit` symlinked at a path outside the repository would otherwise be
 * overwritten with the hook, outside the project, reported as a success.
 */
export function installHook(path: string, content: string): void {
  let link: ReturnType<typeof lstatSync> | null = null;
  try {
    link = lstatSync(path);
  } catch {
    link = null;
  }
  if (link?.isSymbolicLink()) {
    throw new HookRefused(
      "INSTALL",
      `${path} is a symlink, and the hook is not written through one — the target may be ` +
        `outside this repository. Replace it with a real file, or delete it and re-run.`,
    );
  }
  if (link && !link.isFile()) {
    throw new HookRefused(
      "INSTALL",
      `${path} exists but is not a regular file, so it will not be replaced.`,
    );
  }
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function firstLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split("\n")[0];
}

const VALUE_OPTIONS = new Set(["project", "generator"]);
const FLAG_OPTIONS = new Set(["install"]);

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const m = /^--([A-Za-z][A-Za-z-]*)$/.exec(arg);
    if (!m) {
      throw new HookRefused(
        "ARGUMENTS",
        `unexpected argument "${arg.slice(0, 80)}" — every input is a --flag, with a value where one is needed`,
      );
    }
    if (FLAG_OPTIONS.has(m[1])) {
      out[m[1]] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(m[1])) {
      throw new HookRefused("ARGUMENTS", `unknown option --${m[1]}`);
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new HookRefused("ARGUMENTS", `--${m[1]} needs a value`);
    }
    out[m[1]] = value;
  }
  return out;
}

/** This script's own repository, used when --generator is not given. */
export function defaultGeneratorRoot(): string {
  return join(fileURLToPath(new URL(".", import.meta.url)), "..");
}

function readIfPresent(path: string): string | null {
  try {
    const link = lstatSync(path);
    if (link.isSymbolicLink()) {
      throw new HookRefused(
        "UNMEASURED",
        `${path} is a symlink. The hook that runs is the link's target, which may be outside ` +
          `this repository, so this check will not follow it. Replace it with a real file.`,
      );
    }
    if (!link.isFile()) {
      throw new HookRefused("UNMEASURED", `${path} exists but is not a regular file`);
    }
    return readFileSync(path, "utf-8");
  } catch (e) {
    if (e instanceof HookRefused) throw e;
    return null;
  }
}

// CLI entry point. Guarded so the module can be imported by tests without
// running the check and calling process.exit.
if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const project = typeof args.project === "string" ? args.project : process.cwd();
    const generatorRoot = typeof args.generator === "string" ? args.generator : defaultGeneratorRoot();

    const path = installedHookPath(project);
    const { content, marker } = await generatorHook(generatorRoot);

    if (args.install === true) {
      installHook(path, content);
      console.log(`pre-commit installed, and current, at ${path}`);
    } else {
      // One decider, asked once. A success exits by falling off the end
      // rather than through an explicit zero exit, so the test's "every exit
      // goes through REFUSE_EXIT" scan has no exception to carve out — an
      // exception is where a literal exit code hides. The scan reads this
      // prose too, which is why the shape is not written out here.
      //
      // The staleness verdict is RAISED rather than printed here (#613), so
      // there is exactly one position in this file that turns a refusal into
      // a line of output. A second print site would be a second decider
      // about the label, and a mutation of either would leave the other
      // holding the case up.
      const refusal = currencyRefusal(readIfPresent(path), content, marker, path);
      if (refusal) throw new HookRefused("STALE", refusal);
      console.log(`pre-commit is current at ${path}`);
    }
  } catch (e) {
    // The class decides the label. `e.refusalClass` is set at the raise, by
    // the code that knows what it refused; nothing here re-derives it from
    // the message, because a second reading of the same fact is a second
    // decider that always agrees.
    console.error(e instanceof HookRefused ? `${REFUSAL_PREFIX[e.refusalClass]}: ${e.message}` : String(e));
    process.exit(REFUSE_EXIT);
  }
}
