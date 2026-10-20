/**
 * ai-review-payload-reading.test.ts — the report step reads the payload (#816).
 *
 * Covers AC-1, AC-2, AC-3, AC-4, AC-5, AC-6.
 *
 * `anthropics/claude-code-action` refuses to run when the workflow file
 * differs from the copy on the default branch, logs
 * `Exiting due to workflow validation skip`, and **exits zero**. The report
 * step branched on `AI_REVIEW_ACTION_OUTCOME` alone, so on run 39465155816 it
 * announced
 *
 *   "The AI review completed and wrote a findings payload"
 *
 * over eleven seconds with no `num_turns`, no cost and no payload. One reading
 * was answering two questions — *did the step exit zero* and *was a review
 * written* — and only the first of them was ever asked.
 *
 * ## Everything here is EXECUTED
 *
 * The subject is a shell script, so every case runs it as bash against a real
 * directory. Asserting that `buildReviewRunScript()` contains a `-s` test
 * would assert that a template literal contains what the template literal
 * contains, and would not notice a quoting mistake that makes the test always
 * true — which is the failure mode closest to this one.
 *
 * ## AC-6: nothing reads the action's log prose
 *
 * The cheapest wrong fix is to grep the action's output for
 * `workflow validation` and report UNMEASURED when it appears. It makes the
 * symptom go away and it is a detector narrower than what it detects: the
 * sentence is upstream prose in a SHA-pinned dependency and changes when they
 * change it. The scan below is a real case rather than a comment, because the
 * prohibition is the whole reason the payload was chosen as the reading.
 *
 * ## Why not `num_turns`
 *
 * It is a good signal and it is a SECOND one. The action's execution file
 * would answer the same question the payload answers, and two deciders that
 * agree are behaviourally one — `.claude/rules/checks-must-be-able-to-fail.md`,
 * fourth shape — with the extra defect that the execution file's shape belongs
 * to a pinned upstream dependency rather than to this job.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AI_REVIEW_FINDINGS_PATH_VAR,
  AI_REVIEW_REQUIRE_VALUE,
  AI_REVIEW_REQUIRE_VAR,
  AI_REVIEW_UNMEASURED_TITLE,
  buildReviewRunScript,
} from "../lib/scaffold/ai-review-step";

const SOURCE_PATH = join(import.meta.dir, "..", "lib", "scaffold", "ai-review-step.ts");
const source = readFileSync(SOURCE_PATH, "utf-8");

/** The sentence that was false on run 39465155816. */
const COMPLETION_CLAIM = "wrote a findings payload";

const scratch: string[] = [];
afterAll(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-review-payload-"));
  scratch.push(dir);
  return dir;
}

interface Run {
  code: number;
  out: string;
  err: string;
}

/**
 * Run a report script as bash.
 *
 * `payload` is the CONTENT to write at the findings path, or `null` for a path
 * that does not exist — which is what a skipped action leaves behind.
 */
function run(opts: {
  script?: string;
  payload: string | null;
  outcome?: string;
  require?: boolean;
  unsetPath?: boolean;
}): Run {
  const dir = scratchDir();
  const scriptPath = join(dir, "report.sh");
  writeFileSync(scriptPath, opts.script ?? buildReviewRunScript());

  const findings = join(dir, "findings.json");
  if (opts.payload !== null) writeFileSync(findings, opts.payload);

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    AI_REVIEW_MODE: "vertex",
    AI_REVIEW_ACTION_OUTCOME: opts.outcome ?? "success",
  };
  if (!opts.unsetPath) env[AI_REVIEW_FINDINGS_PATH_VAR] = findings;
  if (opts.require) env[AI_REVIEW_REQUIRE_VAR] = AI_REVIEW_REQUIRE_VALUE;

  const r = Bun.spawnSync(["bash", scriptPath], { cwd: dir, env });
  return {
    code: r.exitCode,
    out: new TextDecoder().decode(r.stdout),
    err: new TextDecoder().decode(r.stderr),
  };
}

const PAYLOAD = JSON.stringify({ findings: [], verdict: "PASS" });

// ── AC-1 / AC-2 ──────────────────────────────────────────────────────────

describe("AC-1/AC-2: a success with no payload is UNMEASURED, and says why", () => {
  test("the skip is annotated and never claims a payload was written", () => {
    const r = run({ payload: null });
    expect(r.out, `stderr was:\n${r.err}`).toContain(
      `::warning title=${AI_REVIEW_UNMEASURED_TITLE}`,
    );
    expect(r.out).toContain("WITHOUT writing a findings payload");
    expect(r.out).toContain("UNMEASURED, not a passing review");
    expect(
      r.out,
      "the step still announces a completed review over a run that had none",
    ).not.toContain(COMPLETION_CLAIM);
    expect(r.code).toBe(0);
  });

  test("it names the cause a consumer will actually hit", () => {
    // A warning that does not say what happened is a warning nobody can act
    // on — `.claude/rules/config-access.md`. The consumer case is the first
    // scaffold PR, which introduces the workflow and is therefore guaranteed
    // to be skipped.
    const out = run({ payload: null }).out;
    expect(out).toContain("default branch");
    expect(out).toContain("ai-review.yml");
  });

  test("a ZERO-BYTE payload is also no review", () => {
    // `-s`, not `-f`. #492's one-byte row in
    // `.claude/rules/checks-must-be-able-to-fail.md` is this repository's own
    // record of an existence check standing in for a content property, and
    // the repair there was satisfiable by adding an empty file.
    const r = run({ payload: "" });
    expect(r.out).toContain("WITHOUT writing a findings payload");
    expect(r.out).not.toContain(COMPLETION_CLAIM);
  });

  test("an UNSET findings path is no review either", () => {
    // The prepare step did not run, so nobody can say a review happened.
    // `set -u` is on in the generated script, so this also proves the
    // expansion is written defensively rather than exploding.
    const r = run({ payload: null, unsetPath: true });
    expect(r.out, `stderr was:\n${r.err}`).toContain("WITHOUT writing a findings payload");
    expect(r.err, "the script died on an unset variable").not.toContain("unbound variable");
  });
});

