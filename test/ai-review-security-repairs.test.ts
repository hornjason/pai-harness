/**
 * ai-review-security-repairs.test.ts — three ways past the drift check that
 * the content reading does not reach (#856).
 *
 * #853 made the drift comparison measure content instead of index state.
 * Each of these three gets past it from a direction that repair does not
 * touch, and the first one does not need the drift check to be wrong at all.
 *
 * ## F1 — one encoder, used at four of eleven sites
 *
 * `escape_annotation` was declared INSIDE `buildDriftScript` and used at four
 * annotation sites. Seven others — in the credential-relocate step, the
 * restore step, the route reading and the baseline step — interpolated a
 * shell value straight into `::error title=…::`. GitHub decodes `%0A` in an
 * annotation body, so a value carrying one becomes a line break and the text
 * after it becomes a new workflow command.
 *
 * Mixed is worse than neither, and that is the part worth stating: a reader
 * asking *is this escaped* finds `escape_annotation` in the file and stops.
 * The yes is true of four lines out of eleven.
 *
 * **The rule applied here is mechanical on purpose: every annotation that
 * interpolates a shell value goes through the encoder, whether or not the
 * value looks reachable.** Three of the seven interpolate values that are
 * generator-controlled today — `${route}` is assigned only from message
 * constants, and `${path}` comes from `AI_REVIEW_UNTRUSTED_PATHS`. Escaping
 * them costs nothing, and the alternative is a rule of the form "escape the
 * ones an attacker can reach", which requires every future editor to redo
 * the reachability analysis correctly. `AC-8` checks the mechanical rule, so
 * a new annotation that forgets the encoder fails whether or not the author
 * guessed right about reachability.
 *
 * ## F2 — the head's own .gitignore hides the reviewer's writes
 *
 * Both readings are `git status --porcelain --untracked-files=all`, which
 * honours `.gitignore`. `.gitignore` was not in the restored set, so a head
 * that adds `.claude/**` to it removes reviewer-created files under
 * `.claude/` from the baseline AND from the after-reading. The comparison is
 * a difference of two readings, and a file in neither is in no difference:
 * the drift step reports a clean tree over a reviewer that wrote whatever it
 * liked. Nothing about measuring content fixes this — the path never reaches
 * the reading to be hashed.
 *
 * ## F3 — the head's own .gitattributes collapses two blobs to one hash
 *
 * `git hash-object` applies the repository's configured filters by default,
 * so a `text`/`eol` conversion makes two different working-tree blobs hash
 * identically. Measured, with `* text eol=lf` in force:
 *
 * ```
 * worktree "x\r\n"  →  587be6b4c3f93f93c489c0111bba5596147a26cb
 * worktree "x\n"    →  587be6b4c3f93f93c489c0111bba5596147a26cb   (identical)
 * with --no-filters →  db127bf6… and 587be6b4…                    (distinct)
 * ```
 *
 * This is #853's own repair, read back: the reading it introduced is only a
 * reading of content if the hash is of the bytes on disk.
 *
 * **F2 and F3 are both required, and neither subsumes the other.**
 * `--no-filters` does nothing about the enumeration hole, because an ignored
 * path is never hashed. Restoring `.gitattributes` does nothing about a
 * conversion the BASE declares — which is why `AC-10`'s fixture puts the
 * conversion in the base commit, where the restore leaves it in place.
 *
 * ## The cheapest wrong fix, and why every case here has a clean-tree half
 *
 * Each repair is a refusal, and the cheapest wrong fix for any refusal is to
 * widen it until it fires on everything. That scores as a fix on every case
 * that asserts "the attack is caught" and measures nothing. So `AC-11` runs
 * a clean tree through all three and asserts exit 0, and the three attack
 * cases each assert the control alongside the catch.
 *
 * ## What was broken to prove it
 *
 * The battery is recorded at the bottom of this file, after the cases.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  AI_REVIEW_ANNOTATION_ESCAPE,
  AI_REVIEW_BASE_REF_VAR,
  AI_REVIEW_DRIFT_TITLE,
  AI_REVIEW_TREE_BEFORE_SHA_VAR,
  AI_REVIEW_TREE_BEFORE_VAR,
  AI_REVIEW_UNTRUSTED_PATHS,
  buildAuthDetectScript,
  buildBaselineScript,
  buildCredsRelocateScript,
  buildDriftScript,
  buildPrepareScript,
  buildRestoreScript,
  buildReviewRunScript,
} from "../lib/scaffold/ai-review-step";

const RESTORED = ".claude/rules/a-restored-rule.md";
/** Outside the restored set, so the restore step leaves it alone. */
const UNRESTORED = "src/app.ts";

