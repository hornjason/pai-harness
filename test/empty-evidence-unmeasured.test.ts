/**
 * Covers SC-2159, SC-2160, SC-2161, SC-2162 (GATE-CONTRACTS-SPEC.md).
 *
 * #705 — an evidence command that printed nothing was recorded as `""`, and
 * every reader downstream treats `""` as "no evidence was ever recorded".
 *
 * ## The run, and what the issue got wrong about it
 *
 * #705 is filed as *"a GREP_CHECK AC can never record evidence"*, and proposes
 * three repairs to the `GREP_CHECK` type: upgrade it unconditionally, teach
 * something to run it, or refuse it at authoring time. The run history says
 * none of those is the defect. `autoPopulateACs` keys on
 * `evidenceMethod.command` and has never looked at `type` at all, and two
 * `GREP_CHECK` ACs in the very runs the issue cites recorded evidence and
 * passed:
 *
 *     agentgrit-258b AC-2  grep -c '…' src/graph/co…   evidence "0"  PASS
 *     agentgrit-258c AC-3  grep -c '|| entry.id' …     evidence "0"  PASS
 *
 * The one that refused is `agentgrit-258d` AC-3, and it is not about the type:
 *
 *     command:  grep -n 'node?.description || node?.name || id' src/graph/context.ts;
 *               test $(grep -c 'node?.description || node?.name || id' src/graph/context.ts) -eq 0
 *     evidence: { "type": "command-output", "content": "" }
 *     verdict:  "FAIL"
 *
 * `grep -n` prints nothing when it matches nothing, and the count the author
 * meant to publish is swallowed by `$( )`. The command exits **0**, so
 * `autoPopulateACs` takes its success path, `output.split("\n").pop() || ""`
 * yields `""`, and that empty string is written to the AC as a recorded
 * measurement. `hasRecordedEvidence` in `lib/evidence-required.ts` then reads
 * `Boolean("")` as false and the verify gate refuses with
 *
 *     AC-3: threshold == 0 with NO evidence recorded (evidenceMethod.type=GREP_CHECK)
 *
 * which names the AC and its type for a fault that belongs to neither. It is
 * reachable from `COMMAND` too — the recording site never reads the type — so
 * a repair aimed at `GREP_CHECK` would have left it in place under a different
 * name.
 *
 * ## What is asserted here
 *
 * That an empty stdout is recorded as an UNMEASURED reading naming its own
 * cause. `0`, `{}`, `null`, `SKIP` and silence are indistinguishable from
 * success — and `""` is additionally indistinguishable from *absence*, which
 * is the specific confusion that cost #258 two AC rewrites.
 *
 * The verdict stays FAIL, deliberately. `gates/orchestrator.ts` advances when
 * every AC is PASS or SKIP, so marking an unmeasured AC SKIP would turn a
 * blocking gate into a passing one — the argument `autoPopulateACs` already
 * makes at its missing-ref branch, which this follows.
 *
 * ## The cheapest wrong fix, and whether these cases survive it
 *
 * **Change `output.split("\n").pop() || ""` to `|| "0"`**, matching the line
 * the catch branch already has. One character of real change, the symptom
 * disappears — AC-3 records `"0"`, `== 0` is satisfied, the gate stops
 * refusing — and every evidence command that fails to print anything then
 * CERTIFIES ABSENCE, which is exactly what a `== 0` threshold is for.
 *
 * These cases survive it: AC-2159a and AC-2159c read the recorded type and the
 * verdict, and a fabricated `"0"` is `command-output` / `PASS` under both.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { autoPopulateACs } from "../gates/gate-executor";
import { missingEvidenceViolations } from "../lib/evidence-required";

/** The pattern `agentgrit-258d` AC-3 asserted the absence of, verbatim. */
const PATTERN = "node?.description || node?.name || id";

/** A file that does not contain it, so every command below measures zero. */
const SUBJECT = "context.ts";
const SUBJECT_BODY = "export function contextFor(id: string) {\n  return lookup(id);\n}\n";

let WORK: string;

beforeEach(() => {
  WORK = mkdtempSync(join(tmpdir(), "empty-evidence-705-"));
  writeFileSync(join(WORK, SUBJECT), SUBJECT_BODY);
  // `autoPopulateACs` prefers EVIDENCE_CWD over state.projectRoot, and a value
  // inherited from an enclosing gate run would point every command below at
  // another tree.
  delete process.env.EVIDENCE_CWD;
});