// ── AC-3 ─────────────────────────────────────────────────────────────────

describe("AC-3: a consumer that required the review is refused", () => {
  test("a payload-less success exits non-zero under the require var", () => {
    const r = run({ payload: null, require: true });
    expect(r.err).toContain(`::error title=${AI_REVIEW_UNMEASURED_TITLE}`);
    expect(r.err).toContain("never ran");
    expect(r.code).not.toBe(0);
  });

  test("the control: a payload PRESENT refuses for the other reason, or not at all", () => {
    // Both halves refuse today — #675 is unadjudicated — so the case that
    // matters is that they refuse with DIFFERENT text. Identical refusals
    // would mean the split bought nothing an operator can act on.
    const withPayload = run({ payload: PAYLOAD, require: true });
    const without = run({ payload: null, require: true });
    expect(withPayload.code).not.toBe(0);
    expect(without.code).not.toBe(0);
    expect(withPayload.err).not.toBe(without.err);
    expect(withPayload.err).toContain("adjudicates");
    expect(without.err).toContain("never ran");
  });
});

// ── AC-4 ─────────────────────────────────────────────────────────────────

describe("AC-4: the pair varies only the payload", () => {
  test("one input differs, and the readings differ with it", () => {
    // #585's discipline. `AI_REVIEW_ACTION_OUTCOME` is held at `success` in
    // both runs, so a difference in what they print is a measurement of the
    // payload and of nothing else. Varying the outcome as well would make
    // this a measurement of the outcome, which is the reading that was
    // already there and the reading that was wrong.
    const present = run({ payload: PAYLOAD, outcome: "success" });
    const missing = run({ payload: null, outcome: "success" });

    expect(present.out.length, "the payload-present run printed nothing").toBeGreaterThan(0);
    expect(missing.out.length, "the payload-missing run printed nothing").toBeGreaterThan(0);
    expect(present.out).not.toBe(missing.out);
    expect(present.out).toContain(COMPLETION_CLAIM);
    expect(missing.out).not.toContain(COMPLETION_CLAIM);
  });

  test("three states, three distinct messages", () => {
    const failed = run({ payload: null, outcome: "failure" }).out;
    const skipped = run({ payload: null, outcome: "success" }).out;
    const reviewed = run({ payload: PAYLOAD, outcome: "success" }).out;
    for (const [name, text] of [
      ["failed", failed],
      ["skipped", skipped],
      ["reviewed", reviewed],
    ] as const) {
      expect(text.length, `the ${name} state printed nothing at all`).toBeGreaterThan(0);
    }
    expect(new Set([failed, skipped, reviewed]).size, "two states report identically").toBe(3);
  });
});

// ── AC-5: the regression has a witness ───────────────────────────────────

describe("AC-5: the pre-#816 script is shown reporting the false sentence", () => {
  test("removing the payload reading restores the claim over a skipped run", async () => {
    // Not a description of the defect — the defect, rebuilt and executed.
    // The input on which the mutant and the original differ, named rather
    // than assumed: `outcome=success` with no payload on disk.
    // Spelled as a plain string, not a template: the module's own source
    // carries an ESCAPED `\${...}` so that bash receives the expansion, and
    // re-deriving that through a second layer of interpolation here is how a
    // needle silently stops matching.
    const needle = 'if [ -s "';
    const count = source.split(needle).length - 1;
    if (count !== 1) {
      throw new Error(
        `could not build the mutant: the payload reading appears ${count} ` +
          `times in lib/scaffold/ai-review-step.ts`,
      );
    }
    const dir = scratchDir();
    const path = join(dir, "ai-review-step.ts");
    writeFileSync(path, source.replace(needle, 'if true; then #'));
    const mutant = (await import(path)) as { buildReviewRunScript: () => string };

    const real = run({ payload: null, outcome: "success" });
    const pre = run({ payload: null, outcome: "success", script: mutant.buildReviewRunScript() });

    expect(
      pre.out,
      "the reconstruction does not reproduce the defect, so it witnesses nothing",
    ).toContain(COMPLETION_CLAIM);
    expect(real.out).not.toContain(COMPLETION_CLAIM);
  });
});

// ── AC-6: the fix reads the payload, not the action's prose ──────────────

describe("AC-6: nothing in the reading depends on upstream log text", () => {
  test("the module never greps the action's output for its skip sentence", () => {
    // The cheapest wrong fix, refused by a case rather than by a comment.
    // Matched case-insensitively and across the whole module, because this is
    // a prohibition and the honest direction for it to be wrong in is toward
    // refusing something innocent.
    const script = buildReviewRunScript();
    for (const phrase of ["workflow validation", "validation skip", "Exiting due to"]) {
      expect(
        script.toLowerCase().includes(phrase.toLowerCase()),
        `the report script matches upstream log prose: ${phrase}`,
      ).toBe(false);
    }
  });

  test("the reading is of this job's own artefact", () => {
    // Non-emptiness first: a script that named the variable nowhere would
    // satisfy the prohibition above vacuously.
    expect(buildReviewRunScript()).toContain(AI_REVIEW_FINDINGS_PATH_VAR);
  });
});
