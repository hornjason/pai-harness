import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { AI_REVIEW_REQUIRED_EXIT, buildReviewPrompt } from "../lib/scaffold/ai-review-step";
import { stripJsComments } from "../lib/strip-js-comments";
import type { AiReviewUnmeasuredReason } from "../lib/scaffold/ai-review-findings";
import {
  AI_REVIEW_DETAIL_MAX,
  AI_REVIEW_FINDING_FIELDS,
  AI_REVIEW_FINDINGS_KEY,
  AI_REVIEW_SEVERITIES,
  AI_REVIEW_VERDICT_KEY,
  aiReviewExitCode,
  aiReviewRefusal,
  escapeAnnotation,
  main,
  readAiReviewFindings,
  readAiReviewFindingsFile,
  renderFinding,
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

/**
 * The contract's declaring module — `ai-review-step.ts`, beside the prompt.
 *
 * AC-8a's claim is "one declaration, one spelling", and the population it has
 * to hold over is BOTH modules. Scanning only the reader would let the key be
 * re-typed in the writer, which is the two-contracts state the criterion is
 * about, pointing the other way. The pair is scanned as one document.
 */
const CONTRACT_PATH = join(import.meta.dir, "..", "lib", "scaffold", "ai-review-step.ts");
const contractSource = readFileSync(CONTRACT_PATH, "utf-8");
const bothSources = `${contractSource}\n${source}`;

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

/**
 * The lines `main` writes to stderr, as GitHub's parser would see them.
 *
 * Counting LINES is the whole measurement. An in-process assertion that the
 * string "does not contain a newline" would be satisfied by a reader that
 * dropped the hostile value entirely, and asserting on the composed refusal
 * instead of on what reaches the stream would skip the one hop — the
 * `console.error` interpolation — where the encoding has to happen.
 */
function captureStderr(fn: () => unknown): string[] {
  const written: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void written.push(args.map(String).join(" "));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return written.join("\n").split("\n").filter(l => l.length > 0);
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
    // Over the PAIR. An `export const` in each module compiles, reads
    // correctly in either diff, and is two contracts.
    const decls = stripJsComments(bothSources).match(/AI_REVIEW_FINDINGS_KEY\s*=/g) || [];
    expect(
      decls.length,
      "more than one assignment to AI_REVIEW_FINDINGS_KEY across the reader " +
        "and its contract module — a second one is a second contract, and the " +
        "writer can satisfy either",
    ).toBe(1);
    expect(contractSource).toContain("export const AI_REVIEW_FINDINGS_KEY");
    expect(AI_REVIEW_FINDINGS_KEY.length, "the key is empty").toBeGreaterThan(0);
  });

  test("AC-8a: the reader re-exports the contract rather than restating it", () => {
    // The direction is forced: ai-review-step.ts carries no relative imports,
    // because test/ai-review-scaffold.test.ts runs a mutant copy of it from a
    // temp directory. So the contract cannot live in the reader.
    expect(
      stripJsComments(contractSource),
      "the contract module imports the reader — the mutant copy will not resolve",
    ).not.toMatch(/from\s+["']\.\//);
    expect(stripJsComments(source)).toMatch(
      /import\s*\{[^}]*AI_REVIEW_FINDINGS_KEY[^}]*\}\s*from\s*["']\.\/ai-review-step["']/s,
    );
  });

  test("AC-8a: the key is spelled exactly once across both modules", () => {
    const spellings = keySpellings(bothSources);
    expect(
      spellings.length,
      `the key is spelled ${spellings.length} times (${spellings.join(", ")}) — ` +
        `every read must go through AI_REVIEW_FINDINGS_KEY`,
    ).toBe(1);

    // …and the one spelling is the declaration's own initializer, not some
    // other site that happens to be the only one left.
    expect(stripJsComments(contractSource)).toMatch(
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
    const code = stripJsComments(bothSources);
    const mutated = code.replace(/\[\s*AI_REVIEW_FINDINGS_KEY\s*\]/, `["${AI_REVIEW_FINDINGS_KEY}"]`);
    expect(
      mutated,
      "could not build the mutant: no `[AI_REVIEW_FINDINGS_KEY]` read in the pair",
    ).not.toBe(code);
    expect(keySpellings(mutated).length).toBe(2);
  });
});

// ── AC-8e: the fields a finding carries are one contract, not two ────────
//
// Wave 2's HIGH finding, which is #295 again with a different key. The reader
// interpolated `finding.title`; the prompt never asks any writer for a
// `title`, so every real refusal read `finding 0 is critical: (untitled)` —
// no file, no line, no summary. Every fixture in this file hand-typed
// `title`, so none of them could witness it: the fixtures satisfied the
// assertion through a path the real contract never takes.

