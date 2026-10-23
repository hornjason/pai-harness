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
  AI_REVIEW_OVERRIDE_LABEL,
  AI_REVIEW_OVERRIDE_VALUE,
  AI_REVIEW_OVERRIDE_VAR,
  AI_REVIEW_REQUIRE_VALUE,
  AI_REVIEW_REQUIRE_VAR,
  AI_REVIEW_REQUIRED_EXIT,
  AI_REVIEW_UNMEASURED_TITLE,
  AI_REVIEW_WAIVED_TITLE,
  buildAuthDetectScript,
  buildReviewRunScript,
} from "../lib/scaffold/ai-review-step";
import { stubBunxAbsent } from "./helpers/stub-bunx";

/**
 * A fixture version for the adjudicator's `bunx` pin (#1013), never the
 * real one. `buildReviewRunScript` takes the generating version as an
 * argument; passing `harnessVersion()` here would make every assertion
 * below agree with the generator by construction.
 */
const FIXTURE_VERSION = "0.0.0-fixture";


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
  /** #1180: the pull-request label that waives a no-payload refusal. */
  waive?: boolean;
  /** #1180: the resolved credential mode, `vertex` unless a case says otherwise. */
  mode?: string;
  unsetPath?: boolean;
}): Run {
  const dir = scratchDir();
  const scriptPath = join(dir, "report.sh");
  writeFileSync(scriptPath, opts.script ?? buildReviewRunScript(FIXTURE_VERSION));

  const findings = join(dir, "findings.json");
  if (opts.payload !== null) writeFileSync(findings, opts.payload);

  const env: Record<string, string> = {
    PATH: stubBunxAbsent(),
    AI_REVIEW_MODE: opts.mode ?? "vertex",
    AI_REVIEW_ACTION_OUTCOME: opts.outcome ?? "success",
    // #1242. The runner always sets this, and since #1242 the waiver branches
    // write the marker that disarms auto-merge into it and REFUSE when they
    // cannot. A runner that omits it drives a script no runner ever runs.
    GITHUB_OUTPUT: join(dir, "github_output"),
  };
  if (!opts.unsetPath) env[AI_REVIEW_FINDINGS_PATH_VAR] = findings;
  if (opts.require) env[AI_REVIEW_REQUIRE_VAR] = AI_REVIEW_REQUIRE_VALUE;
  if (opts.waive) env[AI_REVIEW_OVERRIDE_VAR] = AI_REVIEW_OVERRIDE_VALUE;

  const r = Bun.spawnSync(["bash", "-e", scriptPath], { cwd: dir, env });
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
    // #1180 inverted this line, and the line is the whole issue. It read
    // `toBe(0)`: the step named the state UNMEASURED in a warning and then
    // exited 0, so the annotation was the only difference between "reviewed
    // and found clean" and "nobody looked" — and nothing in a check list
    // shows an annotation. Measured on PR #1154, `ai-review` reported success
    // in 14 seconds, on a repository where it is one of two required checks
    // and auto-merge is the standing policy.
    expect(
      r.code,
      "a reviewer that wrote no payload still passes the required check",
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
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
    // The unadjudicated state's own phrase. Since #1013's review this
    // refusal no longer mentions the require var at all — it fires whether
    // or not a consumer opted in — so the sentence to match on is the one
    // about the reading that did not happen.
    expect(withPayload.err).toContain("produced no reading");
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

    // BOTH streams on each side (#1013 review): the payload-present state
    // refuses on stderr and the payload-missing state warns on stdout, so
    // comparing one stream across the pair would find them "different"
    // because one of them is empty, which is a distinction about plumbing
    // rather than about the reading.
    const presentText = `${present.out}${present.err}`;
    const missingText = `${missing.out}${missing.err}`;
    expect(presentText.length, "the payload-present run printed nothing").toBeGreaterThan(0);
    expect(missingText.length, "the payload-missing run printed nothing").toBeGreaterThan(0);
    expect(presentText).not.toBe(missingText);
    expect(presentText).toContain(COMPLETION_CLAIM);
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
    //
    // Narrowed from a bare `if [ -s "` when #826 added a second `-s` test —
    // for the action's execution file, one branch below. The abort fired
    // rather than the mutation landing on the wrong line, which is what the
    // count is for, and the repair is to name the reading rather than to
    // raise the expected count.
    // Still a plain string for the reason above: the source carries the
    // CONSTANT's name, not its value, so the needle names the constant too.
    //
    // Narrowed a SECOND time, for the same reason and by the repair the
    // paragraph above prescribes. #826's failure-branch routes gave the
    // payload a reading on that branch too — correctly: the sentence there
    // asserted "no findings payload was written" without ever stat'ing the
    // path. So there are now two honest readings of this variable and the
    // needle has to say WHICH. The success branch's sits inside
    // `if [ "${AI_REVIEW_ACTION_OUTCOME}" = success ]` and is indented two
    // spaces; the failure branch's is at column 0. The leading newline and
    // indent are the discriminator, and the count below still aborts if a
    // third one appears rather than mutating a line nobody chose.
    //
    // It aborted once more in #1207, which added a payload reading to the
    // failure branch's waiver at this exact indent, and the repair was the
    // one prescribed above rather than a wider needle: that reading is
    // spelled `! -s` — "waive only when there is nothing to adjudicate",
    // which is what the branch means — so it is a different string and this
    // needle still names one line. Nothing here was loosened to let it
    // through; if you are about to raise the count, read that comment first.
    const needle = '\n  if [ -s "\\${${AI_REVIEW_FINDINGS_PATH_VAR}:-}" ]';
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
    const mutant = (await import(path)) as { buildReviewRunScript: (version: string) => string };

    const real = run({ payload: null, outcome: "success" });
    const pre = run({ payload: null, outcome: "success", script: mutant.buildReviewRunScript(FIXTURE_VERSION) });

    expect(
      `${pre.out}${pre.err}`,
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
    const script = buildReviewRunScript(FIXTURE_VERSION);
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
    expect(buildReviewRunScript(FIXTURE_VERSION)).toContain(AI_REVIEW_FINDINGS_PATH_VAR);
  });
});

