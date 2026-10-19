import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { AI_REVIEW_REQUIRED_EXIT } from "../lib/scaffold/ai-review-step";
import { stripJsComments } from "../lib/strip-js-comments";
import type { AiReviewUnmeasuredReason } from "../lib/scaffold/ai-review-findings";
import {
  AI_REVIEW_FINDINGS_KEY,
  AI_REVIEW_SEVERITIES,
  AI_REVIEW_VERDICT_KEY,
  aiReviewExitCode,
  aiReviewRefusal,
  readAiReviewFindings,
  readAiReviewFindingsFile,
  severityBlocks,
} from "../lib/scaffold/ai-review-findings";

/**
 * Covers AC-8a, AC-8b, AC-8c, AC-8d (#631 — the AI review findings contract).
 *
 * The defect this file exists against is #295, named in the issue: the reader
 * asked for `reading.broken`, a key no writer ever produced, so the list was
 * empty on every run and every FAIL fell through to "no broken ids were
 * recorded". An absent key reads as an empty list reads as clean. So the key
 * is declared ONCE in the module and asserted to be spelled once — a second
 * literal is a second contract, and the two can drift without either side
 * failing to compile.
 *
 * The blocking decision is computed from the findings' SEVERITIES. The agent's
 * verdict word never decides it; it is read only to notice that the agent
 * contradicted its own payload. `prevalidationViolations` in
 * `gates/workflow.test.ts` is the shape being copied: "a PASS carrying broken
 * ids is a contradiction, not a pass".
 */

const MODULE_PATH = join(import.meta.dir, "..", "lib", "scaffold", "ai-review-findings.ts");
const source = readFileSync(MODULE_PATH, "utf-8");

let SCRATCH = "";

beforeAll(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "ai-review-findings-"));
});

afterAll(() => {
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
});

let fixtureSeq = 0;

/** Write a findings document to disk and return its path. */
function fixtureFile(body: string): string {
  const path = join(SCRATCH, `findings-${fixtureSeq++}.json`);
  writeFileSync(path, body);
  return path;
}

// ── AC-8a: one declaration, one spelling ─────────────────────────────────
//
// The scanner looks for the key as a QUOTED LITERAL or as a property access,
// over a comment-stripped copy: the word is all over the prose of that module
// and prose is not a contract. Every read of the key in the module goes
// through `obj[AI_REVIEW_FINDINGS_KEY]`, so the declaration's own initializer
// is the only spelling that survives the strip.