const scratch: string[] = [];
afterAll(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

const GIT_ENV = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

interface Fixture {
  work: string;
  home: string;
  runnerTemp: string;
  git: (...a: string[]) => void;
  write: (rel: string, body: string) => void;
}

function sh(script: string, f: Fixture, env: Record<string, string>): Run {
  const path = join(scratchDir("ai-review-sec-script-"), "step.sh");
  writeFileSync(path, script);
  const r = Bun.spawnSync(["bash", path], {
    cwd: f.work,
    env: { ...GIT_ENV(), HOME: f.home, RUNNER_TEMP: f.runnerTemp, GITHUB_WORKSPACE: f.work, ...env },
  });
  return {
    code: r.exitCode,
    stdout: new TextDecoder().decode(r.stdout),
    stderr: new TextDecoder().decode(r.stderr),
  };
}

/**
 * A pull-request checkout. `base` populates the base commit and `head` the
 * pull request's own commit, so a case can put a file in the base (where the
 * restore leaves it) or in the head (where the restore removes it) and the
 * difference between those two is the subject of F2 and F3.
 */
function checkout(opts: {
  base?: Record<string, string>;
  head?: Record<string, string>;
} = {}): Fixture {
  const home = scratchDir("ai-review-sec-home-");
  const work = join(home, "work", "repo", "repo");
  const runnerTemp = join(home, "work", "_temp");
  mkdirSync(work, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  const origin = scratchDir("ai-review-sec-origin-");

  const git = (...a: string[]) => {
    const r = Bun.spawnSync(["git", "-C", work, ...a], { env: GIT_ENV() });
    if (r.exitCode !== 0) {
      throw new Error(`git ${a.join(" ")} failed: ${new TextDecoder().decode(r.stderr)}`);
    }
  };
  const write = (rel: string, body: string) => {
    mkdirSync(dirname(join(work, rel)), { recursive: true });
    writeFileSync(join(work, rel), body);
  };

  Bun.spawnSync(["git", "init", "-q", "-b", "main", work], { env: GIT_ENV() });
  write(RESTORED, "BASE\n");
  write("src/app.ts", "export const a = 1;\n");
  for (const [p, body] of Object.entries(opts.base ?? {})) write(p, body);
  git("add", "-A");
  git("commit", "-qm", "base");

  Bun.spawnSync(["git", "init", "-q", "--bare", origin], { env: GIT_ENV() });
  git("remote", "add", "origin", `file://${origin}`);
  git("push", "-q", "origin", "HEAD:refs/heads/main");

  write(RESTORED, "THE PULL REQUEST'S OWN EDIT\n");
  for (const [p, body] of Object.entries(opts.head ?? {})) write(p, body);
  git("add", "-A");
  git("commit", "-qm", "head");

  git("checkout", "-q", "--detach", "HEAD");
  Bun.spawnSync(["git", "-C", work, "update-ref", "-d", "refs/remotes/origin/main"], {
    env: GIT_ENV(),
  });
  return { work, home, runnerTemp, git, write };
}

function restoreAndBaseline(f: Fixture) {
  const restore = sh(buildRestoreScript(), f, { [AI_REVIEW_BASE_REF_VAR]: "main" });
  expect(restore.code, `the restore step refused:\n${restore.stderr}`).toBe(0);

  const out = join(f.runnerTemp, `github-output-${Math.random().toString(36).slice(2)}`);
  writeFileSync(out, "");
  const run = sh(buildBaselineScript(), f, { GITHUB_OUTPUT: out });
  expect(run.code, `the baseline step refused:\n${run.stderr}`).toBe(0);
  const text = readFileSync(out, "utf-8");
  const path = /^path=(.*)$/m.exec(text)?.[1] ?? "";
  expect(path, `the baseline step emitted no path:\n${text}`).not.toBe("");
  return { path, sha: /^sha256=(.*)$/m.exec(text)?.[1] ?? "" };
}

function runDrift(f: Fixture, before: string, sha: string): Run {
  return sh(buildDriftScript(), f, {
    AI_REVIEW_MODE: "vertex",
    [AI_REVIEW_TREE_BEFORE_VAR]: before,
    [AI_REVIEW_TREE_BEFORE_SHA_VAR]: sha,
  });
}

const SCRIPTS: ReadonlyArray<readonly [string, string]> = [
  ["creds-relocate", buildCredsRelocateScript()],
  ["auth-detect", buildAuthDetectScript({ config: null, mode: "none" } as never)],
  ["review-run", buildReviewRunScript()],
  ["prepare", buildPrepareScript()],
  ["restore", buildRestoreScript()],
  ["baseline", buildBaselineScript()],
  ["drift", buildDriftScript()],
];

/** Every emitted line that is an annotation AND interpolates a shell value. */
function annotationsInterpolating(script: string): string[] {
  return script
    .split("\n")
    .filter(l => l.includes('"::') && /\$\{[A-Za-z_]/.test(l));
}

// ── F1 / AC-7 / AC-8: one encoder, and it covers the baseline path ──────

describe("AC-7 (#856/F1): a delimiter fed through the BASELINE path is encoded", () => {
  test("the baseline refusal encodes git's own output", () => {
    // The baseline step interpolated `${raw}` — git's stderr — straight into
    // an annotation. `GIT_DIR` is the cheapest lever that puts a chosen
    // string in that text; in the real job the string arrives inside a
    // filename git is complaining about, which is a value the branch picks.
    const f = checkout();
    const out = join(f.runnerTemp, "github-output");
    writeFileSync(out, "");
    const r = sh(buildBaselineScript(), f, {
      GITHUB_OUTPUT: out,
      GIT_DIR: "/nonexistent/pay%0A::error::load",
    });

    expect(r.code, "the baseline step did not refuse an unreadable tree").not.toBe(0);
    expect(r.stderr, "the payload never reached the annotation, so this witnesses nothing").toContain(
      "pay%250A",
    );
    expect(r.stderr, "the raw sequence survived into the annotation").not.toContain("pay%0A");
    const lines = r.stderr.split("\n").filter(l => l.length > 0);
    expect(lines.length, `the refusal spans ${lines.length} lines:\n${r.stderr}`).toBe(1);
  });

  test("AC-11 control: the baseline step still passes on a tree it can read", () => {
    // Without this the case above is satisfied by a baseline step that
    // refuses everything, which is the cheapest wrong fix for any refusal.
    const f = checkout();
    const { path } = restoreAndBaseline(f);
    expect(readFileSync(path, "utf-8").length).toBeGreaterThan(0);
  });
});

describe("AC-8 (#856/F1): exactly one annotation-escape binding", () => {
  test("the helper is declared once in the module and reaches both scripts", () => {
    expect(AI_REVIEW_ANNOTATION_ESCAPE).toContain("escape_annotation()");
    for (const [name, script] of SCRIPTS) {
      const declarations = (script.match(/^escape_annotation\(\) \{$/gm) ?? []).length;
      expect(
        declarations,
        `the ${name} script declares escape_annotation ${declarations} times; it must be the shared binding or nothing`,
      ).toBeLessThanOrEqual(1);
    }
    expect(buildBaselineScript()).toContain(AI_REVIEW_ANNOTATION_ESCAPE);
    expect(buildDriftScript()).toContain(AI_REVIEW_ANNOTATION_ESCAPE);
  });

  test("every annotation that interpolates a shell value goes through it", () => {
    // Mechanical, not a reachability judgement. A rule of the form "escape
    // the ones an attacker can reach" asks every future editor to redo that
    // analysis correctly; this one asks them to call a function.
    const bare: string[] = [];
    let examined = 0;
    for (const [name, script] of SCRIPTS) {
      for (const line of annotationsInterpolating(script)) {
        examined += 1;
        if (!line.includes("escape_annotation")) bare.push(`${name}: ${line.trim()}`);
      }
    }
    // The coverage control: zero examined lines is perfect agreement, and is
    // what a renamed `echo` or a reshaped annotation would produce.
    expect(examined, "no annotation sites were examined, so this scan read nothing").toBeGreaterThan(
      8,
    );
    expect(bare, `annotation sites interpolating a shell value without the encoder`).toEqual([]);
  });
});

// ── F2 / AC-9: the head's .gitignore cannot hide the reviewer ───────────

describe("AC-9 (#856/F2): a head-supplied .gitignore does not hide a write", () => {
  test("a reviewer file under an ignored path is still reported", () => {
    const f = checkout({
      base: { ".gitignore": "node_modules\n" },
      head: { ".gitignore": "node_modules\n.claude/**\n" },
    });
    const { path, sha } = restoreAndBaseline(f);

    // The reviewer writes under the path the head's .gitignore covers.
    f.write(".claude/rules/planted-by-the-reviewer.md", "owned\n");
    const r = runDrift(f, path, sha);
    expect(r.code, "a write under a head-ignored path was invisible").not.toBe(0);
    expect(r.stderr).toContain("planted-by-the-reviewer.md");
  });

  test("the pair: the SAME write, with the head's .gitignore not in play", () => {
    // One thing varies — whether the head declared the ignore — so a
    // difference in verdict measures the restored path set and nothing else.
    const f = checkout({ base: { ".gitignore": "node_modules\n" } });
    const { path, sha } = restoreAndBaseline(f);
    f.write(".claude/rules/planted-by-the-reviewer.md", "owned\n");
    expect(runDrift(f, path, sha).code).not.toBe(0);
  });

  test("the restored set names the two files that decide what a reading sees", () => {
    expect(AI_REVIEW_UNTRUSTED_PATHS).toContain(".gitignore");
    expect(AI_REVIEW_UNTRUSTED_PATHS).toContain(".gitattributes");
  });

  test("AC-11 control: a clean tree with a head .gitignore still passes", () => {
    const f = checkout({
      base: { ".gitignore": "node_modules\n" },
      head: { ".gitignore": "node_modules\n.claude/**\n" },
    });
    const { path, sha } = restoreAndBaseline(f);
    const r = runDrift(f, path, sha);
    expect(r.code, `a clean tree was refused:\n${r.stderr}`).toBe(0);
  });
});

// ── F3 / AC-10: a conversion cannot collapse two blobs ──────────────────

describe("AC-10 (#856/F3): a declared conversion does not hide an edit", () => {
  test("two differing working-tree blobs still hash differently", () => {
    // The conversion is in the BASE commit, where the restore leaves it —
    // restoring `.gitattributes` is F2's repair and does nothing here, which
    // is why both repairs are required and neither subsumes the other.
    //
    // Measured: under `* text eol=lf`, `git hash-object` returns
    // 587be6b4… for both "x\r\n" and "x\n"; `--no-filters` returns
    // db127bf6… and 587be6b4….
    // The file is OUTSIDE the restored set on purpose. A restored path is
    // overwritten by the restore step, so a pre-baseline edit to one never
    // reaches the baseline — the first draft used `RESTORED` and the case
    // was red for that reason rather than for the filter.
    //
    // It must also be dirty in BOTH readings, which is why the reviewer's
    // version differs from the committed one. An edit that returns a file
    // to its committed content drops out of porcelain entirely, and the
    // comparison only reports lines the after-reading ADDS.
    const f = checkout({ base: { ".gitattributes": "* text eol=lf\n" } });
    f.write(UNRESTORED, "export const a = 2;\r\n");
    const { path, sha } = restoreAndBaseline(f);

    // The reviewer rewrites it with the line ending the conversion
    // normalises away. Same normalised form, different bytes on disk.
    f.write(UNRESTORED, "export const a = 2;\n");
    const r = runDrift(f, path, sha);
    expect(
      r.code,
      "an edit the declared conversion normalises away was invisible to the reading",
    ).not.toBe(0);
    expect(r.stderr).toContain(UNRESTORED);
  });

  test("AC-11 control: the same conversion, and nothing edited, still passes", () => {
    const f = checkout({ base: { ".gitattributes": "* text eol=lf\n" } });
    f.write(UNRESTORED, "export const a = 2;\r\n");
    const { path, sha } = restoreAndBaseline(f);
    const r = runDrift(f, path, sha);
    expect(r.code, `a clean tree under a conversion was refused:\n${r.stderr}`).toBe(0);
  });
});

// ── AC-11: the three repairs together do not refuse an ordinary run ─────

describe("AC-11 (#856): all three repairs, one ordinary pull request", () => {
  test("a clean tree passes and a reviewer write is still caught", () => {
    // Both halves in one case on purpose: "it passes" is satisfied by a
    // check that was deleted, and "it refuses" is satisfied by a check that
    // refuses everything. Neither sentence is worth anything alone.
    const f = checkout({
      base: { ".gitignore": "node_modules\n", ".gitattributes": "* text eol=lf\n" },
      head: { ".gitignore": "node_modules\n.claude/**\n" },
    });
    const { path, sha } = restoreAndBaseline(f);
    expect(runDrift(f, path, sha).code, "an untouched tree was refused").toBe(0);

    f.write(".claude/rules/planted-by-the-reviewer.md", "owned\n");
    expect(runDrift(f, path, sha).code, "a reviewer write was not caught").not.toBe(0);
  });
});
