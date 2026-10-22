/**
 * scaffold/ai-review-findings.ts — the AI review's findings contract, and the
 * blocking verdict derived from it (#631).
 *
 * ## Why the agent's verdict word is not the decider
 *
 * The reviewer is an agent, and an agent grading its own gate is the shape
 * this repo distrusts most. So the contract is: the agent writes a payload of
 * findings, each carrying a severity, and the blocking decision is computed
 * HERE from those severities. The verdict word is read for exactly one
 * purpose — to notice that the agent contradicted its own payload — and never
 * to decide anything. `prevalidationViolations` in `gates/workflow.test.ts` is
 * the shape being copied: a PASS carrying broken ids is a contradiction, not a
 * pass. Without that branch a writer could record the blocking list faithfully
 * and still be waved through, which is the fail-open that survives every test
 * written only against the happy path.
 *
 * ## Why the key is a constant and not a string
 *
 * #295, in that same function: the reader asked for `reading.broken`, a key no
 * writer ever produced and the schema never declared. The list was empty on
 * every run, so every FAIL fell through to "no broken ids were recorded" — an
 * absent key reads as an empty list reads as clean. One exported constant is
 * the whole fix: the step that reads the payload and the prompt that tells the
 * agent what to write name the same binding, so they cannot drift, and
 * `test/ai-review-findings.test.ts` fails the suite if a second spelling of it
 * appears anywhere in this module.
 *
 * ## Why the payload contract is read back (#1166)
 *
 * The prompt states a contract — "every one of those member names is required
 * on every finding" — and until #1166 nothing checked it. This module
 * validated a severity and a verdict word; `AI_REVIEW_FINDING_FIELDS` was
 * consumed only by `renderFinding`, which printed `(no file recorded)` and
 * carried on. So a BLOCKING finding with a fabricated `failure_scenario`, no
 * `file` and no `line` adjudicated identically to one with real evidence
 * under it, and the module's own philosophy — do not take the agent's word
 * for it — reached one level short of the thing the agent is asked to write.
 *
 * It is read back on blocking findings and nowhere else. See
 * `blockingContractViolations` for why that line and not a stricter one.
 *
 * ## Why so many ways to be UNMEASURED
 *
 * `0`, `{}`, `null` and `SKIP` are indistinguishable from success; UNMEASURED
 * is not (`.claude/rules/config-access.md`). A payload this module cannot read
 * is a review whose result nobody knows, and the states it can be in — no
 * file, unreadable file, not JSON, no declared key, a finding with no severity
 * — are different facts with different fixes, so each is named. None of them
 * reads as clean, and the derived decision is WITHHELD rather than defaulted:
 * `blocked` is `null` under an UNMEASURED reading.
 *
 * ## The exit code
 *
 * Every refusal routes through `AI_REVIEW_REQUIRED_EXIT`, imported from
 * `./ai-review-step` and never re-declared here. One site to mutate, so
 * `test/ai-review-exit-binding.test.ts` can zero it and prove each refusal is
 * what the case observed. A later branch inlining its own literal would
 * survive that mutation and the case would go green having witnessed nothing.
 */

import { readFileSync } from "fs";

/**
 * The contract itself is declared in `./ai-review-step`, beside the prompt
 * that asks a writer to honour it, and imported here rather than restated.
 *
 * That direction is forced and it is the right one anyway: `ai-review-step.ts`
 * has no relative imports, because `test/ai-review-scaffold.test.ts` builds a
 * mutant copy of it that runs from a temp directory. So the module holding the
 * contract cannot depend on the module reading it, and every name below has
 * exactly one declaration — which is the whole of #295's lesson. A reader and
 * a writer that merely agree today are two contracts, and nothing fails to
 * compile when they stop agreeing.
 *
 * Re-exported because the reader's own callers and tests name them, and a
 * second `export const` here would be the duplicate this paragraph is about.
 */
import {
  AI_REVIEW_BLOCK_VERDICT,
  AI_REVIEW_FINDING_FIELDS,
  AI_REVIEW_FINDINGS_KEY,
  AI_REVIEW_OUTCOME_LINE,
  AI_REVIEW_PASS_VERDICT,
  AI_REVIEW_REQUIRED_EXIT,
  AI_REVIEW_SEVERITIES,
  AI_REVIEW_SEVERITY_KEY,
  AI_REVIEW_VERDICT_KEY,
} from "./ai-review-step";

export {
  AI_REVIEW_BLOCK_VERDICT,
  AI_REVIEW_FINDING_FIELDS,
  AI_REVIEW_FINDINGS_KEY,
  AI_REVIEW_OUTCOME_LINE,
  AI_REVIEW_PASS_VERDICT,
  AI_REVIEW_SEVERITIES,
  AI_REVIEW_SEVERITY_KEY,
  AI_REVIEW_VERDICT_KEY,
};

