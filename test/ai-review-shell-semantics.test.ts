/**
 * ai-review-shell-semantics.test.ts — the verdict step runs under the shell
 * GitHub gives it, and not the one the suite happened to give it (#1110).
 *
 * ## The gap
 *
 * GitHub's default shell for a `run:` step is `/usr/bin/bash -e {0}` — every
 * job log echoes it. Under `-e` an assignment whose value comes from a command
 * substitution takes the substitution's exit status, and a non-zero status
 * aborts the shell on that line. The adjudication was a plain assignment:
 *
 *     adjudication=$(cd … && bunx … ai-review-findings … 2>&1)
 *     adjudicated=$?
 *     printf '%s\n' "${adjudication}"
 *
 * so for every non-zero adjudication — which is EVERY blocking finding and
 * EVERY failure to start — the shell died on the first of those three lines.
 * No `adjudicated`, no `printf`, no `case`, no UNMEASURED annotation. Measured
 * live on run `39711570020`: 1.8 seconds, no stdout at all, exit 1.
 *
 * Every case that drove that branch ran the script as plain `bash`, where the
 * same code works. The defect is invisible to the whole existing suite, and
 * that — not the missing `||` — is what this file exists to fix.
 *
 * ## Why the exit code cannot be the assertion
 *
 * `AI_REVIEW_REQUIRED_EXIT` is `1`. A shell aborted by `-e` on a statement
 * that returned 1 also exits 1. So the broken step and the working step agree
 * on the one number a required check reads, and a case asserting only the exit
 * code is green against both. **The discriminator is stdout**: the outcome
 * line either reaches the reader or it does not.
 *
 * The one state where the code does discriminate is an adjudicator that cannot
 * start. Broken, the shell carries the adjudicator's own `127` out of the job,
 * past the mapped constant entirely; fixed, it is the mapped exit with the
 * UNMEASURED annotation beside it. `AC-3` is that pair.
 *
 * ## The cheapest wrong fix, named and measured
 *
 * The repair someone reaches for when a shell case is awkward is to run the
 * script the easy way — `bash <script>`, no `-e`. `AC-4` below performs it: it
 * reconstructs the pre-fix statement into a mutant and shows that mutant
 * passing the outcome-line assertion under plain `bash` and failing it under
 * `bash -e`. The `-e` is the entire test; without it the case certifies the
 * defect it was written to catch.
 *
 * ## The artefact, not the generator
 *
 * Every case reads `.github/workflows/ai-review.yml`. A builder compared to
 * itself agrees by construction (#530); the file GitHub executes is the only
 * document that can disagree with the generator.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AI_REVIEW_FINDINGS_COMMAND,
  AI_REVIEW_FINDINGS_PATH_VAR,
  AI_REVIEW_JOB,
  AI_REVIEW_OUTCOME_LINE,
  AI_REVIEW_REQUIRED_EXIT,
  AI_REVIEW_RUN_STEP_ID,
  AI_REVIEW_UNMEASURED_TITLE,
  AI_REVIEW_WORKFLOW_FILE,
} from "../lib/scaffold/ai-review-step";

const ROOT = join(import.meta.dir, "..");
const COMMITTED = join(ROOT, ".github", "workflows", AI_REVIEW_WORKFLOW_FILE);

/** The shell GitHub supplies, spelled once. `{0}` is the script path. */
const RUNNER_SHELL_FLAGS = ["-e"];