describe("AC-8e: a finding renders through the fields the prompt asks for", () => {
  test("AC-8e: a fixture built from the prompt's own field list renders in full", () => {
    // Built FROM the contract, not typed beside it. A fixture that spells its
    // own keys is a fixture that cannot notice the two drifting apart, which
    // is exactly how the defect survived a green suite.
    const f = AI_REVIEW_FINDING_FIELDS;
    const finding: Record<string, unknown> = {
      [f.severity]: "critical",
      [f.file]: "lib/scaffold/ai-review-findings.ts",
      [f.line]: 235,
      [f.summary]: "the reader interpolates a key no writer produces",
      [f.failureScenario]: "a real payload renders as (untitled)",
    };
    const r = readAiReviewFindings(
      JSON.stringify({ [AI_REVIEW_VERDICT_KEY]: "BLOCK", [AI_REVIEW_FINDINGS_KEY]: [finding] }),
    );
    expect(r.outcome).toBe("BLOCKED");

    const refusal = aiReviewRefusal(r) ?? "";
    expect(refusal, "the annotation names no file").toContain(String(finding[f.file]));
    expect(refusal, "the annotation names no line").toContain(String(finding[f.line]));
    expect(refusal, "the annotation names no defect").toContain(String(finding[f.summary]));
    expect(refusal, "a placeholder leaked into a fully-populated finding").not.toContain(
      "(no summary recorded)",
    );
  });

  test("AC-8e: the wave-2 payload — the one the prompt never asks for — is named as missing", () => {
    // The pair varies ONE thing: which key carries the sentence. A finding
    // whose summary lives under `title` is what the defective reader rendered
    // happily, so the reading must now say the summary is absent rather than
    // quietly printing a severity and nothing else.
    const f = AI_REVIEW_FINDING_FIELDS;
    const payload = (key: string) =>
      JSON.stringify({
        [AI_REVIEW_VERDICT_KEY]: "BLOCK",
        [AI_REVIEW_FINDINGS_KEY]: [{ [f.severity]: "critical", [key]: "creds in a log" }],
      });
    const contract = payload(f.summary);
    const legacy = payload("title");
    expect(legacy, "the pair carries more than one difference").toBe(
      contract.replace(`"${f.summary}"`, '"title"'),
    );

    expect(aiReviewRefusal(readAiReviewFindings(contract))).toContain("creds in a log");
    const legacyRefusal = aiReviewRefusal(readAiReviewFindings(legacy)) ?? "";
    expect(
      legacyRefusal,
      "a finding carrying no contract field still reads as a reported defect",
    ).toContain("(no summary recorded)");
    expect(legacyRefusal).toContain("(no file recorded)");
  });

  test("AC-8e: every field the prompt declares is a field the reader reads", () => {
    // Both directions. The prompt's JSON shape is generated from the map, so
    // a field added to one end and not the other cannot appear here — but a
    // field dropped from the PROMPT while the reader still reads it would be
    // a reader looking for a key nobody is asked to produce, which is the
    // defect itself.
    const prompt = buildReviewPrompt();
    for (const name of Object.values(AI_REVIEW_FINDING_FIELDS)) {
      expect(prompt, `the prompt never asks any writer for '${name}'`).toContain(`"${name}"`);
    }
  });
});

// ── AC-8f: a finding cannot forge a workflow command ─────────────────────