/**
 * Percent-encode a value before it is interpolated into a workflow command.
 *
 * ONE escaper, because there is one rule and a second copy is a second rule
 * nobody updates. GitHub parses `::command::` lines one per line, so a newline
 * inside an interpolated value starts a NEW command — and the payload this
 * reads is written by an agent that has just read untrusted branch content.
 *
 * Measured on wave 2 at `22c9da89`, not reasoned about: a finding titled
 * `benign\n::stop-commands::deadbeef\n::notice::all clear` made the reader emit
 * `::stop-commands::deadbeef` as its own line. That token disables all
 * subsequent workflow-command processing, so a BLOCKED review becomes
 * indistinguishable from a clean one — the exact failure this module exists to
 * prevent, reachable by writing a string.
 */
export function escapeAnnotation(value: unknown): string {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

/** Annotation detail is capped: a megabyte of agent prose is not a message. */
export const AI_REVIEW_DETAIL_MAX = 300;

/**
 * One finding, rendered for an annotation — capped, naming file and summary.
 *
 * Deliberately does NOT escape. Escaping happens once, at the single emission
 * site in `main()`, because two escapers applied in sequence turn `%` into
 * `%2525` and the bug that produces is invisible until someone reads a log.
 * One rule, one binding, applied last.
 */
export function renderFinding(index: number, finding: Record<string, unknown>): string {
  const f = AI_REVIEW_FINDING_FIELDS;
  const where = finding[f.file] !== undefined
    ? `${String(finding[f.file])}:${String(finding[f.line] ?? "?")}`
    : "(no file recorded)";
  const what = finding[f.summary] !== undefined
    ? String(finding[f.summary])
    : "(no summary recorded)";
  const line = `finding ${index} is ${String(finding[f.severity])} at ${where}: ${what}`;
  return line.length > AI_REVIEW_DETAIL_MAX ? `${line.slice(0, AI_REVIEW_DETAIL_MAX)}…` : line;
}

/**
 * EVERY finding a reading counted, rendered — not only the blocking ones.
 *
 * `detail` is not this list and must not become it. It is populated inside
 * `if (blocks)` in the loop below, which is correct for a BLOCKED refusal:
 * that annotation names what is stopping the pull request, and enumerating
 * the advisory tail beside it buries the thing a maintainer has to act on.
 *
 * But it is wrong for a CONTRADICTION (#1178). The shape actually seen in CI
 * — `BLOCK over 0 of 1 blocking finding(s)`, on runs 39770912983 and
 * 39795440261 and at roughly 6 of the last 20 runs — is a verdict of BLOCK
 * over a payload whose findings are all advisory. Every one of them is
 * filtered out of `detail`, so the refusal printed the arithmetic and
 * nothing else, and the one observation the reviewer made was destroyed by
 * the code reporting it. A re-run returns CLEAN and writes no contradiction,
 * so the loss is permanent: #1170's finding is gone.
 *
 * Rendered through `renderFinding` at the same index, so this list is a
 * SUPERSET of `detail` built by the same function rather than a second
 * renderer that can drift — and the contradiction arm uses it INSTEAD of
 * `detail`, never alongside it, which is what keeps a blocking finding from
 * being printed twice.
 *
 * Every item is already known to be an object carrying a declared severity
 * by the time a reading is anything other than UNMEASURED, so the fallback
 * arm is unreachable from `aiReviewRefusal`. It exists because the function
 * is exported and `unknown[]` is what it is handed: a renderer that throws
 * on a shape it was told it would never see is a refusal nobody can read.
 */
export function renderCountedFindings(reported: unknown[] | null): string[] {
  if (reported === null) return [];
  return reported.map((item, i) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? renderFinding(i, item as Record<string, unknown>)
      : `finding ${i} is ${JSON.stringify(item)}`,
  );
}

/** The annotation title the script prints its refusal under. */
export const AI_REVIEW_FINDINGS_TITLE = "AI review findings";

/** The four states a reading can be in. Exactly one is reached per run. */
export type AiReviewOutcome = "CLEAN" | "BLOCKED" | "CONTRADICTION" | "UNMEASURED";

/** Why a reading is UNMEASURED. Each is a different fact with a different fix. */
export type AiReviewUnmeasuredReason =
  | "FINDINGS_FILE_ABSENT"
  | "FINDINGS_FILE_UNREADABLE"
  | "FINDINGS_UNPARSEABLE"
  | "FINDINGS_NOT_AN_OBJECT"
  | "FINDINGS_KEY_ABSENT"
  | "FINDINGS_KEY_NOT_A_LIST"
  | "FINDING_NOT_AN_OBJECT"
  | "SEVERITY_ABSENT"
  | "SEVERITY_UNRECOGNISED"
  | "BLOCKING_FINDING_INCOMPLETE"
  | "VERDICT_ABSENT"
  | "VERDICT_UNRECOGNISED";

/**
 * The fields a BLOCKING finding must carry, derived from the one contract map
 * rather than re-listed (#1166).
 *
 * `severity` is excluded because it is read before this runs and has its own
 * two reasons; a second check of it would be the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md` — two deciders agreeing about
 * one input, of which a mutation leaves either one holding the case up.
 */
export const AI_REVIEW_BLOCKING_REQUIRED_FIELDS: readonly string[] = Object.entries(
  AI_REVIEW_FINDING_FIELDS,
)
  .filter(([key]) => key !== "severity")
  .map(([, name]) => name);

/**
 * The contract fields a blocking finding failed to supply, in contract order.
 *
 * ONE binding, exported, so a test can mutate it and prove the refusal below
 * is what the case observed rather than an unrelated reason firing.
 *
 * Absent, `null`, and blank are the same fact: the annotation a maintainer
 * acts on names no code either way. `renderFinding` has printed
 * `(no file recorded)` for this since #631 and carried on, so a blocking
 * finding with a fabricated `failure_scenario`, no `file` and no `line`
 * adjudicated IDENTICALLY to one with evidence under it — BLOCKED is BLOCKED,
 * and the prompt's "every one of those member names is required on every
 * finding" was enforced by nothing.
 *
 * Measured instance, 2026-10-22, #1137: a HIGH claimed `PROTECTED_GATES` was
 * missing three gate names. Two of the three were real, the finding cited no
 * file and no line, and the names are never written as literals anywhere —
 * the write is `state.gates[gate] = …` inside `writeGateResult`. Requiring a
 * file and a line would have forced the reviewer to produce the site or drop
 * the finding; what happened instead was a round of argument from a grep.
 */
export function blockingContractViolations(finding: Record<string, unknown>): string[] {
  return AI_REVIEW_BLOCKING_REQUIRED_FIELDS.filter(name => {
    const value = finding[name];
    if (value === undefined || value === null) return true;
    return typeof value === "string" && value.trim() === "";
  });
}

export interface AiReviewFindingsReading {
  /** The single discriminator. Everything else is a projection of the same pass. */
  outcome: AiReviewOutcome;
  /**
   * Computed from the severities alone, and `null` under UNMEASURED — a
   * withheld decision, not a defaulted one.
   */
  blocked: boolean | null;
  /** The payload as read, or `null` when there was nothing readable to read. */
  reported: unknown[] | null;
  /** The subset of `reported` whose severity blocks, or `null` under UNMEASURED. */
  blockingReported: unknown[] | null;
  /** The agent's own word, or `null` when it did not write a usable one. */
  verdict: string | null;
  /** Empty if and only if the outcome is not UNMEASURED. */
  unmeasuredReasons: AiReviewUnmeasuredReason[];
  /** The producing code's own sentences, one per reason or blocking finding. */
  detail: string[];
}

/**
 * `true`, `false`, or `null` for a severity the table does not declare.
 *
 * Three states, not two: an unrecognised severity is unclassified, and
 * unclassified is not "does not block".
 */
export function severityBlocks(severity: unknown): boolean | null {
  if (typeof severity !== "string") return null;
  const blocks = AI_REVIEW_SEVERITIES[severity];
  return blocks === undefined ? null : blocks;
}

function unmeasured(
  reasons: AiReviewUnmeasuredReason[],
  detail: string[],
  reported: unknown[] | null = null,
): AiReviewFindingsReading {
  return {
    outcome: "UNMEASURED",
    blocked: null,
    reported,
    blockingReported: null,
    verdict: null,
    unmeasuredReasons: reasons,
    detail,
  };
}

/**
 * Read a findings payload and decide what it means.
 *
 * `raw` is `null` for "there was no payload at all", which is a reading and
 * not an error: a job whose reviewer never wrote anything has not passed a
 * review, it has not had one.
 */
export function readAiReviewFindings(raw: string | null): AiReviewFindingsReading {
  if (raw === null) {
    return unmeasured(["FINDINGS_FILE_ABSENT"], ["no findings payload was produced"]);
  }

  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return unmeasured(
      ["FINDINGS_UNPARSEABLE"],
      [`the payload is not JSON: ${(e as Error).message}`],
    );
  }

  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return unmeasured(
      ["FINDINGS_NOT_AN_OBJECT"],
      [`the payload parsed to ${Array.isArray(doc) ? "an array" : String(doc)}, not an object`],
    );
  }

  const obj = doc as Record<string, unknown>;
  const present = Object.keys(obj);

  if (!(AI_REVIEW_FINDINGS_KEY in obj)) {
    return unmeasured(
      ["FINDINGS_KEY_ABSENT"],
      [
        `the payload carries no '${AI_REVIEW_FINDINGS_KEY}' key ` +
          `(it carries ${present.length > 0 ? present.join(", ") : "no keys at all"}). ` +
          `An absent key is not an empty list and an empty list is not a clean review.`,
      ],
    );
  }

  const list = obj[AI_REVIEW_FINDINGS_KEY];
  if (!Array.isArray(list)) {
    return unmeasured(
      ["FINDINGS_KEY_NOT_A_LIST"],
      [`'${AI_REVIEW_FINDINGS_KEY}' is ${typeof list}, not a list`],
    );
  }

  const reasons: AiReviewUnmeasuredReason[] = [];
  const detail: string[] = [];
  const blocking: unknown[] = [];

  list.forEach((item, i) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      reasons.push("FINDING_NOT_AN_OBJECT");
      detail.push(`finding ${i} is not an object`);
      return;
    }
    const finding = item as Record<string, unknown>;
    if (!(AI_REVIEW_SEVERITY_KEY in finding)) {
      reasons.push("SEVERITY_ABSENT");
      detail.push(`finding ${i} carries no '${AI_REVIEW_SEVERITY_KEY}'`);
      return;
    }
    const severity = finding[AI_REVIEW_SEVERITY_KEY];
    const blocks = severityBlocks(severity);
    if (blocks === null) {
      reasons.push("SEVERITY_UNRECOGNISED");
      detail.push(
        `finding ${i} has severity ${JSON.stringify(severity)}, which the contract ` +
          `does not declare (${Object.keys(AI_REVIEW_SEVERITIES).join(", ")})`,
      );
      return;
    }
    if (blocks) {
      // #1166, and BLOCKING findings only. A non-blocking finding costs a
      // line in an annotation and nothing else, so holding it to the same
      // contract would redden runs over the cheap tail the module is already
      // losing (#1162) — and an incomplete `info` is not a decision anybody
      // acts on. What a blocking finding buys is a red required check, which
      // is the one output of this module worth forging.
      const missing = blockingContractViolations(finding);
      if (missing.length > 0) {
        reasons.push("BLOCKING_FINDING_INCOMPLETE");
        detail.push(
          `finding ${i} blocks (severity ${JSON.stringify(severity)}) and carries no ` +
            `${missing.join(", ")}. A blocking finding that names no code is not a ` +
            `finding a maintainer can act on or refute, and the contract the ` +
            `reviewer was given requires every field on every finding`,
        );
        return;
      }
      blocking.push(item);
      detail.push(renderFinding(i, finding));
    }
  });

  let verdict: string | null = null;
  if (!(AI_REVIEW_VERDICT_KEY in obj)) {
    reasons.push("VERDICT_ABSENT");
    detail.push(`the payload carries no '${AI_REVIEW_VERDICT_KEY}' key`);
  } else {
    const word = obj[AI_REVIEW_VERDICT_KEY];
    if (word !== AI_REVIEW_PASS_VERDICT && word !== AI_REVIEW_BLOCK_VERDICT) {
      reasons.push("VERDICT_UNRECOGNISED");
      detail.push(
        `'${AI_REVIEW_VERDICT_KEY}' is ${JSON.stringify(word)}, which is neither ` +
          `${AI_REVIEW_PASS_VERDICT} nor ${AI_REVIEW_BLOCK_VERDICT}`,
      );
    } else {
      verdict = word;
    }
  }

  if (reasons.length > 0) return unmeasured(reasons, detail, list);

  // The decision, and the only place it is made. `verdict` is compared to it
  // afterwards; it never contributes to it.
  const blocked = blocking.length > 0;
  const agreed = verdict === (blocked ? AI_REVIEW_BLOCK_VERDICT : AI_REVIEW_PASS_VERDICT);
  const outcome: AiReviewOutcome = !agreed ? "CONTRADICTION" : blocked ? "BLOCKED" : "CLEAN";

  return {
    outcome,
    blocked,
    reported: list,
    blockingReported: blocking,
    verdict,
    unmeasuredReasons: [],
    detail,
  };
}