afterEach(() => {
  rmSync(WORK, { recursive: true, force: true });
});

type Ac = Record<string, any>;

function drive(acs: Ac[]): Ac[] {
  const sf = join(WORK, "workflow-state.json");
  const state: Record<string, any> = { issue: 705, projectRoot: WORK, acs };
  writeFileSync(sf, JSON.stringify(state, null, 2));
  autoPopulateACs(state, sf);
  // Read back off disk rather than trusting the in-memory object: the state
  // file is the copy every gate reads, and `markCommandlessACsAsSkip` can
  // rewrite it underneath the caller.
  return JSON.parse(readFileSync(sf, "utf-8")).acs;
}

function ac(id: string, command: string): Ac {
  return {
    id,
    type: "CODE",
    statement: `the ${PATTERN} expression is absent from ${SUBJECT}`,
    threshold: { op: "==", value: 0, unit: "matching lines" },
    evidenceMethod: { type: "GREP_CHECK", command },
    verdict: "PENDING",
  };
}

// ── SC-2159 ─────────────────────────────────────────────────────────────────

describe("#705 SC-2159: a command that printed nothing is UNMEASURED, not empty evidence", () => {
  /**
   * #585's pair discipline. Both ACs assert the same property of the same
   * pattern in the same file and measure the same true answer — zero. They
   * differ in exactly one thing: whether the command PRINTS the count.
   *
   * That makes the printing half a positive control. A mutation that stopped
   * `autoPopulateACs` recording anything at all would take it down too, and
   * without it "the unmeasured half is unmeasured" is satisfied by a function
   * that measures nothing ever.
   */
  const SILENT = `grep -n '${PATTERN}' ${SUBJECT}; test $(grep -c '${PATTERN}' ${SUBJECT}) -eq 0`;
  const PRINTING = `grep -c '${PATTERN}' ${SUBJECT} || true`;

  test("AC-2159a: the silent half records an unmeasured reading that names its cause", () => {
    const [silent] = drive([ac("AC-1", SILENT)]);

    expect(silent.evidence, "nothing was recorded at all").toBeTruthy();
    expect(
      silent.evidence.type,
      `recorded as a measurement: ${JSON.stringify(silent.evidence)}`,
    ).toBe("unmeasured");
    expect(silent.evidence.content, "the reading does not say it is unmeasured").toContain(
      "UNMEASURED",
    );
    expect(
      silent.evidence.content,
      "the reading does not quote the command, so nobody can tell which one went quiet",
    ).toContain("grep -n");
  });

  test("AC-2159b: the printing half still records its measured value and passes", () => {
    const [printing] = drive([ac("AC-1", PRINTING)]);

    expect(printing.evidence?.type, "the positive control stopped recording").toBe(
      "command-output",
    );
    expect(printing.evidence?.content).toBe("0");
    expect(printing.verdict).toBe("PASS");
  });

  test("AC-2159c: an unmeasured AC does not pass, and the two halves are distinguishable", () => {
    const [silent, printing] = drive([ac("AC-1", SILENT), ac("AC-2", PRINTING)]);

    // The wrong fix's signature: a fabricated "0" makes the silent half
    // satisfy `== 0` and the two halves become the same reading.
    expect(silent.verdict, "an unmeasured AC was scored as satisfied").not.toBe("PASS");
    expect(silent.verdict, "an unmeasured AC must block, not be waved through as SKIP").toBe(
      "FAIL",
    );
    expect(
      silent.evidence?.content,
      "the two halves recorded the same thing, so nothing distinguishes measured zero from no measurement",
    ).not.toBe(printing.evidence?.content);
  });
});

// ── SC-2160 ─────────────────────────────────────────────────────────────────

