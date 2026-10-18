import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AI_REVIEW_AUTH_PRECEDENCE,
  AI_REVIEW_MODES,
  AI_REVIEW_REQUIRED_EXIT,
  AI_REVIEW_REQUIRE_VAR,
  buildAuthDetectScript,
  buildAuthDetectStep,
} from "../lib/scaffold/ai-review-step";

/**
 * Covers AC-1, AC-5, AC-6, AC-6b (#630 — the ai-review auth-detect step).
 *
 * The thing under test is a SCRIPT, so every case below runs it. Asserting on
 * the generated text would be asserting that a template literal contains what
 * the template literal contains — `.claude/rules/checks-must-be-able-to-fail.md`
 * calls that an assertion that holds vacuously.
 *
 * The refusal cases run TWICE: once against the real builder, and once against
 * a mutant copy of `lib/scaffold/ai-review-step.ts` whose single exit-code
 * constant is set to 0. The second run is the evidence — a case asserting only
 * "exit code != 0" cannot tell a refusal from a crash or a bash syntax error.
 *
 * The input on which the mutant and the original differ, named here rather than
 * assumed: no credential in the environment and `RUNGATE_REQUIRE_AI_REVIEW=true`.
 * The real script exits 1; the mutant exits 0. Every other input in this file
 * exits 0 under both, which is why only the required-and-absent case is run
 * against the mutant.
 */

const SOURCE_PATH = join(import.meta.dir, "..", "lib", "scaffold", "ai-review-step.ts");
const source = readFileSync(SOURCE_PATH, "utf-8");

const SECRETS = ["GCP_SA_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

// ── Running the generated script ─────────────────────────────────────────

let SCRATCH = "";

beforeAll(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "ai-review-step-"));
});

afterAll(() => {
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  /** The `name=value` lines the step wrote to `$GITHUB_OUTPUT`. */
  outputs: string;
  /** The single mode the step resolved, or null if it resolved none at all. */
  mode: string | null;
}

let runSeq = 0;

/**
 * Execute a generated script with an environment built from scratch.
 *
 * Inheriting `process.env` would be a fixture that can satisfy the assertion
 * without the feature: a developer with a real `ANTHROPIC_API_KEY` exported
 * would see the "no credentials" cases resolve a mode and the refusal cases
 * go green for the wrong reason.
 */
function runScript(script: string, env: Record<string, string>): Run {
  const dir = join(SCRATCH, `run-${runSeq++}`);
  const sh = join(dir, "auth-detect.sh");
  const outFile = join(dir, "github_output");
  spawnSync("mkdir", ["-p", dir]);
  writeFileSync(sh, script);
  writeFileSync(outFile, "");

  const r = spawnSync("bash", [sh], {
    encoding: "utf-8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? dir,
      GITHUB_OUTPUT: outFile,
      ...env,
    },
  });

  const outputs = readFileSync(outFile, "utf-8");
  const modes = [...outputs.matchAll(/^mode=(.*)$/gm)].map(m => m[1]);
  expect(
    modes.length,
    `the step wrote ${modes.length} mode lines to $GITHUB_OUTPUT — a step that ` +
      `resolves "exactly one" mode must write exactly one\n${outputs}`,
  ).toBeLessThanOrEqual(1);

  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    outputs,
    mode: modes.length === 1 ? modes[0] : null,
  };
}

// ── The mutant ───────────────────────────────────────────────────────────
//
// A copy of the module with `AI_REVIEW_REQUIRED_EXIT` set to 0, written to a
// temp directory OUTSIDE the repo and imported from there. Running it from
// there is what proves the module has no relative imports: a later
// `from "../config-loader"` would make the mutant die on module resolution,
// and an import that throws reads as "the mutation was rejected on the merits"
// when in fact the mutant never ran.

let mutantScript = "";

