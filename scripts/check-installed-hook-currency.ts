#!/usr/bin/env bun
/**
 * Compare every INSTALLED git hook against what the generator produces
 * today, and refuse when they differ (#599, #891).
 *
 * The population is `GENERATED_HOOKS` in `lib/scaffold/steps.ts` — the same
 * declaration `createGitHooks` installs from — and not a list here. Until
 * #891 this script joined the literal `pre-commit` and compared that one
 * file, so the `pre-push` installed in this repository sat a mutation
 * battery behind its generator (#728) while the check printed a clean
 * verdict about the other hook and exited 0. A hook the scaffold gains is
 * now a hook this reports on, without this file being edited.
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
import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join } from "path";
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
    probe: "project-state: UNMEASURED",
  },
  {
    name: "the decline on stderr (#599)",
    probe: "are DA-owned (#296); update them from the primary checkout.\" >&2",
  },
  {
    // #610. Deliberately NOT either baked path: the generator emits
    // `scripts/update-project-state.ts` for the harness and
    // `node_modules/rungate/scripts/…` for a consumer, so a probe naming
    // either one reports every tree of the other kind as predating a fix it
    // carries. This marker is in every form the generator emits, including
    // the UNMEASURED one.
    name: "the generation-time updater resolution (#610)",
    probe: "Which updater runs was decided when this hook was generated (#610)",
  },
];

/**
 * The guard properties of the generated `pre-push` (#891).
 *
 * Same discipline as the table above and the same instrument check: every
 * probe must be present in the generator's own output, or the run is
 * UNMEASURED rather than a pile of refusals naming a fix the hook carries.
 */
export const PRE_PUSH_GUARD_PROPERTIES: GuardProperty[] = [
  {
    // The whole of #869's symptom. `--show-toplevel` answers "where is this
    // working tree", and in a linked worktree that is not where
    // `node_modules` lives, so every worktree push was refused as UNMEASURED
    // over a repository whose dependencies were installed the whole time.
    name: "the main-checkout modules root (#728)",
    // The ASSIGNMENT, not the flag. `--git-common-dir` on its own also
    // appears in the comment above that line explaining why it is there, so
    // a probe naming the flag reports a genuinely pre-#728 hook as carrying
    // the fix — a detector that cannot tell code from the prose about it
    // (#235). Caught by AC-3, which plants the real pre-#728 hook and
    // expects to be told which fix it predates.
    probe: "$(git rev-parse --git-common-dir)/..",
  },
  {
    // `ln -s` does not look at its target, so a link to a path that does not
    // exist succeeds and the suite then dies on an import error naming no
    // cause. This is the refusal that says which it was.
    name: "the absent-modules refusal (#728)",
    probe: "run bun install there",
  },
  {
    // Three outcomes, not two: conformity FAILED, conformity could not be
    // RUN, and conformity passed. The first two used to share a message
    // (#397), so an install that could not happen was reported as a test
    // that did not pass.
    name: "the three-outcome reading (#397)",
    probe: "unmeasured=1",
  },
];

/**
 * What this checker knows about a hook, BEYOND comparing its bytes (#891).
 *
 * Keyed by the name in `GENERATED_HOOKS`, and deliberately not part of that
 * declaration. A generator that declared the probes for its own output would
 * satisfy them by construction, which is #530 — an artifact agreeing with
 * whatever you put in it. These are assertions ABOUT the generator, so they
 * live with the thing doing the asserting.
 *
 * **A hook with no entry here is still compared, byte for byte, and still
 * reported.** That is the point: the population comes from the generator and
 * the projections come from here, so a hook this checker has never heard of
 * gets the weaker verdict rather than no verdict. AC-5 is the case.
 */
export interface HookProjection {
  properties: GuardProperty[];
  /** Does this hook embed the secret registry? Only `pre-commit` does. */
  carriesSecretScanner: boolean;
}