export function keySpellings(src: string): string[] {
  const code = stripJsComments(src);
  return (code.match(/(["'`])findings\1|\.findings\b|\bfindings\s*:/gi) || []).map(m => m.trim());
}

describe("AC-8a: the findings key is declared once and spelled once", () => {
  test("AC-8a: the constant is exported and assigned exactly once", () => {
    const decls = stripJsComments(source).match(/AI_REVIEW_FINDINGS_KEY\s*=/g) || [];
    expect(
      decls.length,
      "more than one assignment to AI_REVIEW_FINDINGS_KEY — a second one is a " +
        "second contract, and the writer can satisfy either",
    ).toBe(1);
    expect(source).toContain("export const AI_REVIEW_FINDINGS_KEY");
    expect(AI_REVIEW_FINDINGS_KEY.length, "the key is empty").toBeGreaterThan(0);
  });

  test("AC-8a: the key is spelled exactly once in the whole module", () => {
    const spellings = keySpellings(source);
    expect(
      spellings.length,
      `the key is spelled ${spellings.length} times (${spellings.join(", ")}) — ` +
        `every read must go through AI_REVIEW_FINDINGS_KEY`,
    ).toBe(1);

    // …and the one spelling is the declaration's own initializer, not some
    // other site that happens to be the only one left.
    expect(stripJsComments(source)).toMatch(
      new RegExp(`AI_REVIEW_FINDINGS_KEY\\s*=\\s*["']${AI_REVIEW_FINDINGS_KEY}["']`),
    );
  });

  test("AC-8a: a second literal fails this case — the mutation, performed", () => {
    // Proving the guard above can fail. The cheapest way a second spelling
    // arrives is somebody inlining the key at a read site, so that is the
    // mutation: one `[AI_REVIEW_FINDINGS_KEY]` read replaced by the literal.
    //
    // The mutation is applied to the COMMENT-STRIPPED copy. Applied to the
    // raw source it lands on the first match, which is the constant's own
    // docstring, and a mutation the scanner strips back out is a mutation
    // that was never applied.
    const code = stripJsComments(source);
    const mutated = code.replace(/\[\s*AI_REVIEW_FINDINGS_KEY\s*\]/, `["${AI_REVIEW_FINDINGS_KEY}"]`);
    expect(
      mutated,
      "could not build the mutant: no `[AI_REVIEW_FINDINGS_KEY]` read in the module",
    ).not.toBe(code);
    expect(keySpellings(mutated).length).toBe(2);
  });
});

// ── AC-8b: absent, unparseable, and missing-the-key are all UNMEASURED ───

describe("AC-8b: a findings file that cannot be read is UNMEASURED, and refuses", () => {
  const cases: Array<
    [string, () => ReturnType<typeof readAiReviewFindings>, AiReviewUnmeasuredReason]
  > = [
    [
      "absent",
      () => readAiReviewFindingsFile(join(SCRATCH, "no-such-file.json")),
      "FINDINGS_FILE_ABSENT",
    ],
    [
      "unparseable",
      () => readAiReviewFindingsFile(fixtureFile('{"verdict": "PASS", ')),
      "FINDINGS_UNPARSEABLE",
    ],
    [
      "well-formed, no declared key",
      () => readAiReviewFindingsFile(fixtureFile('{"verdict": "PASS", "results": []}')),
      "FINDINGS_KEY_ABSENT",
    ],
  ];

  for (const [label, read, reason] of cases) {
    test(`AC-8b: ${label} reads UNMEASURED and refuses`, () => {
      const r = read();
      expect(r.outcome, `${label} did not read UNMEASURED`).toBe("UNMEASURED");
      expect(r.unmeasuredReasons, `${label} named no reason`).toContain(reason);
      expect(r.blocked, `${label} derived a blocking decision it cannot have`).toBeNull();
      expect(aiReviewExitCode(r), `${label} did not refuse`).toBe(AI_REVIEW_REQUIRED_EXIT);
      const refusal = aiReviewRefusal(r);
      expect(refusal, `${label} refused without saying why`).not.toBeNull();
      expect(refusal).toContain("UNMEASURED");
    });
  }

  test("AC-8b: none of the three reads clean", () => {
    // Stated as its own case because that is the claim: three different
    // failures, zero of them indistinguishable from a review that found
    // nothing. A clean reading exits 0 and refuses nothing.
    for (const [label, read] of cases) {
      const r = read();
      expect(r.outcome, `${label} read CLEAN`).not.toBe("CLEAN");
      expect(aiReviewExitCode(r), `${label} exited 0`).not.toBe(0);
    }
  });

  test("AC-8b: an empty findings list is CLEAN, so UNMEASURED is not unconditional", () => {
    const r = readAiReviewFindings(`{"${AI_REVIEW_VERDICT_KEY}": "PASS", "findings": []}`);
    expect(r.outcome, `an honest clean review refused: ${r.unmeasuredReasons.join(", ")}`).toBe(
      "CLEAN",
    );
    expect(aiReviewExitCode(r)).toBe(0);
    expect(aiReviewRefusal(r)).toBeNull();
  });

  test("AC-8b: a finding with no severity is UNMEASURED, not non-blocking", () => {
    // The #295 trap one level down: an absent severity must not read as a
    // severity that does not block.
    const r = readAiReviewFindings('{"verdict": "PASS", "findings": [{"title": "x"}]}');
    expect(r.outcome).toBe("UNMEASURED");
    expect(r.unmeasuredReasons).toContain("SEVERITY_ABSENT");
    expect(r.blocked).toBeNull();
  });

  test("AC-8b: an unrecognised severity is UNMEASURED, not non-blocking", () => {
    const r = readAiReviewFindings(
      '{"verdict": "PASS", "findings": [{"severity": "spicy", "title": "x"}]}',
    );
    expect(r.outcome).toBe("UNMEASURED");
    expect(r.unmeasuredReasons).toContain("SEVERITY_UNRECOGNISED");
    expect(severityBlocks("spicy"), "an unknown severity must not classify").toBeNull();
  });
});

// ── AC-8c: a PASS carrying a blocking finding is a contradiction ─────────

describe("AC-8c: a verdict contradicting its own payload is refused", () => {
  test("AC-8c: PASS with a blocking finding is a contradiction, not a pass", () => {
    const r = readAiReviewFindings(
      '{"verdict": "PASS", "findings": [{"severity": "critical", "title": "creds in a log"}]}',
    );
    expect(
      r.outcome,
      "a PASS carrying a blocking severity was waved through — this is the " +
        "fail-open that survives every test written only against the happy path",
    ).toBe("CONTRADICTION");
    expect(aiReviewExitCode(r)).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(aiReviewRefusal(r)).toContain("contradict");
    expect(r.blocked, "the severities still decide, contradiction or not").toBe(true);
  });

  test("AC-8c: BLOCK with nothing blocking is the same contradiction, other way round", () => {
    const r = readAiReviewFindings(
      '{"verdict": "BLOCK", "findings": [{"severity": "low", "title": "a nit"}]}',
    );
    expect(r.outcome).toBe("CONTRADICTION");
    expect(r.blocked).toBe(false);
    expect(aiReviewExitCode(r)).toBe(AI_REVIEW_REQUIRED_EXIT);
  });

  test("AC-8c: an agreeing verdict is not a contradiction", () => {
    // Without this the contradiction could be unconditional, and the word
    // would stop meaning anything.
    const blocking = readAiReviewFindings(
      '{"verdict": "BLOCK", "findings": [{"severity": "high", "title": "x"}]}',
    );
    expect(blocking.outcome).toBe("BLOCKED");
    const clean = readAiReviewFindings(
      '{"verdict": "PASS", "findings": [{"severity": "low", "title": "x"}]}',
    );
    expect(clean.outcome).toBe("CLEAN");
    expect(aiReviewExitCode(clean)).toBe(0);
  });
});

// ── AC-8d: the severities decide; the verdict word does not ──────────────

describe("AC-8d: the blocking decision is computed from the severities", () => {
  test("AC-8d: the verdict table declares at least one blocking and one advisory severity", () => {
    const values = Object.values(AI_REVIEW_SEVERITIES);
    expect(values.filter(Boolean).length, "no severity blocks anything").toBeGreaterThan(0);
    expect(values.filter(v => !v).length, "every severity blocks").toBeGreaterThan(0);
  });

  test("AC-8d: a pair varying ONLY the verdict word decides the same way", () => {
    // #585's pair discipline: one document is written, the other is DERIVED
    // from it by replacing the verdict word, so the pair cannot carry a second
    // difference. Two hand-written literals could.
    const blockDoc = '{"verdict": "BLOCK", "findings": [{"severity": "critical", "title": "x"}]}';
    const passDoc = blockDoc.replace('"BLOCK"', '"PASS"');
    expect(passDoc, "the derivation changed nothing").not.toBe(blockDoc);
    expect(
      passDoc.replace('"PASS"', '"BLOCK"'),
      "the pair differs in more than the verdict word",
    ).toBe(blockDoc);

    const a = readAiReviewFindings(blockDoc);
    const b = readAiReviewFindings(passDoc);
    expect(a.blocked, "the verdict word changed the blocking decision").toBe(b.blocked);
    expect(a.blocked).toBe(true);
    expect(a.blockingReported?.length).toBe(1);
    expect(b.blockingReported?.length).toBe(1);
    // Both refuse. One is a block, one is a block plus a lie about it.
    expect(aiReviewExitCode(a)).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(aiReviewExitCode(b)).toBe(AI_REVIEW_REQUIRED_EXIT);
  });

  test("AC-8d: a fixture file on disk carrying a real blocking finding turns the case red", () => {
    const blocking = JSON.stringify({
      verdict: "BLOCK",
      findings: [
        { severity: "low", title: "a nit" },
        { severity: "critical", title: "the credentials file is echoed into the job log" },
      ],
    });
    const path = fixtureFile(blocking);
    const r = readAiReviewFindingsFile(path);
    expect(r.outcome, `${path} did not block`).toBe("BLOCKED");
    expect(r.blocked).toBe(true);
    expect(r.blockingReported?.length, "the advisory finding was counted as blocking").toBe(1);
    expect(aiReviewExitCode(r)).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(aiReviewRefusal(r)).toContain("critical");

    // Vary exactly one field — the severity of the one blocking finding —
    // and the decision flips. Same verdict word, same number of findings.
    const advisory = blocking.replace('"critical"', '"low"');
    expect(advisory, "the derivation changed nothing").not.toBe(blocking);
    const lowered = readAiReviewFindingsFile(fixtureFile(advisory));
    expect(lowered.blocked, "the severity did not decide").toBe(false);

    // It still refuses, because the verdict now disagrees with its payload.
    // Bringing the verdict back into line is what makes the file green, and
    // that is a SECOND field, changed in its own step so the two are not one
    // assertion.
    const green = readAiReviewFindingsFile(fixtureFile(advisory.replace('"BLOCK"', '"PASS"')));
    expect(green.outcome, "lowering the severity did not clear the block").toBe("CLEAN");
    expect(aiReviewExitCode(green)).toBe(0);
  });
});