describe("AC-8f: values are percent-encoded before reaching an annotation", () => {
  test("AC-8f: a newline-bearing finding produces exactly one log line", () => {
    // Measured on wave 2 at 22c9da89, not reasoned about: this payload made
    // the reader emit `::stop-commands::deadbeef` as its own line, which
    // disables all subsequent workflow-command processing — so the `::error`
    // the job depends on is never parsed and a BLOCKED review is
    // indistinguishable from a clean one.
    const f = AI_REVIEW_FINDING_FIELDS;
    const hostile = "benign\n::stop-commands::deadbeef\n::notice::all clear";
    const r = readAiReviewFindings(
      JSON.stringify({
        [AI_REVIEW_VERDICT_KEY]: "BLOCK",
        [AI_REVIEW_FINDINGS_KEY]: [{ [f.severity]: "critical", [f.summary]: hostile }],
      }),
    );
    expect(r.outcome, "the hostile payload was not even read as blocking").toBe("BLOCKED");

    const lines = captureStderr(() => main([fixtureFile(JSON.stringify({
      [AI_REVIEW_VERDICT_KEY]: "BLOCK",
      [AI_REVIEW_FINDINGS_KEY]: [{ [f.severity]: "critical", [f.summary]: hostile }],
    }))]));
    expect(lines.length, `the annotation spans ${lines.length} lines:\n${lines.join("\n")}`).toBe(1);

    // GitHub parses a workflow command only at the START of a line, so the
    // property is positional, not textual: the reviewer's words may contain
    // `::stop-commands::` and that is fine — what must never happen is a line
    // BEGINNING with one. Asserting mere absence of the substring would be a
    // detector narrower than what it detects, and would also pass over a
    // reader that silently dropped the finding's text.
    const commandLines = lines.filter(l => /^\s*::/.test(l));
    expect(commandLines.length, `${commandLines.length} workflow commands emitted`).toBe(1);
    expect(commandLines[0].startsWith("::error title=")).toBe(true);
    expect(lines[0], "the content was dropped rather than encoded").toContain("%0A");
    expect(lines[0], "the reviewer's own words were discarded").toContain("deadbeef");
  });

  test("AC-8f: nothing is double-encoded — one escaper, applied once", () => {
    // Two escapers in sequence turn `%` into `%2525`, which renders in the
    // annotation as literal `%25` and is invisible until someone reads a log.
    // So `renderFinding` deliberately does not escape, and this is the case
    // that notices if it starts.
    const f = AI_REVIEW_FINDING_FIELDS;
    const lines = captureStderr(() => main([fixtureFile(JSON.stringify({
      [AI_REVIEW_VERDICT_KEY]: "BLOCK",
      [AI_REVIEW_FINDINGS_KEY]: [{ [f.severity]: "critical", [f.summary]: "100% of runs" }],
    }))]));
    expect(lines.length).toBe(1);
    expect(lines[0], "the percent sign was encoded twice").not.toContain("%2525");
    expect(lines[0]).toContain("100%25 of runs");
  });

  test("AC-8f: the escaper is reachable and encodes all three characters", () => {
    // A unit over the binding, because the two cases above would also pass
    // over an implementation that stripped the characters instead of
    // encoding them — and stripping loses the reviewer's own words.
    expect(escapeAnnotation("a%b\rc\nd")).toBe("a%25b%0Dc%0Ad");
  });

  test("AC-8f: the detail of one finding is capped", () => {
    const f = AI_REVIEW_FINDING_FIELDS;
    const line = renderFinding(0, {
      [f.severity]: "critical",
      [f.file]: "x.ts",
      [f.line]: 1,
      [f.summary]: "y".repeat(5_000),
    });
    expect(line.length, "a megabyte of agent prose reached the annotation").toBeLessThanOrEqual(
      AI_REVIEW_DETAIL_MAX + 1,
    );
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

// ── #1178: a CONTRADICTION must emit the findings it counted ─────────────
//
// The reported shape is `BLOCK over 0 of 1 blocking finding(s)` — seen on
// run 39770912983 (PR #1150) and run 39795440261 (PR #1165), and measured at
// roughly 6 of the last 20 `ai-review` runs. The verdict word says BLOCK, the
// severities say nothing blocks, so the reading is CONTRADICTION and the job
// refuses. That part is correct and this section does not touch it.
//
// What was wrong is that the refusal printed the ARITHMETIC ALONE. `detail`
// is populated inside `if (blocks)` in the reader's loop, so a contradiction
// whose findings are all non-blocking carries an EMPTY detail list, and the
// annotation reads `0 of 1 finding(s) block.` and stops. Measured on
// `b7281397` before the fix, the whole refusal for that payload was:
//
//   The AI review's verdict "BLOCK" contradicts its own payload: 0 of 1
//   finding(s) block. A verdict that disagrees with the findings beneath it
//   is a contradiction, not a result.
//
// So every occurrence destroyed the one observation the reviewer made, and
// a re-run — which returns CLEAN, that being the non-determinism this issue
// also records — destroyed it permanently. #1170's finding is unrecoverable:
// the payload lives under `$RUNNER_TEMP`, which dies with the runner, and
// three retrieval attempts returned nothing.
//
// The annotation is therefore the only durable surface, and it already is
// one: the generated step captures the reader with `2>&1` and `printf`s the
// capture, so an `::error` the reader writes becomes an annotation on the
// check run and survives the job. Emitting the payload into the refusal is
// the whole fix, which is why it is a branch and not a new capability — the
// findings are already parsed into `reading.reported` by the time the
// contradiction is detected.
//
// NOT FIXED HERE, deliberately: the non-determinism itself. Without the
// payload you cannot tell a reviewer that emitted a DIFFERENT finding on the
// second run from one that emitted the SAME finding and mis-stamped the
// verdict, and those are different bugs. This section is the instrument.
//
// And NOT by resolving a contradiction to CLEAN. A verdict the adjudicator
// cannot explain is UNMEASURED and UNMEASURED fails
// (`.claude/rules/config-access.md`). Blocking is correct; being
// unexplainable is the defect. The control below holds that line.

describe("#1178: a CONTRADICTION emits the findings it counted", () => {
  const f = AI_REVIEW_FINDING_FIELDS;

  /** The reported shape, reproduced: BLOCK over a payload where nothing blocks. */
  const zeroOfOne = JSON.stringify({
    [AI_REVIEW_VERDICT_KEY]: "BLOCK",
    [AI_REVIEW_FINDINGS_KEY]: [
      {
        [f.severity]: "low",
        [f.file]: "lib/scaffold/ai-review-findings.ts",
        [f.line]: 42,
        [f.summary]: "the detail list is built inside the blocking branch",
      },
    ],
  });

  test("#1178 witness: `BLOCK over 0 of N` names the finding it counted", () => {
    const r = readAiReviewFindings(zeroOfOne);
    expect(r.outcome, "the reported shape no longer reproduces").toBe("CONTRADICTION");
    expect(r.blockingReported?.length).toBe(0);
    expect(r.reported?.length).toBe(1);

    const refusal = aiReviewRefusal(r);
    expect(refusal).not.toBeNull();
    // All four fields the acceptance criterion names. Asserted separately
    // rather than against one composed string, so a renderer that drops the
    // line number is distinguishable from one that drops everything.
    expect(refusal, "the file was discarded").toContain("lib/scaffold/ai-review-findings.ts");
    expect(refusal, "the line was discarded").toContain("42");
    expect(refusal, "the severity was discarded").toContain("low");
    expect(refusal, "the summary was discarded").toContain(
      "the detail list is built inside the blocking branch",
    );
    // …and the arithmetic it already carried is still there. The payload is
    // added to the refusal, not substituted for it.
    expect(refusal).toContain("0 of 1 finding(s) block");
  });

  test("#1178 witness: every reported finding appears exactly once, blocking or not", () => {
    // The other direction — PASS over a payload that does block — already
    // carried the BLOCKING finding through `detail`. So this case fails
    // today on the non-blocking one only, and its second half is the guard
    // against the obvious over-correction: appending the full payload to a
    // detail list that already holds the blocking renders prints those twice.
    const r = readAiReviewFindings(
      JSON.stringify({
        [AI_REVIEW_VERDICT_KEY]: "PASS",
        [AI_REVIEW_FINDINGS_KEY]: [
          { [f.severity]: "critical", [f.file]: "a.ts", [f.line]: 1, [f.summary]: "creds in a log" },
          { [f.severity]: "low", [f.file]: "b.ts", [f.line]: 2, [f.summary]: "a naming nit" },
        ],
      }),
    );
    expect(r.outcome).toBe("CONTRADICTION");

    const refusal = aiReviewRefusal(r) ?? "";
    const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1;
    expect(occurrences(refusal, "a.ts:1"), "the blocking finding was duplicated or lost").toBe(1);
    expect(occurrences(refusal, "b.ts:2"), "the non-blocking finding was discarded").toBe(1);
    expect(refusal).toContain("creds in a log");
    expect(refusal).toContain("a naming nit");
  });

  test("#1178 control: an ordinary BLOCKED refusal is byte-identical to today's", () => {
    // The issue's negative control, written as an EQUALITY and not a
    // `toContain`. The cheapest wrong fix here is moving
    // `detail.push(renderFinding(…))` out of `if (blocks)` in the reader's
    // loop — one line, and it does make the contradiction print its payload.
    // It also makes an ordinary BLOCKED refusal start enumerating findings
    // that do not block, which is a different annotation for a path this
    // issue is not about. Measured: applying that one-line move turns this
    // case red and leaves the two witnesses above green, which is why the
    // fix is scoped to the CONTRADICTION arm instead.
    const r = readAiReviewFindings(
      JSON.stringify({
        [AI_REVIEW_VERDICT_KEY]: "BLOCK",
        [AI_REVIEW_FINDINGS_KEY]: [
          { [f.severity]: "critical", [f.file]: "a.ts", [f.line]: 1, [f.summary]: "creds in a log" },
          { [f.severity]: "low", [f.file]: "b.ts", [f.line]: 2, [f.summary]: "a naming nit" },
        ],
      }),
    );
    expect(r.outcome).toBe("BLOCKED");
    expect(aiReviewRefusal(r)).toBe(
      "The AI review reported 1 blocking finding(s). " +
        "finding 0 is critical at a.ts:1: creds in a log.",
    );
  });

  test("#1178 control: an ordinary CLEAN run still adjudicates exactly as today", () => {
    const r = readAiReviewFindings(
      JSON.stringify({
        [AI_REVIEW_VERDICT_KEY]: "PASS",
        [AI_REVIEW_FINDINGS_KEY]: [
          { [f.severity]: "low", [f.file]: "b.ts", [f.line]: 2, [f.summary]: "a naming nit" },
        ],
      }),
    );
    expect(r.outcome).toBe("CLEAN");
    expect(aiReviewRefusal(r), "a clean review acquired a refusal").toBeNull();
    expect(aiReviewExitCode(r)).toBe(0);
  });

  test("#1178 control: the contradiction still refuses — it does not resolve to CLEAN", () => {
    // The forbidden fix, as a case. Emitting the payload is an addition to
    // what the refusal says, never a change to whether there is one: a
    // verdict the adjudicator cannot explain is UNMEASURED, and UNMEASURED
    // fails. This case can move — it is exactly what "make the contradiction
    // go green" would turn red.
    const r = readAiReviewFindings(zeroOfOne);
    expect(r.outcome).not.toBe("CLEAN");
    expect(aiReviewExitCode(r)).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(aiReviewRefusal(r)).not.toBeNull();
  });

  test("#1178: the per-finding cap truncates the summary and never the location", () => {
    // AI_REVIEW_DETAIL_MAX is 300 characters per finding, so a long summary
    // IS cut. What the cap must never cost is the ability to find the
    // finding again, and the renderer puts severity, file and line ahead of
    // the summary — so the cut lands in the prose. Measured rather than
    // assumed: a 900-character summary renders to exactly 301 characters
    // (the cap plus the ellipsis) with the location intact.
    const summary = "x".repeat(900);
    const finding = {
      [f.severity]: "low",
      [f.file]: "lib/deep/path.ts",
      [f.line]: 7,
      [f.summary]: summary,
    };
    const rendered = renderFinding(0, finding);
    expect(rendered.length, "the cap is not being applied").toBe(AI_REVIEW_DETAIL_MAX + 1);
    expect(rendered.startsWith("finding 0 is low at lib/deep/path.ts:7: ")).toBe(true);
    expect(rendered).not.toContain(summary);

    const r = readAiReviewFindings(
      JSON.stringify({
        [AI_REVIEW_VERDICT_KEY]: "BLOCK",
        [AI_REVIEW_FINDINGS_KEY]: [finding],
      }),
    );
    expect(r.outcome).toBe("CONTRADICTION");
    // The refusal carries the capped render, not a second uncapped one.
    expect(aiReviewRefusal(r), "the contradiction emitted an uncapped finding").toContain(rendered);
  });

  test("#1178 witness: the finding reaches the annotation main() emits, escaped once", () => {
    // The payload file dies with the runner, so the annotation is the thing
    // that has to carry the finding. This asserts on what reaches the
    // STREAM — the composed refusal would skip the `console.error`
    // interpolation, which is the one hop where the encoding happens.
    const hostile = "100% broken\n::stop-commands::deadbeef";
    const lines = captureStderr(() => main([fixtureFile(JSON.stringify({
      [AI_REVIEW_VERDICT_KEY]: "BLOCK",
      [AI_REVIEW_FINDINGS_KEY]: [
        { [f.severity]: "low", [f.file]: "lib/x.ts", [f.line]: 9, [f.summary]: hostile },
      ],
    }))]));

    expect(lines.length, `the annotation spans ${lines.length} lines:\n${lines.join("\n")}`).toBe(1);
    expect(lines[0].startsWith("::error title=")).toBe(true);
    expect(lines[0], "the contradiction's finding never reached the annotation").toContain(
      "lib/x.ts:9",
    );
    expect(lines[0], "the reviewer's own words were discarded").toContain("deadbeef");
    // One escaper, applied once, at the single emission site.
    expect(lines[0], "the newline was dropped rather than encoded").toContain("%0A");
    expect(lines[0], "the percent sign was encoded twice").not.toContain("%2525");
    expect(lines[0]).toContain("100%25 broken");
  });
});