/** Read the payload from disk. An absent file and an unreadable one differ. */
export function readAiReviewFindingsFile(path: string): AiReviewFindingsReading {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return unmeasured(["FINDINGS_FILE_ABSENT"], [`no findings payload at ${path}`]);
    }
    return unmeasured(
      ["FINDINGS_FILE_UNREADABLE"],
      [`the findings payload at ${path} could not be read: ${(e as Error).message}`],
    );
  }
  return readAiReviewFindings(raw);
}

/** The sentence a refusal prints, or `null` when there is nothing to refuse. */
export function aiReviewRefusal(reading: AiReviewFindingsReading): string | null {
  // The producing code's own sentences, carried rather than re-derived. An
  // empty list is a reading too, so it must not print as a stray full stop.
  const detail = reading.detail.length > 0 ? `${reading.detail.join("; ")}. ` : "";
  switch (reading.outcome) {
    case "CLEAN":
      return null;
    case "UNMEASURED":
      return (
        `The AI review is UNMEASURED: ${reading.unmeasuredReasons.join(", ")}. ` +
        `${detail}Failing rather than reporting a green check for a review ` +
        `whose result nobody can read.`
      );
    case "BLOCKED":
      return (
        `The AI review reported ${reading.blockingReported?.length ?? 0} blocking ` +
        `finding(s). ${detail}`.trimEnd()
      );
    case "CONTRADICTION": {
      // THE WHOLE PAYLOAD, not `detail` (#1178). `detail` holds only the
      // findings that block, and the contradiction this issue is about —
      // `BLOCK over 0 of 1` — is one where none of them do, so `detail` is
      // empty and the refusal was arithmetic with the evidence stripped out.
      //
      // The annotation is the right place for it and the only durable one.
      // The payload file lives under `$RUNNER_TEMP` and dies with the runner;
      // three attempts to retrieve #1170's from there returned nothing. This
      // string reaches `::error` at the single emission site in `main()`, the
      // generated step captures the reader with `2>&1` and `printf`s the
      // capture, and GitHub records the result against the check run — so it
      // outlives the job, and it outlives a later re-run that comes back
      // CLEAN. Which is the point: a contradiction that resolves on retry
      // still has to leave something countable behind.
      //
      // Used INSTEAD of `detail` rather than appended to it. The two overlap
      // exactly on the blocking findings, so appending would print those
      // twice, and a duplicate reads as two findings.
      const counted = renderCountedFindings(reading.reported);
      const payload = counted.length > 0
        ? `${counted.join("; ")}. `
        : `The payload records no findings at all. `;
      return (
        `The AI review's verdict ${JSON.stringify(reading.verdict)} contradicts its ` +
        `own payload: ${reading.blockingReported?.length ?? 0} of ` +
        `${reading.reported?.length ?? 0} finding(s) block. ${payload}` +
        `A verdict that disagrees with the findings beneath it is a contradiction, ` +
        `not a result. The findings above are what the reviewer actually wrote; ` +
        `they are reported here because this is the only place they survive the ` +
        `job, and a re-run that comes back clean will not produce them again.`
      );
    }
  }
}