describe("#705 SC-2160: the gate stops accusing the AC of carrying no evidence", () => {
  test("AC-2160a: the refusal #705 was filed over is gone", () => {
    const SILENT = `grep -n '${PATTERN}' ${SUBJECT}; test $(grep -c '${PATTERN}' ${SUBJECT}) -eq 0`;
    const acs = drive([ac("AC-3", SILENT)]);

    const violations = missingEvidenceViolations(acs);
    expect(
      violations.join("\n"),
      "the AC is still reported as having recorded no evidence, which is the #705 symptom",
    ).not.toContain("AC-3");
    expect(violations).toEqual([]);
  });

  test("AC-2160b: #277 is not weakened — an AC with genuinely absent evidence is still refused", () => {
    // The check this fix must not buy its green from. `hasRecordedEvidence` is
    // untouched: the repair is at the producing side, so an AC nobody measured
    // still has nothing to show.
    const neverRun = {
      id: "AC-9",
      type: "CODE",
      statement: "nothing ever ran this one",
      threshold: { op: "==", value: 0 },
      evidenceMethod: { type: "GREP_CHECK" },
      verdict: "PENDING",
    };
    const violations = missingEvidenceViolations([neverRun]);
    expect(violations.length, "an unmeasured AC with no evidence at all was let through").toBe(1);
    expect(violations[0]).toContain("AC-9");
  });

  test("AC-2160c: the OTHER cheap repair — widening hasRecordedEvidence — stays refused", () => {
    // The second 5pm fix for #705: leave the producer alone and teach the
    // reader that `content: ""` counts. It also makes the symptom go away, and
    // it reopens #277 for every AC whose command printed nothing — the
    // measurement is still missing, only the complaint is gone.
    //
    // #277's own file has "an empty evidence object does not" against
    // `evidence: {}`, where `content` is UNDEFINED. `undefined` is refused by
    // the widened predicate too, so that case cannot see this repair: measured
    // at 0 of 48 before this one was added. The input that reaches the branch
    // is an empty STRING, which is precisely what the pre-#705 recorder wrote.
    const emptyContent = {
      id: "AC-7",
      type: "CODE",
      statement: "the recorder wrote an empty reading",
      threshold: { op: "==", value: 0 },
      evidenceMethod: { type: "GREP_CHECK", command: `grep -n '${PATTERN}' ${SUBJECT}` },
      evidence: { type: "command-output", content: "" },
      verdict: "FAIL",
    };
    const violations = missingEvidenceViolations([emptyContent]);
    expect(
      violations.length,
      'an evidence content of "" was accepted as a recorded measurement',
    ).toBe(1);
    expect(violations[0]).toContain("AC-7");
  });
});

// ── SC-2161 ─────────────────────────────────────────────────────────────────

describe("#705 SC-2161: a command that errored records a reading rather than nothing", () => {
  test("AC-2161a: a non-zero exit with no stdout is recorded, not merely warned about", () => {
    // `grep` exits 2 on a missing file, with nothing on stdout. The pre-#705
    // code reached neither recording branch — `stdout !== "" || e.status === 1`
    // is false — so it printed a warning and left the AC with no evidence and
    // a PENDING verdict, which is the literal "can never record evidence" the
    // issue title describes.
    const [errored] = drive([ac("AC-1", `grep -c '${PATTERN}' no-such-file.ts`)]);

    expect(errored.evidence, "the command errored and nothing was recorded").toBeTruthy();
    expect(errored.evidence.type).toBe("unmeasured");
    expect(errored.verdict, "an AC nothing could measure stayed PENDING").toBe("FAIL");
    expect(missingEvidenceViolations([errored])).toEqual([]);
  });
});

// ── SC-2162 ─────────────────────────────────────────────────────────────────

describe("#705 SC-2162: the test-runner carve-out is intact", () => {
  test("AC-2162a: a bun test command with empty stdout is not called unmeasured", () => {
    // `isTestRunner` is decided by `/bun test\b/` over the command STRING, and
    // nothing else, so a no-output command carrying that substring exercises
    // exactly the branch. It is a probe of the carve-out, not of bun.
    //
    // The carve-out is load-bearing: bun writes its summary to stderr, so a
    // `bun test` invocation can legitimately leave stdout holding only the
    // version banner — or, piped, nothing at all. Calling that UNMEASURED
    // would refuse every BUN_TEST AC in the project.
    const [runner] = drive([ac("AC-1", "true >/dev/null # bun test test/x.test.ts")]);

    expect(
      runner.evidence?.type,
      "a test-runner command was reclassified as unmeasured",
    ).not.toBe("unmeasured");
    expect(runner.verdict).toBe("PASS");
  });
});
