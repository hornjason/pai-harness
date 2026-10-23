/**
 * ai-review-advisory-findings.test.ts — a finding is never silently dropped.
 *
 * ## What this is about
 *
 * `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` states CRC-B8: every finding is
 * answered — fixed, or resolved with a stated reason — and never silently
 * dropped. The spec declares CRC-B8 inverted on this repository and calls it
 * "the defect, not a deviation".
 *
 * This file binds ONE half of its second sentence, and deliberately does not
 * claim the criterion: the merge-blocking half ("a pull request does not
 * merge with an unanswered finding") is not shipped here, and a tick is a
 * claim about the whole thing. The id above is a citation in running prose
 * and not a declaring position, which `.claude/rules/claiming-sc-coverage.md`
 * says is exactly the difference.
 *
 * ## The drop, measured on `origin/main` at `a20f6812`
 *
 * `AI_REVIEW_SEVERITIES` declares `medium`, `low` and `info` advisory.
 * `readAiReviewFindings` counts them, and then:
 *
 * - `detail` is appended to inside `if (blocks)`, so it holds only the
 *   blocking subset;
 * - `aiReviewRefusal` returns `null` for CLEAN and interpolates `detail` for
 *   BLOCKED;
 * - `main` prints the outcome line, and the refusal when there is one.
 *
 * So a CLEAN payload carrying three `medium` findings and a CLEAN payload
 * carrying none produced **byte-identical output**. AD-1 is that pair, and it
 * is red on `origin/main`. The payload is not a fallback copy: it lives under
 * `$RUNNER_TEMP`, nothing uploads it (#1319 measured zero artifacts on a real
 * run) and it dies with the runner.
 *
 * ## The cheapest wrong fix, named
 *
 * Printing the advisory COUNT and not the findings. It is one line, it makes
 * AD-1 green — the two outputs now differ — and it leaves the findings
 * exactly as unrecoverable as they were. AD-2 is the case that stays red
 * under it: it asserts the file, the line and the summary of each advisory
 * finding reach the annotation, which a count cannot supply.
 *
 * ## The mutation battery
 *
 * `lib/scaffold/ai-review-findings.ts` imports one relative module,
 * `./ai-review-step`, which itself has none — so the battery copies BOTH into
 * the scratch directory and the mutant loads. A mutant that failed to load
 * would report zero findings and read identically to a guard behaving
 * differently (`.claude/rules/self-referential-tests.md`, Tier 1, last row),
 * so AD-9 asserts every mutant actually applied before any row is counted.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  AI_REVIEW_ADVISORY_TITLE,
  AI_REVIEW_FINDINGS_TITLE,
  AI_REVIEW_OUTCOME_LINE,
  AI_REVIEW_SEVERITIES,
  advisoryNotice,
  advisoryReported,
  aiReviewExitCode,
  advisoryKey,
  main,
  readAiReviewFindings,
} from "../lib/scaffold/ai-review-findings";

const MODULE = join(import.meta.dir, "..", "lib", "scaffold", "ai-review-findings.ts");
const DEPENDENCY = join(import.meta.dir, "..", "lib", "scaffold", "ai-review-step.ts");

let SCRATCH: string;

beforeAll(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "ai-review-advisory-"));
});

afterAll(() => {
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
});

const BLOCKING = Object.keys(AI_REVIEW_SEVERITIES).filter(s => AI_REVIEW_SEVERITIES[s]);
const ADVISORY = Object.keys(AI_REVIEW_SEVERITIES).filter(s => !AI_REVIEW_SEVERITIES[s]);

/**
 * A finding carrying every field the contract declares.
 *
 * Built from the severity table rather than from hand-typed words, so a
 * severity re-classified in `AI_REVIEW_SEVERITIES` moves these fixtures with
 * it instead of leaving them asserting about a word the contract dropped.
 */
function finding(severity: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    severity,
    file: "lib/example.ts",
    line: 42,
    summary: "the reading is not checked",
    failure_scenario: "a caller acts on a value nobody read",
    ...over,
  };
}

function payload(findings: Record<string, unknown>[], verdict: string): string {
  return JSON.stringify({ findings, verdict });
}

let fixtureSeq = 0;