// ── #1180: the refusal is unconditional, and the waiver is the only way out ──

/**
 * #1180. The states above all held before this issue; what did not hold is
 * that any of them cost anything. Every one of them exited 0 unless
 * `RUNGATE_REQUIRE_AI_REVIEW` was set, and on this repository it never has
 * been — the variable 404s. So `ai-review` went green in 14 seconds on
 * PR #1154 having read nothing, while being one of two required checks on a
 * repository that auto-merges on them.
 *
 * The general form is worse than the instance and is what these cases are
 * mostly about: the action refuses to review a workflow file that differs
 * from the copy on the default branch, so **the one file the gate's
 * correctness depends on was the only file a pull request could change
 * without review.** That is the shape of every real attack on a review
 * control and also the shape of an honest mistake, which is likelier here.
 */
describe("#1180: a reviewer that wrote no payload fails whether or not the flag is set", () => {
  test("#1180: the refusal does not consult the require switch", () => {
    // The pair, varying ONE input. Both refuse, so the flag is not the
    // decider — which is the claim. A single run could not tell "refuses
    // because the flag happens to be set in this fixture" from "refuses".
    const off = run({ payload: null });
    const on = run({ payload: null, require: true });
    expect(off.code, "a payload-less review still passes with the flag unset").toBe(
      AI_REVIEW_REQUIRED_EXIT,
    );
    expect(on.code).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(off.err).toContain(`::error title=${AI_REVIEW_UNMEASURED_TITLE}`);
  });

  test("#1180: the refusal says the flag is not what refused", () => {
    // A refusal that reads as the flag's doing sends the next operator to
    // unset the flag, which is both the wrong lever and not set.
    const err = run({ payload: null }).err;
    expect(err).toContain("does NOT consult");
    expect(err).toContain(AI_REVIEW_REQUIRE_VAR);
  });

  test("#1180: the label waives the refusal and names itself in the output", () => {
    // UNMEASURED-and-waived is a THIRD state. It is green like CLEAN and
    // measured like neither, so it carries its own title: #1180 asks that a
    // reader of the check list can tell them apart, and an annotation that
    // shares the UNMEASURED title cannot be told from the warning above it.
    const r = run({ payload: null, waive: true });
    expect(r.code, "the waiver did not waive, so the gate is a lockout").toBe(0);
    expect(r.out).toContain(`::warning title=${AI_REVIEW_WAIVED_TITLE}`);
    expect(r.out).toContain(AI_REVIEW_OVERRIDE_LABEL);
    expect(r.out, "a waived run claims a review it did not have").not.toContain(
      COMPLETION_CLAIM,
    );
  });

  test("#1180: a waived run still prints the route it waived", () => {
    // The waiver is read AFTER the warning for this reason: a green run that
    // dropped the explanation would be the fail-open with a label in front
    // of it, and the operator who applied the label would have nothing to
    // read about what they waived.
    const r = run({ payload: null, waive: true });
    expect(r.out).toContain("WITHOUT writing a findings payload");
    expect(r.out).toContain("default branch");
  });

  test("#1180: the waiver cannot turn a BLOCKING review green", () => {
    // The waiver's blast radius, asserted rather than intended. It sits in
    // the no-payload branch only; a payload that exists is adjudicated and
    // the adjudicator's exit code is the step's, label or no label. A waiver
    // that reached the verdict would be a one-label bypass of every finding
    // the reviewer has ever written, which is strictly worse than #1180.
    const waived = run({ payload: PAYLOAD, waive: true });
    const plain = run({ payload: PAYLOAD });
    expect(waived.code, "the waiver reached past the no-payload branch").not.toBe(0);
    expect(waived.code).toBe(plain.code);
    expect(waived.out, "the adjudicated branch emitted the waiver's title").not.toContain(
      AI_REVIEW_WAIVED_TITLE,
    );
  });

  test("#1180: an unconfigured tree is still not reddened by this", () => {
    // The scope line, and the reason the flag survives. The module header's
    // standing promise is that a tree which has never configured a
    // credential does not get a red pipeline on its first scaffold — no
    // review was ATTEMPTED there, which is a different fact from a reviewer
    // that ran and produced nothing. `mode=none` must still exit 0.
    expect(run({ payload: null, mode: "none" }).code).toBe(0);
  });

  test("#1180: the cheapest wrong fix is the flag, and it is a lockout", () => {
    // Named and MEASURED, not dismissed in prose. The 5pm repair for #1180
    // is to set RUNGATE_REQUIRE_AI_REVIEW=true and change no code. It does
    // make the measured instance red — and it is the wrong fix twice over.
    //
    // Here: with the flag set and NOTHING else, a payload-less run has no
    // route to green at all. On a repository with enforce_admins on, that is
    // not a strict gate, it is a workflow file that can never be changed
    // again — including to fix the gate. The waiver is what separates the
    // two, and the pair below is the measurement: same flag, one input
    // different.
    const lockedOut = run({ payload: null, require: true });
    const waivedUnderFlag = run({ payload: null, require: true, waive: true });
    expect(lockedOut.code).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(
      waivedUnderFlag.code,
      "the waiver does not reach the flagged path, so setting the flag is a lockout",
    ).toBe(0);
  });

  test("#1180: and the flag reddens the first scaffold, which is the auth step's", () => {
    // The flag's OTHER cost, measured on the step that actually carries it.
    // A tree with no credential has not had a review; the module header's
    // standing promise is that this state annotates rather than reddens, and
    // the flag breaks that promise for every consumer who sets it to fix
    // #1180. The refusal in this pull request does not, because it fires
    // only where a credential resolved and the action ran.
    const dir = scratchDir();
    const scriptPath = join(dir, "auth.sh");
    writeFileSync(scriptPath, buildAuthDetectScript({ config: null, reason: "no vertex config in this fixture" }));
    const spawn = (env: Record<string, string>) =>
      Bun.spawnSync(["bash", "-e", scriptPath], {
        cwd: dir,
        env: { PATH: "/bin:/usr/bin", GITHUB_OUTPUT: join(dir, "out.txt"), ...env },
      }).exitCode;
    expect(spawn({}), "an unconfigured tree reddens before the flag is even set").toBe(0);
    expect(
      spawn({ [AI_REVIEW_REQUIRE_VAR]: AI_REVIEW_REQUIRE_VALUE }),
      "the flag does not redden an unconfigured tree, so it has no cost to weigh",
    ).not.toBe(0);
  });
});