/** 0 for a clean reading; the one imported refusal code for everything else. */
export function aiReviewExitCode(reading: AiReviewFindingsReading): number {
  return reading.outcome === "CLEAN" ? 0 : AI_REVIEW_REQUIRED_EXIT;
}

/**
 * The CLI the generated workflow step runs: one argument, the payload's path.
 *
 * Returns the exit code rather than calling `process.exit`, so a test can run
 * it in-process as well as spawn it.
 */
export function main(argv: string[]): number {
  const path = argv[0];
  const reading =
    path === undefined || path === ""
      ? unmeasured(
          ["FINDINGS_FILE_ABSENT"],
          ["no findings payload path was given to the findings reader"],
        )
      : readAiReviewFindingsFile(path);

  // FIRST, and before any branch below can return. The generated workflow step
  // greps its own output for this prefix and will not read the exit code as a
  // verdict without it (#1013) — an adjudicator that could not run and one that
  // refused both exit non-zero, and only this line tells them apart.
  console.log(`${AI_REVIEW_OUTCOME_LINE} ${reading.outcome}`);

  // The ONE place a value reaches a workflow command. Everything upstream of
  // here — `renderFinding`, every `detail` sentence, `aiReviewRefusal` — builds
  // plain text and leaves escaping alone, so there is one binding to mutate and
  // no path where two escapers run in sequence and turn `%` into `%2525`.
  const refusal = aiReviewRefusal(reading);
  if (refusal !== null) {
    console.error(`::error title=${AI_REVIEW_FINDINGS_TITLE}::${escapeAnnotation(refusal)}`);
  }

  return aiReviewExitCode(reading);
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