function fixtureFile(body: string): string {
  const path = join(SCRATCH, `findings-${fixtureSeq++}.json`);
  writeFileSync(path, body);
  return path;
}

/**
 * Everything `main` writes, on BOTH streams, as GitHub's parser sees it.
 *
 * Both streams, because the generated step captures the reader with `2>&1`
 * and `printf`s the capture — so what reaches GitHub is the union, and a case
 * watching one stream could be satisfied by output the runner never groups
 * with the other. Lines, not a blob: a value that forged a second workflow
 * command would be invisible to a substring assertion and is a line here.
 */
function captureBoth(fn: () => unknown): { lines: string[]; result: unknown } {
  const written: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => void written.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void written.push(a.map(String).join(" "));
  let result: unknown;
  try {
    result = fn();
  } finally {
    console.log = log;
    console.error = err;
  }
  return { lines: written.join("\n").split("\n").filter(l => l.length > 0), result };
}

// ── AD-1: a dropped finding and no finding are different outputs ─────────
//
// THE PAIR, and the headline. One input varies: three advisory findings
// present or absent. Everything else — the verdict word, the outcome, the
// exit code — is held equal, which is the point: the two runs are the same
// verdict over different evidence, and before this change they were the same
// bytes as well.

describe("AD-1: a CLEAN reading carrying advisory findings says so", () => {
  test("AD-1: the control — a payload with no findings at all", () => {
    const { lines, result } = captureBoth(() => main([fixtureFile(payload([], "PASS"))]));
    expect(result).toBe(0);
    expect(lines).toEqual([`${AI_REVIEW_OUTCOME_LINE} CLEAN`]);
  });

  test("AD-1: three advisory findings produce output the empty payload does not", () => {
    const three = ADVISORY.slice(0, 3).map((s, i) =>
      finding(s, { file: `lib/m${i}.ts`, line: 10 + i, summary: `s${i} unchecked` }),
    );
    expect(three.length).toBeGreaterThan(0);

    const empty = captureBoth(() => main([fixtureFile(payload([], "PASS"))]));
    const tail = captureBoth(() => main([fixtureFile(payload(three, "PASS"))]));

    // Equal where they must be: same verdict, same exit code. A difference
    // here would mean the advisory tail had started deciding something.
    expect(tail.result).toBe(empty.result);
    expect(tail.lines[0]).toBe(empty.lines[0]);

    // And different where the drop was. On origin/main these two arrays are
    // identical, which is the red this case was written for.
    expect(tail.lines).not.toEqual(empty.lines);
    expect(tail.lines.some(l => l.includes(AI_REVIEW_ADVISORY_TITLE))).toBe(true);
  });
});

// ── AD-2: the finding itself, not a count of findings ────────────────────
//
// The case that survives the cheapest wrong fix. Predict the membership and
// not only the total: every advisory finding's file, line and summary, by
// value, and the blocking one's summary ABSENT from this annotation because
// it is already in the refusal.

describe("AD-2: every advisory finding reaches the annotation by value", () => {
  test("AD-2: file, line and summary of each advisory finding are named", () => {
    const findings = [
      finding(ADVISORY[0], { file: "lib/a.ts", line: 11, summary: "alpha is unchecked" }),
      finding(ADVISORY[1] ?? ADVISORY[0], { file: "lib/b.ts", line: 22, summary: "beta is unchecked" }),
    ];
    const { lines } = captureBoth(() => main([fixtureFile(payload(findings, "PASS"))]));
    const notice = lines.find(l => l.includes(AI_REVIEW_ADVISORY_TITLE));
    expect(notice).toBeDefined();

    for (const f of findings) {
      expect(notice).toContain(String(f.file));
      expect(notice).toContain(String(f.line));
      expect(notice).toContain(String(f.summary));
    }
  });

  test("AD-2: the stated count and the listed findings agree, count first", () => {
    // The annotation has no length budget and GitHub truncates a long one.
    // Nothing here can stop that, and capping the list would GUARANTEE the
    // loss this file exists to stop rather than risking it. What makes a
    // truncation detectable instead of silent is that the total is stated
    // BEFORE the list: a reader seeing "11 advisory finding(s)" above eight
    // of them knows the set is incomplete, which is the difference between
    // UNMEASURED and clean. So the two have to agree, and the total has to
    // come first — both asserted, because either alone is satisfiable by a
    // notice nobody could read that way.
    const many = Array.from({ length: 11 }, (_, i) =>
      finding(ADVISORY[i % ADVISORY.length], { file: `lib/f${i}.ts`, summary: `finding ${i} text` }),
    );
    const notice = advisoryNotice(readAiReviewFindings(payload(many, "PASS")))!;
    expect(notice.startsWith("11 advisory finding(s)")).toBe(true);
    expect((notice.match(/\[key [0-9a-f]{8}\]/g) || []).length).toBe(11);
  });

  test("AD-2: the tail is indexed against the WHOLE payload, not renumbered", () => {
    // The blocking finding is index 0, so the advisory one is `finding 1`
    // here and `finding 1` in any refusal. A tail rendered on its own would
    // call it `finding 0` and two annotations would disagree about which
    // finding they mean.
    const findings = [
      finding(BLOCKING[0], { summary: "blocking one" }),
      finding(ADVISORY[0], { file: "lib/tail.ts", line: 7, summary: "advisory one" }),
    ];
    const notice = advisoryNotice(readAiReviewFindings(payload(findings, "BLOCK")));
    expect(notice).toContain("finding 1 is");
    expect(notice).not.toContain("finding 0 is");
  });
});