export const HOOK_PROJECTIONS: Record<string, HookProjection> = {
  "pre-commit": { properties: GUARD_PROPERTIES, carriesSecretScanner: true },
  "pre-push": { properties: PRE_PUSH_GUARD_PROPERTIES, carriesSecretScanner: false },
};

export function projectionFor(hookName: string): HookProjection {
  return HOOK_PROJECTIONS[hookName] ?? { properties: [], carriesSecretScanner: false };
}

/**
 * Where the hook that will actually run lives.
 *
 * `rev-parse --git-path hooks`, which is GIT's answer to this question rather
 * than a reconstruction of it. Two things make the reconstruction wrong, and
 * only the first was ever handled here:
 *
 *  - In a linked worktree `--git-dir` is `.git/worktrees/<name>`, which has no
 *    `hooks/` and never will, so a check joining `<project>/.git/hooks` would
 *    report "not installed" from every worktree in the repository — exactly
 *    where an agent runs it. `--git-path hooks` answers with the SHARED
 *    `.git/hooks`, because git treats `hooks` as a common path; measured on
 *    a real linked worktree, and asserted by AC-6 in the test.
 *  - `core.hooksPath` redirects git wholesale (#874). With it set,
 *    `<common-dir>/hooks/pre-commit` is an ordinary untracked file that
 *    nothing executes, and a verdict taken there is a verdict about a program
 *    that will never run. Measured 2026-10-21 against the previous version of
 *    this function: a repository whose hooksPath held `exit 0` and whose
 *    `.git/hooks/pre-commit` held the current generator output printed
 *    `pre-commit is current` and exited 0.
 *
 * Reading `core.hooksPath` here instead would be a SECOND decider for a
 * question git already answers, and it would have to re-implement git's own
 * resolution rules. Those rules are not obvious: a relative value is resolved
 * against the directory the hook runs from, so `core.hooksPath = relhooks`
 * means a DIFFERENT directory in each linked worktree. `--git-path` reproduces
 * that for free — it answered `relhooks` from the toplevel and `../relhooks`
 * from a subdirectory of the same repository — which is why a relative answer
 * is resolved against the directory git was asked from, and not against the
 * worktree toplevel.
 */
