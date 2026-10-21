/**
 * The currency check reports on every hook the scaffold installs (#891).
 *
 * `scripts/check-installed-hook-currency.ts` joined the literal `pre-commit`
 * and compared that one file. The scaffold installs two. Measured on
 * `/Users/jhorn/Projects/rungate` on 2026-10-21, with both facts true at the
 * same moment:
 *
 *     $ bun scripts/check-installed-hook-currency.ts --project <repo>
 *     INSTALLED HOOK STALE: ... pre-commit ... missing 5 of the 13 expressions
 *
 *     lib/scaffold/pre-push-hook.ts   209 lines, MODULES_ROOT via --git-common-dir
 *     .git/hooks/pre-push             102 lines, $TOPLEVEL via --show-toplevel
 *
 * The installed `pre-push` predated #728 — a fix that shipped with its own
 * mutation battery — and the check said nothing, because it never looked
 * there. One hook named, one verdict, and a second hook rotting beside it.
 *
 * That is `.claude/rules/checks-must-be-able-to-fail.md`'s second shape, a
 * detector narrower than what it detects, and the direction of the error is
 * toward a clean report. It also produced a wrong diagnosis one issue over:
 * #869 was filed against `lib/scaffold/pre-push-hook.ts` for a defect the
 * generator had not had since #728, because the symptom came from the
 * installed copy and nothing in the tree could see the difference.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Add `"pre-push"` beside `"pre-commit"` and compare its bytes.** One
 * string, the instance goes away, and the shape is rebuilt one hook later:
 * the population is still a list in the checker, so the next hook the
 * generator gains is invisible in exactly the way `pre-push` was. A case
 * that only plants a stale `pre-push` is GREEN under it.
 *
 * So the population is DERIVED — `GENERATED_HOOKS` in `lib/scaffold/steps.ts`
 * is the one declaration, `createGitHooks` installs from it and the check
 * reads it, and AC-5 plants a generator declaring a hook this checker has
 * never heard of. That case is what does not survive the wrong fix.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { prePushHookScript } from "../../lib/scaffold/pre-push-hook";
import { GENERATED_HOOKS, preCommitHookScript } from "../../lib/scaffold/steps";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-installed-hook-currency.ts");

let FIX = "";
beforeAll(() => {
  FIX = mkdtempSync(join(tmpdir(), "rungate-891-"));
});
afterAll(() => {
  if (FIX) rmSync(FIX, { recursive: true, force: true });
});

function git(cwd: string, args: string[]) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: ["pipe", "pipe", "pipe"] });
}

/** A git checkout with the named hooks planted verbatim. */
function repo(name: string, hooks: Record<string, string | null>): string {
  const dir = join(FIX, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir], { stdio: ["pipe", "pipe", "pipe"] });
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  const hooksDir = join(dir, ".git", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  for (const [hook, body] of Object.entries(hooks)) {
    const at = join(hooksDir, hook);
    if (body === null) rmSync(at, { force: true });
    else writeFileSync(at, body, { mode: 0o755 });
  }
  return dir;
}