// ── AD-3: a BLOCKED reading drops its advisory tail too ──────────────────
//
// `detail` is built inside `if (blocks)`, so the tail vanished from BLOCKED
// runs exactly as it did from CLEAN ones. Asserted separately because the two
// go through different arms of `aiReviewRefusal` and a repair aimed at CLEAN
// alone would leave this one red.

describe("AD-3: the advisory tail of a BLOCKED reading is named as well", () => {
  test("AD-3: a blocking finding does not suppress the advisory ones", () => {
    const findings = [
      finding(BLOCKING[0], { file: "lib/blocks.ts", summary: "this blocks" }),
      finding(ADVISORY[0], { file: "lib/tail.ts", summary: "this does not block" }),
    ];
    const { lines, result } = captureBoth(() => main([fixtureFile(payload(findings, "BLOCK"))]));

    expect(result).not.toBe(0);
    const refusal = lines.find(l => l.includes(`title=${AI_REVIEW_FINDINGS_TITLE}`));
    const notice = lines.find(l => l.includes(`title=${AI_REVIEW_ADVISORY_TITLE}`));
    expect(refusal).toContain("this blocks");
    expect(notice).toContain("this does not block");

    // And the blocking one is named ONCE, in the refusal. A duplicate reads
    // as two findings — the module says so about the contradiction arm, and
    // it is as true here.
    expect(notice).not.toContain("this blocks");
  });
});

// ── AD-4: CONTRADICTION already prints them; this must not print again ───

describe("AD-4: the contradiction arm is not doubled", () => {
  test("AD-4: a CONTRADICTION emits no advisory notice", () => {
    // PASS over a blocking finding: the contradiction the module's #1178
    // comment is about, whose refusal lists every counted finding already.
    const findings = [
      finding(BLOCKING[0], { summary: "blocks but claimed clean" }),
      finding(ADVISORY[0], { summary: "advisory alongside it" }),
    ];
    const { lines } = captureBoth(() => main([fixtureFile(payload(findings, "PASS"))]));

    const refusal = lines.find(l => l.includes(`title=${AI_REVIEW_FINDINGS_TITLE}`));
    expect(refusal).toContain("advisory alongside it");
    expect(lines.some(l => l.includes(AI_REVIEW_ADVISORY_TITLE))).toBe(false);

    // The count that makes the above non-vacuous: the advisory finding is
    // named exactly once across every line, not zero times and not twice.
    const occurrences = lines.filter(l => l.includes("advisory alongside it")).length;
    expect(occurrences).toBe(1);
  });
});

// ── AD-5: UNMEASURED withholds the set rather than reporting an empty one ─