export function installedHookPath(projectRoot: string, hookName: string): string {
  let hooks = "";
  try {
    hooks = execFileSync("git", ["-C", projectRoot, "rev-parse", "--git-path", "hooks"], {
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
  if (!hooks) {
    throw new HookRefused("UNMEASURED", `git reported no hooks directory for ${projectRoot}`);
  }
  return join(isAbsolute(hooks) ? hooks : join(projectRoot, hooks), hookName);
}

/**
 * One registry expression, as the refusal names it (#874).
 *
 * Structurally identical to `EMBEDDED_PATTERNS` in `lib/secret-patterns.ts`,
 * declared here only because this script may not import it — see note 2 in
 * the header. The LIST is never rebuilt: it is read out of the registry
 * module at the path `--generator` names, so there is one declaration of what
 * the hook's scanner consists of and this file holds a type, not a copy.
 */
export interface RegistryPattern {
  id: string;
  ere: string;
}

export interface GeneratorOutput {
  /** The hook's file name, from the generator's own declaration (#891). */
  name: string;
  content: string;
  marker: string;
  /** Empty for a hook that does not embed the secret registry. */
  patterns: RegistryPattern[];
  /** The probes this checker knows for this hook; empty for one it does not. */
  properties: GuardProperty[];
}

/**
 * The registry expressions the generated hook does NOT carry.
 *
 * The instrument check for `missingPatternIds` below. A registry entry the
 * generator never interpolates would be reported missing from every installed
 * hook on every run — a refusal that names the wrong thing always, which is
 * the stale-probe failure `GUARD_PROPERTIES` is guarded against one table up.
 * Separate exported function so it can be driven with a synthetic list, which
 * is the only way to reach it without editing the real registry.
 */
export function patternsBlindToGenerator(
  generated: string,
  patterns: RegistryPattern[],
): string[] {
  return patterns.filter(p => !generated.includes(p.ere)).map(p => p.id);
}

/**
 * Which of the registry's expressions the installed hook is missing, by name
 * (#874).
 *
 * The byte-exact comparison below already catches a hook whose scanner has
 * drifted. What it could not do is SAY SO: on 2026-10-21 the hook installed in
 * this repository was missing tier 1's `jwt` and the whole of tiers 2 and 3,
 * and the refusal reported that it "predates the generation-time updater
 * resolution (#610)" — true, and the least consequential of the differences.
 *
 * Derived from the registry at runtime rather than from a table here. A
 * hand-written list naming `jwt` is the cheap repair and it is wrong: the
 * tenth pattern is invisible again, and the table and the registry become two
 * deciders that agree until one of them is edited.
 */
export function missingPatternIds(installed: string, patterns: RegistryPattern[]): string[] {
  return patterns.filter(p => !installed.includes(p.ere)).map(p => p.id);
}

/**
 * What `createGitHooks` writes today, obtained by RUNNING it into a scratch
 * directory rather than by re-deriving the template here.
 *
 * A second copy of the hook text in this file would be a second decider that
 * always agrees with the first: the comparison would pass while the generator
 * drifted, and no mutation of either could tell them apart.
 */
export async function generatorHooks(
  generatorRoot: string,
  projectRoot: string,
): Promise<GeneratorOutput[]> {
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

  // THE population, read from the generator (#891). A list here instead
  // would be a second decider for "which hooks does the scaffold install",
  // and it would agree with the generator right up until somebody added a
  // hook — which is exactly how `pre-push` went unchecked from #397 to #891.
  const declared = mod.GENERATED_HOOKS;
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new HookRefused(
      "UNMEASURED",
      `${modulePath} does not export a non-empty GENERATED_HOOKS, so there is no declaration ` +
        `of which hooks the scaffold installs and nothing here can say what should have been ` +
        `compared. An empty population is not a clean tree.`,
    );
  }

  // #874, hoisted out of the per-hook loop: the registry is one module and
  // the projection that reads it is one hook's, so loading it once and
  // asking `carriesSecretScanner` keeps a single declaration of both.
  const registryPath = join(generatorRoot, "lib", "secret-patterns.ts");
  let registry: any;
  try {
    registry = await import(registryPath);
  } catch (e) {
    throw new HookRefused(
      "UNMEASURED",
      `could not load the secret registry at ${registryPath}: ${firstLine(e)}. Without it ` +
        `nothing here can say WHICH patterns an installed hook is missing.`,
    );
  }
  const allPatterns = registry.EMBEDDED_PATTERNS;
  if (!Array.isArray(allPatterns) || allPatterns.length === 0) {
    throw new HookRefused(
      "UNMEASURED",
      `${registryPath} does not export a non-empty EMBEDDED_PATTERNS, so the scanner the hook ` +
        `is supposed to carry has no declaration to be compared against`,
    );
  }

  const out: GeneratorOutput[] = [];
  for (const hook of declared) {
    const name = hook?.name;
    if (typeof name !== "string" || name.length === 0 || typeof hook.script !== "function") {
      throw new HookRefused(
        "UNMEASURED",
        `${modulePath} declares a hook with no name or no script function, so one of the ` +
          `things the scaffold installs cannot be compared`,
      );
    }
    let content: string;
    try {
      // Generated FOR THE PROJECT, and written nowhere (#610). The pre-commit
      // hook names one updater, chosen from what the project declares itself
      // to be — so a scratch directory would produce the hook for an empty
      // consumer and report every real checkout as stale. And a generator
      // that could only answer by installing itself would make this check the
      // thing it is checking, over a `.git/hooks/` shared by every linked
      // worktree of the repository at once.
      content = hook.script(projectRoot);
    } catch (e) {
      throw new HookRefused(
        "UNMEASURED",
        `the ${name} generator threw for ${projectRoot}: ${firstLine(e)}`,
      );
    }
    const marker = hook.marker;
    if (typeof marker !== "string" || marker.length === 0 || !content.includes(marker)) {
      throw new HookRefused(
        "UNMEASURED",
        `the generator's own ${name} output does not carry its declared managed marker, so no ` +
          `installed ${name} could ever be recognised as managed`,
      );
    }

    const projection = projectionFor(name);
    const blind = projection.properties.filter(p => !content.includes(p.probe));
    if (blind.length > 0) {
      throw new HookRefused(
        "UNMEASURED",
        `the ${name} generator no longer contains ${blind.map(b => b.name).join(", ")}. The probe` +
          `${blind.length > 1 ? "s" : ""} in HOOK_PROJECTIONS ha${blind.length > 1 ? "ve" : "s"} ` +
          `gone stale, and a stale probe reports every installed hook as predating a fix it may ` +
          `well carry. Update the table in the same change as the generator.`,
      );
    }

    const patterns: RegistryPattern[] = projection.carriesSecretScanner ? allPatterns : [];
    const unreachable = patternsBlindToGenerator(content, patterns);
    if (unreachable.length > 0) {
      throw new HookRefused(
        "UNMEASURED",
        `the ${name} generator does not interpolate ${unreachable.join(", ")} from the registry, ` +
          `so every installed hook would be reported as missing ` +
          `${unreachable.length > 1 ? "them" : "it"}. A probe the generator cannot satisfy names ` +
          `the wrong thing on every run.`,
      );
    }
    out.push({ name, content, marker, patterns, properties: projection.properties });
  }
  return out;
}

/**
 * One hook's verdict: `null` when the installed copy IS the generator
 * output, and a CLASSIFIED reason otherwise.
 *
 * One function, one binding to mutate. The CLI below does not re-ask any of
 * these questions — a second guard answering the same question would survive
 * any mutation of this one, and both would read as covered. That includes
 * the CLASS: it is decided here, beside the reason it belongs to, and the
 * CLI renders it (#613, #879).
 *
 * **Absent is not stale (#879).** A tree with no installed hook has not
 * failed a comparison; it has not had one. A fresh clone and a CI checkout
 * are both in that state as a matter of course, and a session-start reading
 * that calls them STALE is a refusal everybody learns to ignore. The same
 * goes for a hand-written hook, whose own message says in as many words that
 * nothing here can tell you what it enforces — that is the definition of
 * unmeasured. What is STALE is narrower and exact: a hook carrying the
 * managed marker that is not what the generator emits.
 */
export interface HookVerdict {
  cls: RefusalClass;
  reason: string;
}
export function currencyRefusal(
  installed: string | null,
  generated: string,
  marker: string,
  path: string,
  patterns: RegistryPattern[],
  // No defaults (#891). A default of `"pre-commit"` here is a second
  // statement about which hooks exist, in the one function that must not
  // hold one — and it is the exact form the cheapest wrong fix takes.
  hookName: string,
  properties: GuardProperty[],
): HookVerdict | null {
  if (installed === null) {
    return {
      cls: "UNMEASURED",
      reason:
        `no ${hookName} hook is installed at ${path}, so nothing was compared. The generator is ` +
        `not the thing that runs on your commits; the file is. Re-run ` +
        `\`bun bin/rungate.ts scaffold .\`, or this script with --install.`,
    };
  }
  if (!installed.includes(marker)) {
    return {
      cls: "UNMEASURED",
      reason:
      `the hook installed at ${path} is hand-written — it does not carry the rungate managed ` +
      `marker, so it is not compared and not replaced. Nothing here can tell you whether it ` +
      `enforces the DA-owned state rule. Move it aside and re-run with --install if you want ` +
      `the generated one.`,
    };
  }
  if (installed === generated) return null;

  const missing = properties.filter(p => !installed.includes(p.probe));
  const how = `Re-run this script with --install, or \`bun bin/rungate.ts scaffold .\`.`;

  // The scanner first, and on its own sentence. A hook that predates a fix to
  // the PROJECT-STATE arm stages the wrong file; a hook whose scanner is short
  // a pattern commits the credential. Both are differences, and reporting only
  // the one the GUARD_PROPERTIES table happens to name is how the live hook
  // here was described as predating #610 while silently missing `jwt` and the
  // whole of tiers 2 and 3 (#874).
  const absent = missingPatternIds(installed, patterns);
  const scanner =
    absent.length > 0
      ? `Its secret scanner is missing ${absent.length} of the ${patterns.length} expressions ` +
        `lib/secret-patterns.ts declares: ${absent.join(", ")}. A commit from this checkout is ` +
        `not scanned for ${absent.length > 1 ? "those" : "that"}. `
      : "";

  if (missing.length > 0) {
    return {
      cls: "STALE",
      reason:
      `the hook installed at ${path} predates ${missing.map(m => m.name).join(", ")}. ` +
      // "Every commit" was right while this script only ever read one hook,
      // and became wrong the moment it read two (#891): a pre-push refusal
      // that talks about commits is a message an operator has to translate
      // before acting on it.
      `${scanner}Every ${hookName} from this checkout is running the old behaviour, whatever ` +
      `the generator says. ${how}`,
    };
  }
  if (absent.length > 0) {
    return {
      cls: "STALE",
      reason:
        `the hook installed at ${path} carries every named guard and is not byte-identical to ` +
        `the generator's output. ${scanner}${how}`,
    };
  }
  return {
    cls: "STALE",
    reason:
      `the hook installed at ${path} carries every named guard and every registry pattern but ` +
      `is not byte-identical to the generator's output, so something edited it or it predates ` +
      `a change this table does not name. ${how}`,
  };
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
  // Refused, not created (#874). Since `core.hooksPath` decides this
  // directory, it can be anywhere on disk and a `mkdir -p` here would create
  // a tree outside the repository on the strength of one config value. The
  // honest reading is that git is pointed at a directory that does not exist,
  // which is a thing to say rather than to repair. Without this the ENOENT
  // escapes as an unclassified string and the refusal carries no label at
  // all, which is #613.
  const dir = dirname(path);
  if (!existsSync(dir)) {
    throw new HookRefused(
      "INSTALL",
      `${dir} does not exist, so the hook was not written. git is pointed at it by ` +
        `core.hooksPath; create it, or clear the setting, and re-run.`,
    );
  }
  // The same refusal as the leaf, one level up. Refusing a symlinked
  // `pre-commit` because "the target may be outside this repository" and then
  // writing happily into a symlinked `hooks/` is a policy with a hole in it
  // the exact width of one directory — and since #874 the directory is chosen
  // by `core.hooksPath`, so it is the half an operator is least likely to
  // have looked at.
  //
  // Deliberately NOT a containment check against the worktree. A hooks
  // directory outside the repository is the ordinary way a team shares hooks
  // (`git config core.hooksPath ~/.githooks`), and refusing to install there
  // is the M2 wrong fix in a different costume: a correct configuration
  // turned into a refusal, which is how a check becomes one people switch
  // off. What is refused here is the write whose destination the path does
  // not state.
  let dirLink: ReturnType<typeof lstatSync> | null = null;
  try {
    dirLink = lstatSync(dir);
  } catch {
    dirLink = null;
  }
  if (dirLink?.isSymbolicLink()) {
    throw new HookRefused(
      "INSTALL",
      `${dir} is a symlink, and the hook is not written through one — the directory it resolves ` +
        `to may be nowhere near this repository. Point core.hooksPath at the real directory, or ` +
        `replace the link, and re-run.`,
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

/**
 * One reading of every hook the generator declares, taken without deciding
 * what to do about it (#879).
 *
 * The CLI raises on it and the SessionStart hook prints it. Both had to
 * exist, and the loop below is the ONE position that pairs a generated hook
 * with the file installed at its address — a hook that walked the population
 * itself would be a second decider about which hooks exist and what a
 * current one is called, agreeing with this one until the day it did not.
 */
export interface CurrencyReading {
  current: string[];
  refusals: HookVerdict[];
}

export async function readHookCurrency(
  project: string,
  generatorRoot: string,
): Promise<CurrencyReading> {
  const hooks = await generatorHooks(generatorRoot, project);

  // Every hook is read before any verdict is raised, so a stale FIRST hook
  // cannot hide the state of the ones after it. The old shape could not have
  // this problem because it only ever looked at one file, which is the
  // problem (#891).
  const current: string[] = [];
  const refusals: HookVerdict[] = [];
  for (const hook of hooks) {
    const path = installedHookPath(project, hook.name);
    // One decider, asked once per hook. The verdict is RETURNED rather than
    // printed or raised here (#613), so there is exactly one position in
    // this file that turns a refusal into a line of output and exactly one
    // that turns it into an exit code.
    const refusal = currencyRefusal(
      readIfPresent(path),
      hook.content,
      hook.marker,
      path,
      hook.patterns,
      hook.name,
      hook.properties,
    );
    if (refusal) refusals.push(refusal);
    else current.push(`${hook.name} is current at ${path}`);
  }
  return { current, refusals };
}

/**
 * The STRONGEST class present, or `null` when every hook is current.
 *
 * A tree with one stale hook and one absent one HAS a stale hook, and
 * reporting the pair as UNMEASURED would hide it; reporting a tree whose
 * hooks are merely absent as STALE is the error #879 is about, in the other
 * direction. One binding, because the CLI and the hook both need the answer
 * and two copies of this comparison would agree right up until they did not.
 */
export function currencyClass(refusals: HookVerdict[]): RefusalClass | null {
  if (refusals.some(v => v.cls === "STALE")) return "STALE";
  return refusals.length > 0 ? "UNMEASURED" : null;
}

/** Each line keeps its own WORDS; the class prefix is rendered once, by the
 * caller that reports (#613). */
export function currencyLines(refusals: HookVerdict[]): string {
  return refusals.map(v => v.reason).join("\n  ");
}

// CLI entry point. Guarded so the module can be imported by tests without
// running the check and calling process.exit.
if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const project = typeof args.project === "string" ? args.project : process.cwd();
    const generatorRoot = typeof args.generator === "string" ? args.generator : defaultGeneratorRoot();

    // An explicit zero exit is deliberately absent from both arms: success
    // falls off the end, so the "every exit goes through REFUSE_EXIT" scan
    // has no exception to carve out, and an exception is where a literal
    // exit code hides. An early zero exit written here turned four cases
    // red, which is the scan doing its job — and naming the call in this
    // comment turned the same case red a second time, because the scan
    // reads prose as code (#235).
    if (args.install === true) {
      for (const hook of await generatorHooks(generatorRoot, project)) {
        const path = installedHookPath(project, hook.name);
        installHook(path, hook.content);
        console.log(`${hook.name} installed, and current, at ${path}`);
      }
    } else {
    const { current, refusals } = await readHookCurrency(project, generatorRoot);
    for (const line of current) console.log(line);

    // One raise, after the whole population has been read. A throw inside the
    // loop would make the report depend on declaration order, and an operator
    // who fixed the first hook would discover the second only on the next run.
    //
    // Two raises, each naming its class as a LITERAL, over one call to the
    // decider. Raising once with the class held in a variable was written
    // first and is exactly what SC-2145 exists to refuse: a label that is
    // not spelled at the raise cannot be read off the source, so "every
    // class in REFUSAL_PREFIX is reachable" stops being a checkable claim
    // about this file. The comparison itself is still in one place; these
    // two arms only rename its answer.
    //
    // SC-2145 caught the first draft of this very comment, which quoted the
    // rejected call verbatim and so read as a fourteenth raise naming no
    // class. The probe cannot tell code from prose about code (#235), and
    // the fix is to not write the call — not to teach the probe about
    // comments.
    const lines = currencyLines(refusals);
    const cls = currencyClass(refusals);
    if (cls === "STALE") throw new HookRefused("STALE", lines);
    if (cls === "UNMEASURED") throw new HookRefused("UNMEASURED", lines);
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