beforeAll(async () => {
  const mutated = source.replace(/AI_REVIEW_REQUIRED_EXIT\s*=\s*1\b/, "AI_REVIEW_REQUIRED_EXIT = 0");
  if (mutated === source) {
    throw new Error(
      "could not build the mutant: no `AI_REVIEW_REQUIRED_EXIT = 1` in " +
        "lib/scaffold/ai-review-step.ts",
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "ai-review-mutant-"));
  const path = join(dir, "ai-review-step.ts");
  writeFileSync(path, mutated);
  const mod = (await import(path)) as { buildAuthDetectScript: () => string };
  mutantScript = mod.buildAuthDetectScript();
  rmSync(dir, { recursive: true, force: true });
});

// ── AC-6b: one exit constant, and nothing bypasses it ────────────────────

describe("AC-6b: the non-zero exit is routed through one exported constant", () => {
  test("AC-6b: AI_REVIEW_REQUIRED_EXIT is assigned exactly once", () => {
    const decls = source.match(/AI_REVIEW_REQUIRED_EXIT\s*=/g) || [];
    expect(
      decls.length,
      "more than one assignment to AI_REVIEW_REQUIRED_EXIT — the mutant would " +
        "only neutralise one of them",
    ).toBe(1);
  });

  test("AC-6b: it is exported, so a caller reads the refusal rather than guessing it", () => {
    expect(source).toContain("export const AI_REVIEW_REQUIRED_EXIT");
    expect(AI_REVIEW_REQUIRED_EXIT).not.toBe(0);
  });

  test("AC-6b: no refusal inlines a non-zero exit literal", () => {
    // Only the generated bash has lines beginning `exit `; TypeScript has no
    // such statement, so this reads the emitted script's exits out of the
    // template without needing to run it.
    const exits = source
      .split("\n")
      .map(l => l.trim())
      .filter(l => /^exit\s/.test(l))
      .map(l => l.replace(/^exit\s+/, "").trim());

    expect(exits.length, "no exit at all in the generated script").toBeGreaterThan(0);
    for (const code of exits) {
      expect(
        code,
        `\`exit ${code}\` bypasses AI_REVIEW_REQUIRED_EXIT, so the mutant cannot ` +
          `neutralise it and the refusal case below would pass for the wrong reason`,
      ).toMatch(/^(0|\$\{AI_REVIEW_REQUIRED_EXIT\})$/);
    }
  });

  test("AC-6b: the module has no relative imports", () => {
    const rel = source.match(/from\s+["']\.{1,2}\//g) || [];
    expect(rel, "a relative import would make the mutant fail to resolve").toEqual([]);
  });
});

// ── AC-1: exactly one of four modes, in precedence order ─────────────────

describe("AC-1: the builder resolves exactly one of four modes", () => {
  test("AC-1: the precedence list is the three credentials, in order, plus none", () => {
    expect(AI_REVIEW_AUTH_PRECEDENCE.map(e => e.secret)).toEqual([...SECRETS]);
    expect(AI_REVIEW_MODES.length).toBe(4);
    expect(AI_REVIEW_MODES[AI_REVIEW_MODES.length - 1]).toBe("none");
    expect([...new Set(AI_REVIEW_MODES)].length, "two modes share a name").toBe(4);
  });

  test("AC-1: each credential alone resolves its own mode", () => {
    const script = buildAuthDetectScript();
    for (const { secret, mode } of AI_REVIEW_AUTH_PRECEDENCE) {
      const r = runScript(script, { [secret]: "x" });
      expect(r.mode, `${secret} alone should resolve ${mode}\n${r.stdout}${r.stderr}`).toBe(mode);
      expect(r.code, `${secret} alone must not fail the job`).toBe(0);
    }
  });

  test("AC-1: no credential resolves none", () => {
    const r = runScript(buildAuthDetectScript(), {});
    expect(r.mode).toBe("none");
  });

  test("AC-1: precedence is GCP_SA_KEY, then CLAUDE_CODE_OAUTH_TOKEN, then ANTHROPIC_API_KEY", () => {
    const script = buildAuthDetectScript();
    // Each case sets the winner AND every credential below it, so a script
    // that simply checked them in the wrong order would resolve the loser.
    for (let i = 0; i < AI_REVIEW_AUTH_PRECEDENCE.length; i++) {
      const env: Record<string, string> = {};
      for (let j = i; j < AI_REVIEW_AUTH_PRECEDENCE.length; j++) {
        env[AI_REVIEW_AUTH_PRECEDENCE[j].secret] = "x";
      }
      const r = runScript(script, env);
      expect(
        r.mode,
        `with ${Object.keys(env).join(", ")} all set, ` +
          `${AI_REVIEW_AUTH_PRECEDENCE[i].secret} wins`,
      ).toBe(AI_REVIEW_AUTH_PRECEDENCE[i].mode);
    }
  });

  test("AC-1: an empty secret is an absent secret", () => {
    // An unset GitHub secret interpolates to the empty string, so `-n` rather
    // than `-v` is the only reading that matches what the runner produces.
    const r = runScript(buildAuthDetectScript(), { GCP_SA_KEY: "", ANTHROPIC_API_KEY: "x" });
    expect(r.mode).toBe("api-key");
  });

  test("AC-1: no mode is decided in an `if:` expression", () => {
    const step = buildAuthDetectStep();
    const conditions = step
      .split("\n")
      .map(l => l.trim())
      .filter(l => /^if\s*:/.test(l));
    expect(
      conditions,
      "a step-level `if:` makes the step report skipped, which can satisfy a " +
        "required status check — the mode has to be decided inside `run:`",
    ).toEqual([]);

    // The credentials may appear in `env:` and in the script. They must not
    // appear inside a `${{ }}` expression outside `env:` — `secrets` is not
    // available in `if:` at all, and a `vars` condition is the same trap.
    const runIndex = step.indexOf("run: |");
    expect(runIndex, "the step has no run block").toBeGreaterThan(-1);
    const head = step.slice(0, runIndex);
    for (const secret of [...SECRETS, AI_REVIEW_REQUIRE_VAR]) {
      const lines = head.split("\n").filter(l => l.includes(secret));
      expect(lines.length, `${secret} is not passed to the step`).toBeGreaterThan(0);
      for (const line of lines) {
        expect(
          line.trim(),
          `${secret} is read somewhere other than an env mapping: ${line.trim()}`,
        ).toMatch(new RegExp(`^${secret}:\\s*\\$\\{\\{\\s*(secrets|vars)\\.${secret}\\s*\\}\\}$`));
      }
    }
  });
});

// ── AC-5: mode none annotates UNMEASURED rather than passing silently ────

describe("AC-5: mode none is UNMEASURED, not silence", () => {
  test("AC-5: a warning annotation naming UNMEASURED is emitted", () => {
    const r = runScript(buildAuthDetectScript(), {});
    const annotations = r.stdout.split("\n").filter(l => l.startsWith("::warning"));
    expect(
      annotations.length,
      `mode none printed no ::warning annotation — a silent pass is exactly ` +
        `what this exists to prevent\n${r.stdout}`,
    ).toBe(1);
    expect(annotations[0]).toContain("UNMEASURED");
    for (const secret of SECRETS) expect(annotations[0]).toContain(secret);
  });

  test("AC-5: a resolved mode emits no UNMEASURED annotation", () => {
    // Without this the annotation could be unconditional, and "UNMEASURED"
    // would stop meaning anything.
    for (const { secret } of AI_REVIEW_AUTH_PRECEDENCE) {
      const r = runScript(buildAuthDetectScript(), { [secret]: "x" });
      expect(r.stdout, `${secret} resolved a mode and still warned`).not.toContain("UNMEASURED");
    }
  });

  test("AC-5: the UNMEASURED-not-silent wording is recorded in config-access.md", () => {
    const rule = readFileSync(
      join(import.meta.dir, "..", ".claude", "rules", "config-access.md"),
      "utf-8",
    );
    // Search the slice, not the document: "UNMEASURED" already appears in the
    // Silent Default Substitution bullet, so a whole-file search is satisfied
    // by text that says nothing about credentials.
    const heading = "## An absent credential is UNMEASURED, not a silent pass";
    const start = rule.indexOf(heading);
    expect(start, `${heading} is not in .claude/rules/config-access.md`).toBeGreaterThan(-1);
    const rest = rule.slice(start + heading.length);
    const end = rest.indexOf("\n## ");
    const section = (end === -1 ? rest : rest.slice(0, end)).trim();

    expect(section.length, "the section is empty — a heading is not a rule").toBeGreaterThan(200);
    expect(section).toContain("UNMEASURED");
    expect(section).toContain(AI_REVIEW_REQUIRE_VAR);
    for (const secret of SECRETS) expect(section).toContain(secret);
  });
});

// ── AC-6: the required-review variable, and only the string "true" ───────

describe("AC-6: mode none fails only when RUNGATE_REQUIRE_AI_REVIEW is the string true", () => {
  test("AC-6: the string true with no credential exits non-zero", () => {
    const r = runScript(buildAuthDetectScript(), { [AI_REVIEW_REQUIRE_VAR]: "true" });
    expect(r.code, `expected a refusal\n${r.stdout}${r.stderr}`).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(r.mode).toBe("none");

    const mutant = runScript(mutantScript, { [AI_REVIEW_REQUIRE_VAR]: "true" });
    expect(
      mutant.code,
      `the mutant (AI_REVIEW_REQUIRED_EXIT = 0) still exited ${mutant.code} — ` +
        `this case is not being caught by the refusal under test\n${mutant.stderr}`,
    ).toBe(0);
    expect(mutant.mode, "the mutant stopped resolving a mode, so it is not a mutant").toBe("none");
  });

  test("AC-6: every other value of the variable exits zero", () => {
    const script = buildAuthDetectScript();
    const cases: Array<[string, Record<string, string>]> = [
      ["unset", {}],
      ["empty", { [AI_REVIEW_REQUIRE_VAR]: "" }],
      ["TRUE", { [AI_REVIEW_REQUIRE_VAR]: "TRUE" }],
      ["True", { [AI_REVIEW_REQUIRE_VAR]: "True" }],
      ["1", { [AI_REVIEW_REQUIRE_VAR]: "1" }],
      ["yes", { [AI_REVIEW_REQUIRE_VAR]: "yes" }],
      ["false", { [AI_REVIEW_REQUIRE_VAR]: "false" }],
      ["true with trailing space", { [AI_REVIEW_REQUIRE_VAR]: "true " }],
    ];
    for (const [label, env] of cases) {
      const r = runScript(script, env);
      expect(r.code, `${label} must not fail the job\n${r.stdout}${r.stderr}`).toBe(0);
      expect(r.mode, `${label} changed the resolved mode`).toBe("none");
      expect(
        r.stdout,
        `${label} exits zero, but it must still say the review is UNMEASURED`,
      ).toContain("UNMEASURED");
    }
  });

  test("AC-6: the variable does not fail a job that DID review", () => {
    // The refusal is about an unmeasured review, not about the variable. A
    // script that read the variable first would fail every job on a tree that
    // sets it, which is the cheapest wrong fix for "make it required".
    for (const { secret } of AI_REVIEW_AUTH_PRECEDENCE) {
      const r = runScript(buildAuthDetectScript(), {
        [secret]: "x",
        [AI_REVIEW_REQUIRE_VAR]: "true",
      });
      expect(r.code, `${secret} resolved a mode and the job still failed`).toBe(0);
    }
  });
});