describe("AD-5: an UNMEASURED reading has no advisory set, not an empty one", () => {
  test("AD-5: advisoryReported is null under UNMEASURED", () => {
    const reading = readAiReviewFindings(JSON.stringify({ findings: [{}], verdict: "PASS" }));
    expect(reading.outcome).toBe("UNMEASURED");
    // `null` and `[]` are different facts: one is a tail nobody classified,
    // the other is a reading that classified every finding as blocking.
    expect(advisoryReported(reading)).toBeNull();
    expect(advisoryNotice(reading)).toBeNull();
  });

  test("AD-5: a CLEAN reading with no findings reports an empty set, not null", () => {
    // The control for the case above. Without it, a function that returned
    // `null` unconditionally would satisfy it.
    const reading = readAiReviewFindings(payload([], "PASS"));
    expect(advisoryReported(reading)).toEqual([]);
  });
});

// ── AD-6: the emission decides nothing ───────────────────────────────────
//
// The fourth shape, pre-empted. A notice that quietly became a refusal would
// be a severity table nobody declared, and the exit code is the one signal
// that matters. Varied over every outcome the reader can reach.

describe("AD-6: the exit code is a function of the blocking set alone", () => {
  const cases: [string, string, number | "nonzero"][] = [
    ["no findings", payload([], "PASS"), 0],
    ["advisory only", payload([finding(ADVISORY[0])], "PASS"), 0],
    ["many advisory", payload(ADVISORY.map(s => finding(s)), "PASS"), 0],
    ["one blocking", payload([finding(BLOCKING[0])], "BLOCK"), "nonzero"],
    ["blocking plus advisory", payload([finding(BLOCKING[0]), finding(ADVISORY[0])], "BLOCK"), "nonzero"],
  ];

  for (const [label, body, expected] of cases) {
    test(`AD-6: ${label} exits as the severities say`, () => {
      const reading = readAiReviewFindings(body);
      const code = aiReviewExitCode(reading);
      if (expected === "nonzero") expect(code).not.toBe(0);
      else expect(code).toBe(expected);
    });
  }

  test("AD-6: the advisory notice is reached from main and from nowhere else", () => {
    // Behavioural equality above cannot tell "does not decide" from "happens
    // to agree today". This is the structural half: one call site, and it is
    // below the point where the reading is finished.
    const src = readFileSync(MODULE, "utf-8");
    const calls = (src.match(/\badvisoryNotice\s*\(/g) || []).length;
    // One declaration, one call. A third occurrence means a second caller,
    // which is where a decision would get made.
    expect(calls).toBe(2);
    expect(/function aiReviewExitCode[\s\S]*?\n}/.exec(src)?.[0]).not.toContain("advisory");
  });
});

// ── AD-7: an answer can name the finding it answers ──────────────────────

describe("AD-7: the finding key is stable where the finding is", () => {
  test("AD-7: the key survives a line move and a re-rating", () => {
    // #1319 measured `bash-write-guard.ts:90 → :97` across two rounds of
    // #1213 — one finding, two lines. A key over the line would make that
    // two findings and an answer to either would answer neither.
    const a = finding(ADVISORY[0], { line: 90 });
    const b = finding(ADVISORY[0], { line: 97 });
    const rerated = finding(BLOCKING[0], { line: 90 });
    expect(advisoryKey(a)).toBe(advisoryKey(b));
    expect(advisoryKey(a)).toBe(advisoryKey(rerated));
  });

  test("AD-7: a different file or a different summary is a different key", () => {
    const base = finding(ADVISORY[0]);
    expect(advisoryKey(finding(ADVISORY[0], { file: "lib/other.ts" }))).not.toBe(advisoryKey(base));
    expect(advisoryKey(finding(ADVISORY[0], { summary: "something else" }))).not.toBe(
      advisoryKey(base),
    );
  });

  test("AD-7: the key is in the annotation, so an answer has something to cite", () => {
    const f = finding(ADVISORY[0], { file: "lib/keyed.ts", summary: "keyed finding" });
    const notice = advisoryNotice(readAiReviewFindings(payload([f], "PASS")));
    expect(notice).toContain(advisoryKey(f));
  });
});

// ── AD-8: a finding cannot forge a workflow command from this channel ────