function run(args: string[], script = SCRIPT) {
  const r = spawnSync("bun", [script, ...args], { encoding: "utf-8" });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const against = (project: string, generator = REPO_ROOT) => [
  "--project",
  project,
  "--generator",
  generator,
];

/**
 * The pre-#728 `pre-push`, which is what is installed in this repository
 * today. Built by REVERTING the one line in the current generator output, so
 * the fixture is the real hook minus the real fix rather than a paraphrase of
 * it — and so it still carries the managed marker, which is what makes the
 * check willing to compare it at all.
 */
function pre728PrePush(): string {
  const current = prePushHookScript();
  const line =
    'MODULES_ROOT=$(cd "$TOPLEVEL" && cd "$(git rev-parse --git-common-dir)/.." && pwd) || exit $REFUSE';
  if (!current.includes(line)) {
    throw new Error(
      "the #728 modules-root line is not in the generator output — this fixture is a " +
        "paraphrase of a hook that no longer exists, and would measure nothing",
    );
  }
  return current.replace(line, "MODULES_ROOT=$TOPLEVEL");
}

describe("#891: every installed hook gets a verdict", () => {
  test("AC-1: a stale pre-push is refused BY NAME, with a current pre-commit beside it", () => {
    // The live defect, planted. The pre-commit half is what made this
    // invisible: a report that names one hook and exits 0 reads as a clean
    // tree, and on 2026-10-21 that is what this repository got.
    const dir = repo("stale-pre-push", {
      "pre-commit": preCommitHookScript(join(FIX, "stale-pre-push")),
      "pre-push": pre728PrePush(),
    });
    const r = run(against(dir));
    expect(r.code, `expected a refusal\n${r.out}${r.err}`).not.toBe(0);
    expect(r.err).toContain("pre-push");
    expect(r.err, "the pre-commit half must not be what refused").not.toMatch(
      /pre-commit[^\n]*(predates|missing|not byte-identical)/,
    );
  });

  test("AC-2: both hooks current reports current, and says so for BOTH", () => {
    // The control. Every assertion above is satisfied by a check that refuses
    // every pre-push, which would be the same defect pointing the other way.
    // The hooks are generated FOR THIS ROOT — pre-commit's content depends
    // on it (#610), so a fixture built against a different directory would
    // be stale by construction and this control would pass for the wrong
    // reason. The path is computed first and the repo planted into it.
    const dir = join(FIX, "both-current");
    const hooks: Record<string, string> = {};
    for (const h of GENERATED_HOOKS) hooks[h.name] = h.script(dir);
    repo("both-current", hooks);
    const r = run(against(dir));
    expect(r.code, `${r.out}${r.err}`).toBe(0);
    expect(GENERATED_HOOKS.length).toBeGreaterThan(1);
    for (const h of GENERATED_HOOKS) {
      expect(r.out, `${h.name} got no verdict at all`).toContain(`${h.name} is current at`);
    }
  });

  test("AC-3: the stale pre-push refusal names WHICH fix it predates", () => {
    // A byte difference is a true statement nobody can act on. #869 is what
    // that costs: an issue filed against the generator for a defect it had
    // not had since #728, because nothing said which fix the installed copy
    // was short of.
    const dir = join(FIX, "names-the-fix");
    repo("names-the-fix", {
      "pre-commit": preCommitHookScript(dir),
      "pre-push": pre728PrePush(),
    });
    const r = run(against(dir));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("the main-checkout modules root (#728)");
    // …and not the other two probes, which that hook still carries. A
    // refusal naming every guard is a refusal naming none of them.
    expect(r.err).not.toContain("the three-outcome reading (#397)");
  });

  test("AC-4: an ABSENT pre-push is reported, not read as nothing to say", () => {
    const dir = join(FIX, "absent-pre-push");
    repo("absent-pre-push", { "pre-commit": preCommitHookScript(dir), "pre-push": null });
    const r = run(against(dir));
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/no pre-push hook is installed/);
  });

  test("AC-5: a hook this checker has never heard of is reported, not skipped", () => {
    // THE case that does not survive the cheapest wrong fix. Adding the
    // string "pre-push" beside "pre-commit" satisfies AC-1 through AC-4 and
    // leaves this red, because the population has to come from the
    // generator for a third hook to be visible at all.
    //
    // `commit-msg` is deliberately a hook name this file, the checker and
    // HOOK_PROJECTIONS all say nothing about. It gets the weaker verdict —
    // bytes only, no named guards — which is the honest reading for a hook
    // nobody has written probes for, and it is a verdict rather than
    // silence.
    const gen = join(FIX, "generator-third-hook");
    mkdirSync(join(gen, "lib", "scaffold"), { recursive: true });
    const MARKER = "# Managed by rungate — a hook nobody wrote a probe for";
    const body = `#!/bin/sh\n${MARKER}\nexit 0\n`;
    writeFileSync(
      join(gen, "lib", "scaffold", "steps.ts"),
      `export const M = ${JSON.stringify(MARKER)};\n` +
        `export function third(_root: string): string { return ${JSON.stringify(body)}; }\n` +
        `export const GENERATED_HOOKS = [{ name: "commit-msg", script: third, ` +
        `marker: M, describes: "synthetic" }];\n`,
    );
    writeFileSync(
      join(gen, "lib", "secret-patterns.ts"),
      `export const EMBEDDED_PATTERNS = [{ id: "x", ere: "ZZZZ" }];\n`,
    );

    // Stale: present, managed, and not what the generator emits.
    const dir = join(FIX, "third-hook-stale");
    repo("third-hook-stale", { "commit-msg": `${body}# edited by hand\n` });
    const stale = run(against(dir, gen));
    expect(stale.code, `${stale.out}${stale.err}`).not.toBe(0);
    expect(stale.err).toContain("commit-msg");

    // …and the control, so "refuses everything" cannot pass for "reports
    // correctly". Same generator, the hook it actually emits.
    const ok = join(FIX, "third-hook-current");
    repo("third-hook-current", { "commit-msg": body });
    const clean = run(against(ok, gen));
    expect(clean.code, `${clean.out}${clean.err}`).toBe(0);
    expect(clean.out).toContain("commit-msg is current at");
  });

  test("AC-6: a generator declaring no hooks is UNMEASURED, not a clean tree", () => {
    // An empty population agrees with every installed tree, which is the
    // third shape — an assertion that holds vacuously. The reading has to
    // refuse rather than report nothing wrong.
    const gen = join(FIX, "generator-empty");
    mkdirSync(join(gen, "lib", "scaffold"), { recursive: true });
    writeFileSync(join(gen, "lib", "scaffold", "steps.ts"), `export const GENERATED_HOOKS = [];\n`);
    writeFileSync(
      join(gen, "lib", "secret-patterns.ts"),
      `export const EMBEDDED_PATTERNS = [{ id: "x", ere: "ZZZZ" }];\n`,
    );
    const dir = join(FIX, "empty-population");
    repo("empty-population", {});
    const r = run(against(dir, gen));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("UNMEASURED");
    expect(r.err).toContain("GENERATED_HOOKS");
  });

  test("AC-7: both hooks stale, both named in ONE report", () => {
    // The ordering property. A `throw` inside the loop makes the report
    // depend on declaration order, and an operator who fixed the first hook
    // would discover the second only on the next run.
    const dir = join(FIX, "both-stale");
    repo("both-stale", {
      "pre-commit": `${preCommitHookScript(dir)}# edited by hand\n`,
      "pre-push": pre728PrePush(),
    });
    const r = run(against(dir));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("pre-commit");
    expect(r.err).toContain("pre-push");
  });

  test("AC-8: the scaffold installs from the same declaration the checker reads", () => {
    // The structural half, and the one a behavioural test cannot see: a
    // second list that agrees with the first is invisible until the day it
    // does not, which is the whole of #891.
    const steps = readFileSync(join(REPO_ROOT, "lib", "scaffold", "steps.ts"), "utf-8");
    const body = steps.slice(
      steps.indexOf("export function createGitHooks("),
      steps.indexOf("export function createGitHooks(") + 2000,
    );
    expect(body, "createGitHooks does not install from the declaration").toContain(
      "for (const hook of GENERATED_HOOKS)",
    );
    for (const name of ["pre-commit", "pre-push"]) {
      expect(
        body,
        `createGitHooks names ${name} directly instead of reading it from GENERATED_HOOKS`,
      ).not.toContain(`"${name}"`);
    }

    const checker = readFileSync(
      join(REPO_ROOT, "scripts", "check-installed-hook-currency.ts"),
      "utf-8",
    );
    const code = checker.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code, "the checker no longer reads the generator's declaration").toContain(
      "mod.GENERATED_HOOKS",
    );
    // HOOK_PROJECTIONS may name hooks — it is a table of probes, not a
    // population. What must not exist is a second list of WHICH hooks there
    // are, so the names may appear only in that table.
    const outside = code.slice(code.indexOf("export function projectionFor"));
    for (const name of ["pre-commit", "pre-push"]) {
      expect(
        outside,
        `${name} is named below the projection table, which is a second population`,
      ).not.toContain(`"${name}"`);
    }
  });
});