const dirs: string[] = [];
function scratchDir(): string {
  const d = mkdtempSync(join(tmpdir(), "rungate-ai-review-shell-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * The script's STATEMENTS, with comment-only lines dropped.
 *
 * Not a nicety. The fix's own comment quotes the form it installed — "`||
 * adjudicated=$?` AND NOT A PLAIN ASSIGNMENT" — so a `toContain` over the raw
 * script is satisfied by the prose and stays green against a script whose
 * code was reverted. Measured: the first draft of AC-4's mutation-landed
 * assertion failed for exactly that reason, which is the only reason this
 * helper exists.
 */
function codeOf(script: string): string {
  return script
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

/** The verdict step's bash, out of the COMMITTED workflow document. */
function committedRunScript(): string {
  const doc = Bun.YAML.parse(readFileSync(COMMITTED, "utf-8")) as any;
  const step = (doc?.jobs?.[AI_REVIEW_JOB]?.steps ?? []).find(
    (s: any) => s?.id === AI_REVIEW_RUN_STEP_ID,
  );
  if (step === undefined) {
    throw new Error(`the committed workflow has no ${AI_REVIEW_RUN_STEP_ID} step`);
  }
  const script = String(step.run ?? "");
  if (!script.includes(AI_REVIEW_FINDINGS_COMMAND)) {
    throw new Error(
      `the committed ${AI_REVIEW_RUN_STEP_ID} step does not invoke ` +
        `'${AI_REVIEW_FINDINGS_COMMAND}', so every case below would drive a step that ` +
        `adjudicates nothing (#1110)`,
    );
  }
  return script;
}

/**
 * A `bunx` on PATH that answers for the adjudicator, as `/bin/sh`.
 *
 * Stubbed rather than resolved: the step names `rungate@<generating version>`
 * and a real resolution would make these cases a test of what npm served
 * today. What is under test here is the SHELL, so the adjudicator only has to
 * produce the two observable properties the step reads — whether an outcome
 * line is printed, and the exit code.
 */
function plantBunx(dir: string, body: string): string {
  writeFileSync(join(dir, "bunx"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`;
}

const BLOCKING = `echo "${AI_REVIEW_OUTCOME_LINE} BLOCKED"\nexit ${AI_REVIEW_REQUIRED_EXIT}`;
const CLEAN = `echo "${AI_REVIEW_OUTCOME_LINE} CLEAN"\nexit 0`;
/** What a shell reports for a command it cannot find — a `bunx` with no bun. */
const CANNOT_START = "exit 127";

/**
 * Run a script with a planted adjudicator and a payload on disk.
 *
 * The environment is built from scratch rather than inherited, for the reason
 * every runner in this repo does it: an inherited variable is a fixture that
 * can satisfy the assertion without the feature.
 */
function runStep(
  script: string,
  adjudicator: string,
  flags: string[],
): { status: number | null; stdout: string; stderr: string } {
  const dir = scratchDir();
  const sh = join(dir, "verdict.sh");
  writeFileSync(sh, script);

  // The payload is non-empty: the branch under test is guarded by `[ -s … ]`,
  // and a zero-byte file takes a different route entirely.
  const payload = join(dir, "ai-review-findings.json");
  writeFileSync(payload, JSON.stringify({ findings: [], verdict: "block" }));

  const r = spawnSync("bash", [...flags, sh], {
    encoding: "utf-8",
    cwd: dir,
    timeout: 60_000,
    env: {
      PATH: plantBunx(dir, adjudicator),
      HOME: dir,
      AI_REVIEW_MODE: "vertex",
      AI_REVIEW_ACTION_OUTCOME: "success",
      [AI_REVIEW_FINDINGS_PATH_VAR]: payload,
    },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * The pre-#1110 statement, reconstructed from the shipped one.
 *
 * Used by AC-4 only, to measure the wrong fix against the code the wrong fix
 * would have certified. It throws rather than returning the input unchanged
 * when it cannot find its target — a mutation that silently does not apply
 * comes back green and is indistinguishable from a check that cannot fail.
 */
function unfixed(script: string): string {
  const lines = script.split("\n");
  const at = lines.findIndex(
    (l) => !l.trim().startsWith("#") && l.trimEnd().endsWith("|| adjudicated=$?"),
  );
  if (at < 0) {
    throw new Error(
      "the shipped verdict step no longer carries '|| adjudicated=$?', so there is " +
        "nothing for this mutation to undo and AC-4 would measure the fixed script twice",
    );
  }
  const indent = lines[at].match(/^\s*/)![0];
  lines[at] = `${lines[at].replace(/\s*\|\|\s*adjudicated=\$\?\s*$/, "")}\n${indent}adjudicated=$?`;
  // The seed line exists only to serve the `||` branch; leaving it behind
  // would make the mutant a third thing rather than the code that shipped.
  const seed = lines.findIndex((l) => !l.trim().startsWith("#") && l.trim() === "adjudicated=0");
  if (seed < 0) {
    throw new Error("the shipped verdict step does not seed 'adjudicated=0' (#1110)");
  }
  lines.splice(seed, 1);
  return lines.join("\n");
}

describe("#1110: the verdict step under the shell GitHub actually supplies", () => {
  test("AC-0: the instrument — the shipped step carries the guarded form, and the stub answers", () => {
    // The control every case below rests on. A script that does not reach the
    // adjudicator, or a `bunx` the shell cannot find, would make each
    // assertion below fail or pass for a reason that is not its subject.
    const script = committedRunScript();
    const code = codeOf(script);
    expect(
      code,
      `the shipped verdict step's adjudication is a plain assignment again — under ` +
        `'bash ${RUNNER_SHELL_FLAGS.join(" ")}' it aborts the shell and nothing below it runs (#1110)`,
    ).toContain("|| adjudicated=$?");
    expect(code).toContain("adjudicated=0");

    // And the stub really is what runs: a clean adjudication is the one state
    // `-e` never touched, so if this does not reach stdout the harness is
    // broken rather than the subject.
    const sanity = runStep(script, CLEAN, []);
    expect(
      sanity.stdout,
      `the planted adjudicator never reached the step:\n${sanity.stdout}\n${sanity.stderr}`,
    ).toContain(AI_REVIEW_OUTCOME_LINE);
  });

  test("AC-1: a blocking finding reaches stdout under `bash -e` — the headline witness", () => {
    // THE case. Red before #1110's fix, green after. The adjudicator prints an
    // outcome line and exits non-zero, which is what every blocking review
    // does, and the step must still SAY what it found.
    //
    // Asserted on stdout and not on the exit code, deliberately: a shell
    // aborted by `-e` on a statement returning 1 exits 1, and
    // AI_REVIEW_REQUIRED_EXIT is 1. The two states agree on the number.
    const r = runStep(committedRunScript(), BLOCKING, RUNNER_SHELL_FLAGS);
    expect(
      r.stdout,
      `the step produced no '${AI_REVIEW_OUTCOME_LINE}' line under 'bash ` +
        `${RUNNER_SHELL_FLAGS.join(" ")}', which is the shell GitHub runs it with. The ` +
        `finding's own text was captured into the shell and thrown away, and the check ` +
        `reports a bare exit code nobody can attribute (#1110).\n` +
        `stdout:${JSON.stringify(r.stdout)}\nstderr:${JSON.stringify(r.stderr)}`,
    ).toContain(AI_REVIEW_OUTCOME_LINE);
    expect(r.stdout).toContain("BLOCKED");
    expect(
      r.status,
      `a blocking finding reported a GREEN ai-review check:\n${r.stdout}\n${r.stderr}`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
  });

  test("AC-2: a clean finding still exits 0 under `bash -e` — the direction control", () => {
    // CONTROL, not a witness: an adjudicator exiting 0 never tripped `-e`, so
    // this row is green before the fix and after it. It is here because
    // without it "the gate fires" cannot be told from "the gate is stuck
    // closed", which is the failure mode that gets a required check deleted.
    const r = runStep(committedRunScript(), CLEAN, RUNNER_SHELL_FLAGS);
    expect(r.stdout).toContain("CLEAN");
    expect(
      r.status,
      `a clean review failed the check:\n${r.stdout}\n${r.stderr}`,
    ).toBe(0);
  });

  test("AC-3: an adjudicator that cannot start is UNMEASURED and exits the mapped code", () => {
    // The second witness, and the only state where the exit code discriminates
    // on its own: broken, the shell died carrying the adjudicator's own 127 out
    // of the job, past AI_REVIEW_REQUIRED_EXIT entirely and with no annotation.
    // This is #1013's three-way discrimination, which `-e` had deleted.
    const r = runStep(committedRunScript(), CANNOT_START, RUNNER_SHELL_FLAGS);
    expect(
      r.stderr,
      `an adjudicator that could not start produced no '${AI_REVIEW_UNMEASURED_TITLE}' ` +
        `annotation, so a registry that is down and a blocking finding are again the same ` +
        `reading from outside the job (#1110)\nstdout:${r.stdout}\nstderr:${r.stderr}`,
    ).toContain(AI_REVIEW_UNMEASURED_TITLE);
    expect(
      r.status,
      `the job exited ${r.status} rather than the mapped ${AI_REVIEW_REQUIRED_EXIT} — the ` +
        `adjudicator's own code escaped the step`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
  });

  test("AC-4: the cheapest wrong fix, measured — plain `bash` passes against the BROKEN script", () => {
    // Why AC-1 is written with `-e` and not without it. The same assertion,
    // against the code that shipped the defect, under the shell the rest of
    // the suite uses. It passes. A regression test for #1110 that omits the
    // flag certifies the regression at the moment it arrives.
    const script = committedRunScript();
    const mutant = unfixed(script);

    // The mutation is verified to have LANDED before anything is read off it,
    // and verified over STATEMENTS — the fix's comment quotes the form it
    // installed, so a raw `toContain` here would pass over the prose while
    // the code had reverted.
    expect(mutant, "the mutation did not change the script").not.toBe(script);
    const mutantCode = codeOf(mutant);
    expect(
      mutantCode,
      "the mutant still carries the guard it was built to remove",
    ).not.toContain("|| adjudicated=$?");
    expect(
      mutantCode,
      "the mutant lost the adjudicator command, so it is not the pre-fix script",
    ).toContain(AI_REVIEW_FINDINGS_COMMAND);
    expect(mutantCode).toContain("adjudicated=$?");
    expect(mutantCode, "the mutant kept the seed line").not.toContain("adjudicated=0");

    const wrongFix = runStep(mutant, BLOCKING, []);
    expect(
      wrongFix.stdout,
      "a test running the generated step as plain `bash` was expected to pass against the " +
        "UNFIXED script — if it does not, this row is no longer measuring the wrong fix",
    ).toContain(AI_REVIEW_OUTCOME_LINE);

    const realShell = runStep(mutant, BLOCKING, RUNNER_SHELL_FLAGS);
    expect(
      realShell.stdout,
      "the unfixed script printed the outcome line under `bash -e`, so `-e` is not what " +
        "AC-1 is measuring and the defect #1110 describes is not reproducible here",
    ).not.toContain(AI_REVIEW_OUTCOME_LINE);
  });
});