describe("AD-8: the advisory notice is escaped at the single emission site", () => {
  test("AD-8: a newline-bearing advisory finding produces exactly one line", () => {
    // The same hazard AC-8f in test/ai-review-findings.test.ts measured on
    // the refusal channel, on a channel that did not exist until now. The
    // payload is written by an agent that has just read untrusted branch
    // content, so this is not a style point.
    const hostile = finding(ADVISORY[0], {
      summary: "benign\n::stop-commands::deadbeef\n::notice::all clear",
    });
    const { lines } = captureBoth(() => main([fixtureFile(payload([hostile], "PASS"))]));
    expect(lines.filter(l => l.startsWith("::stop-commands::"))).toEqual([]);
    expect(lines.filter(l => l.includes(AI_REVIEW_ADVISORY_TITLE)).length).toBe(1);
    // The outcome line and the notice, and nothing the finding wrote.
    expect(lines.length).toBe(2);
  });

  test("AD-8: nothing is double-encoded on this channel either", () => {
    const f = finding(ADVISORY[0], { summary: "100% unchecked" });
    const { lines } = captureBoth(() => main([fixtureFile(payload([f], "PASS"))]));
    const notice = lines.find(l => l.includes(AI_REVIEW_ADVISORY_TITLE))!;
    expect(notice).toContain("100%25 unchecked");
    expect(notice).not.toContain("%2525");
  });
});

// ── AD-9: the mutants applied ────────────────────────────────────────────
//
// The seventh shape. A mutant that failed to load reports zero findings and
// reads identically to a guard behaving differently, so the battery asserts
// the edit landed in the copy before any row above is believed. The copy
// carries `ai-review-step.ts` too, because the module imports it and a
// relative specifier resolves to nothing in a scratch directory.

interface Mutant {
  id: string;
  apply: (src: string) => string;
}

const MUTANTS: Mutant[] = [
  { id: "M1 notice always null", apply: s => s.replace(
      "export function advisoryNotice(reading: AiReviewFindingsReading): string | null {",
      "export function advisoryNotice(reading: AiReviewFindingsReading): string | null {\n  if (reading) return null;",
    ) },
  { id: "M2 tail is the whole payload", apply: s => s.replace(
      "  const blocking = new Set(reading.blockingReported);\n  return reading.reported.filter(item => !blocking.has(item));",
      "  return reading.reported.slice();",
    ) },
  { id: "M3 escaper dropped", apply: s => s.replace(
      "console.log(`::notice title=${AI_REVIEW_ADVISORY_TITLE}::${escapeAnnotation(advisory)}`);",
      "console.log(`::notice title=${AI_REVIEW_ADVISORY_TITLE}::${advisory}`);",
    ) },
  { id: "M4 UNMEASURED tail collapses to empty", apply: s => s.replace(
      "  if (reading.reported === null || reading.blockingReported === null) return null;",
      "  if (reading.reported === null) return null;\n  if (reading.blockingReported === null) return [];",
    ) },
  { id: "M5 key is a constant", apply: s => s.replace(
      "  return hash.toString(16).padStart(8, \"0\");",
      "  return \"00000000\";",
    ) },
];

describe("AD-9: every mutant in the battery applied to the copy", () => {
  test("AD-9: each mutation changes the source and the mutant loads", async () => {
    const src = readFileSync(MODULE, "utf-8");
    const unapplied: string[] = [];
    const unloadable: string[] = [];

    for (const m of MUTANTS) {
      const mutated = m.apply(src);
      if (mutated === src) {
        unapplied.push(m.id);
        continue;
      }
      const dir = join(SCRATCH, `mutant-${m.id.split(" ")[0]}`);
      mkdirSync(dir, { recursive: true });
      copyFileSync(DEPENDENCY, join(dir, "ai-review-step.ts"));
      writeFileSync(join(dir, "ai-review-findings.ts"), mutated);
      try {
        const mod = await import(join(dir, "ai-review-findings.ts"));
        if (typeof mod.advisoryNotice !== "function") unloadable.push(m.id);
      } catch {
        unloadable.push(m.id);
      }
    }

    expect(
      unapplied,
      "a mutation whose replace() matched nothing is a row that cannot come back red. " +
        "Re-spell it against the current source rather than deleting it.",
    ).toEqual([]);
    expect(
      unloadable,
      "a mutant that did not load reports zero findings, which reads exactly like a " +
        "guard behaving differently. Carry every relative import into the scratch copy.",
    ).toEqual([]);
  });
});
