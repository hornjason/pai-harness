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

/**
 * The annotation title the advisory tail is printed under.
 *
 * A SEPARATE title from `AI_REVIEW_FINDINGS_TITLE`, deliberately. The refusal
 * is a thing somebody has to act on before the pull request moves; this is a
 * thing somebody has to answer before it merges, and GitHub groups
 * annotations by title. One title for both would make the advisory tail
 * read, in the checks UI, as part of the refusal — which is the misattribution
 * `blockingContractViolations` is about, arriving from the other direction.
 */
export const AI_REVIEW_ADVISORY_TITLE = "AI review advisory findings";

/**
 * A stable identity for one finding, so an answer can name it.
 *
 * @identity file+summary — whitespace-collapsed and case-folded, FNV-1a, 8
 * hex characters. Total: every finding gets a key, and it is never `null`.
 *
 * **This is the ADJUDICATION key** — "has this advisory already been counted
 * on this run". Within one payload there is only one version of the file, so
 * the line genuinely does not matter, and keying on it would split one
 * finding into two across a reformat.
 *
 * Its sibling is `carryKey` in `lib/ai-review-rounds.ts`, which is the
 * PERSISTENCE key — "is the thing this round raised the thing the last round
 * raised" — over `file` + the cited line's TEXT + `summary`, and partial: it
 * returns `null` for a finding it cannot key, which this hash cannot do. The
 * two were both called `findingKey` until #1398. They answer different
 * questions and the collapse loses one; neither can quietly become the
 * other, which was measured rather than assumed, but while they shared a
 * name no call site could say which it had asked.
 *
 * CRC-B8 asks that every finding be answered — fixed, or resolved with a
 * stated reason — and an answer has to name what it answers. The line number
 * cannot be that name: the same finding moves line between rounds, which is
 * exactly what #1319 measured (`bash-write-guard.ts:90 → :97` across two
 * rounds of #1213 was *one* finding). So the key is over the file and the
 * summary, whitespace-collapsed and case-folded, and it is deliberately NOT
 * over the severity either — a reviewer that re-rates the same observation
 * has not produced a second finding.
 *
 * FNV-1a, written out, rather than `node:crypto`. Not a preference: this
 * module is copied into a temp directory by the mutation battery in
 * `test/ai-review-advisory-findings.test.ts`, and every import it carries has
 * to be carried with it. The property wanted is determinism and a short
 * printable token, not collision resistance against an adversary.
 *
 * ## WHAT A COLLISION COSTS, and it is no longer only an annotation
 *
 * This docblock used to end *"a finding that forged another finding's key
 * would buy the forger an answer on the wrong row, which is a worse
 * annotation and not a bypass of anything."* That stopped being true the
 * moment CRC-B4 made the verifier quorum read a ballot filed under this
 * key: a collision between two BLOCKING findings would let one group's vote
 * decide both. The sentence is corrected rather than deleted because a
 * comment asserting a property the code no longer has is the reason nobody
 * checks it — `lib/cli-commands.ts` carried *"runs every command for real"*
 * over a test that ran one command of ten.
 *
 * What holds instead, and it is a property of the CALLER rather than of
 * this hash: `juryGate` derives the identity once over the whole blocking
 * set, refuses a key two of them share, and carries its decision back to
 * the reader **by position**. So a collision is seen and both findings keep
 * blocking; it cannot silently credit one finding's vote to another. The
 * hash is still not adversary-resistant and is not asked to be — nothing
 * downstream of it decides anything a collision could not already be
 * refused for.
 */
export function advisoryKey(finding: Record<string, unknown>): string {
  const f = AI_REVIEW_FINDING_FIELDS;
  const normalise = (v: unknown): string =>
    String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const subject = `${normalise(finding[f.file])}\u0000${normalise(finding[f.summary])}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < subject.length; i++) {
    hash ^= subject.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The findings this reading counted and did NOT act on — the advisory tail.
 *
 * `null`, never `[]`, when the complement cannot be taken. Under UNMEASURED
 * `blockingReported` is `null` — a withheld decision, not an empty one — so
 * subtracting it from `reported` would manufacture an advisory set out of
 * findings nobody classified. Those are different facts and this module's
 * whole philosophy is that they stay different.
 *
 * Computed by identity against `blockingReported` rather than by re-reading
 * the severities. Re-reading them here would be a second decider over the one
 * question `severityBlocks` already answers — the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md` — and a mutation of either
 * would leave the other holding every case up.
 */
export function advisoryReported(reading: AiReviewFindingsReading): unknown[] | null {
  if (reading.reported === null || reading.blockingReported === null) return null;
  const blocking = new Set(reading.blockingReported);
  return reading.reported.filter(item => !blocking.has(item));
}

/**
 * The sentence naming every advisory finding, or `null` when there is nothing
 * to name.
 *
 * ## The silent drop this closes (CRC-B8)
 *
 * `AI_REVIEW_SEVERITIES` declares `medium`, `low` and `info` as advisory, and
 * until this function existed a reading counted them and then dropped them.
 * `detail` is populated inside `if (blocks)`; `aiReviewRefusal` returns `null`
 * for CLEAN and lists only `detail` for BLOCKED. So `main()` printed the
 * outcome line and nothing else, and a payload carrying seven `medium`
 * findings produced **byte-identical output** to a payload carrying none.
 * The payload itself lives under `$RUNNER_TEMP`, is uploaded nowhere (#1319
 * measured zero artifacts) and dies with the runner, so the finding was not
 * merely unreported — it was unrecoverable the moment the job ended.
 *
 * That is CRC-B8's second sentence failing in the live path: *a finding is
 * never silently dropped*. It is also the reason the tail could not be
 * answered rather than filed — you cannot resolve on the pull request a
 * finding the pull request never shows you.
 *
 * ## Why CONTRADICTION returns null here
 *
 * The contradiction arm of `aiReviewRefusal` already prints EVERY counted
 * finding, advisory ones included, through `renderCountedFindings` — #1178,
 * and for a reason that still holds. Emitting this notice alongside it would
 * print the advisory tail twice, and that module's own comment says why that
 * is worse than printing it once: *a duplicate reads as two findings*. The
 * rule lives here, in one function, rather than as a condition at the call
 * site, so there is one binding to mutate.
 *
 * ## What this does NOT do
 *
 * It decides nothing. `aiReviewExitCode` is untouched and reads only the
 * outcome, so an advisory finding does not block and cannot be made to block
 * from here. Surfacing a finding and adjudicating one are different jobs, and
 * this module already holds the second; a notice that quietly became a
 * refusal would be a severity table nobody declared.
 */
export function advisoryNotice(reading: AiReviewFindingsReading): string | null {
  if (reading.outcome === "CONTRADICTION") return null;
  const advisory = advisoryReported(reading);
  if (advisory === null || advisory.length === 0) return null;

  // Rendered through `renderCountedFindings` over the WHOLE list and then
  // selected, rather than over the filtered list. Two reasons, and the second
  // is the one that bites: the renderer numbers what it is given, so rendering
  // the tail alone would renumber it from zero and `finding 3` in this notice
  // would be a different finding from `finding 3` in a refusal. And selecting
  // out of the full render means this notice and the contradiction arm's list
  // come from one call of one function, which is what keeps them from drifting.
  const reported = reading.reported ?? [];
  const all = renderCountedFindings(reported);
  const rendered = advisory.map(item => {
    const i = reported.indexOf(item);
    const key =
      item !== null && typeof item === "object" && !Array.isArray(item)
        ? ` [key ${advisoryKey(item as Record<string, unknown>)}]`
        : "";
    return `${all[i]}${key}`;
  });

  return (
    `${advisory.length} advisory finding(s) were counted and block nothing. ` +
    `${rendered.join("; ")}. ` +
    `Each is UNANSWERED: nothing in this pipeline requires it to be fixed, ` +
    `resolved with a reason, or filed, and this annotation is the only place ` +
    `it survives the job — the payload lives under the runner's temp directory ` +
    `and is uploaded nowhere. Answer each one on this pull request (fix it, or ` +
    `say in a comment why it stands), naming its key. Filing an issue is the ` +
    `exception, not the default.`
  );
}

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
  | "VERDICT_UNRECOGNISED"
  /**
   * A changed-file list was supplied and was EMPTY. A pull request always
   * touches something, so `[]` is a reading that failed rather than a pull
   * request that changed nothing — and taken at face value it would tag every
   * finding `Pre-existing` and block none of them, which is the fail-open this
   * module exists to refuse.
   */
  | "CHANGED_FILES_EMPTY"
  /**
   * A changed-file list entry could not be read as a repository path.
   * Comparing against a list the reader cannot normalise would demote every
   * finding, so the list being unreadable is a reading that failed.
   */
  | "CHANGED_FILES_UNREADABLE"
  /**
   * A verifier ballot was named and could not be read (CRC-B4). An empty
   * ballot set withholds nothing, which is indistinguishable from a group
   * that upheld every finding, so a source this reader could not parse is a
   * reading that failed rather than a quorum that agreed.
   */
  | "BALLOT_UNREADABLE"
  /**
   * A verifier ballot was named and no gate was wired to count it.
   *
   * The counting lives in `lib/ai-review-jury.ts` and is INJECTED rather
   * than imported — see `main` — so an entry point that forgets to supply it
   * would otherwise adjudicate the ballot away in silence. "Told to take a
   * vote and could not" is UNMEASURED, and the finding keeps blocking.
   */
  | "BALLOT_UNWIRED"
  /**
   * The quorum returned a verdict list that does not describe the blocking
   * set it was handed (CRC-B4).
   *
   * The same refusal `BALLOT_COUNT_MISMATCH` makes one level down in
   * `lib/finding-arbiter.ts`: padding the short end would uphold findings
   * nobody voted on and truncating the long end would discard votes
   * somebody cast. Which group voted on which finding is not recoverable
   * from a list of the wrong length, so nothing is recovered from it.
   */
  | "JURY_VERDICT_COUNT_MISMATCH";

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
 *
 * `changedFiles` is CRC-B7 (CODE-REVIEW-CONVERGENCE-SPEC): a finding naming
 * no file this pull request touched is tagged `Pre-existing` and does not
 * block, so a bug that was already on `main` does not read as the change's
 * fault. `ai-review` reads the MERGE REF, so without this every defect on
 * `main` is reported against whichever pull request is standing closest —
 * nine of them at once on 2026-10-23.
 *
 * **`undefined` and `[]` are different facts.** `undefined` is "no list was
 * supplied", under which nothing is demoted and the reading is exactly what
 * it was before this parameter existed. `[]` is a list that was supplied and
 * is empty, which no real pull request produces, so it is UNMEASURED rather
 * than "every finding is pre-existing" — the direction this is allowed to be
 * wrong in is toward blocking.
 *
 * The finding's DECLARED `file` is the input, not a path mined out of its
 * prose. `blockingContractViolations` already refuses a blocking finding that
 * carries none, and `lib/finding-jury.ts`'s `citedPaths` text-mines only
 * because the arbiter's findings arrive as prose. Mining a field the payload
 * declares would be a second decider for a question already answered.
 */
export function readAiReviewFindings(
  raw: string | null,
  changedFiles?: readonly string[],
  withheld?: readonly (string | null)[],
): AiReviewFindingsReading {
  if (raw === null) {
    return unmeasured(["FINDINGS_FILE_ABSENT"], ["no findings payload was produced"]);
  }

  if (changedFiles !== undefined && changedFiles.length === 0) {
    return unmeasured(
      ["CHANGED_FILES_EMPTY"],
      [
        "a changed-file list was supplied and was empty. A pull request always touches " +
          "something, so this is a reading that failed rather than a pull request that " +
          "changed nothing — and taken at face value every finding would be tagged " +
          "Pre-existing and none would block.",
      ],
    );
  }
  let touched: Set<string> | null = null;
  if (changedFiles !== undefined) {
    const unreadable = changedFiles.filter(p => normaliseRepoPath(p) === null);
    if (unreadable.length > 0) {
      return unmeasured(
        ["CHANGED_FILES_UNREADABLE"],
        [
          `${unreadable.length} changed-file entr(ies) could not be read as a repository ` +
            `path: ${unreadable.slice(0, 3).map(p => JSON.stringify(p)).join(", ")}. ` +
            `Comparing against a list this reader cannot normalise would tag every finding ` +
            `Pre-existing. Produce the list with -z or core.quotePath=false`,
        ],
      );
    }
    touched = new Set(changedFiles.map(p => normaliseRepoPath(p) as string));
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
  /**
   * How many findings a demotion removed from the blocking set — CRC-B7's
   * Pre-existing tag and CRC-B4's verifier quorum both. See the `agreed`
   * computation below for why the reviewer's word is compared against the
   * count BEFORE either of them ran.
   */
  let demoted = 0;
  /**
   * How many findings have reached the verifier quorum's branch so far.
   *
   * The index into `withheld`, and the whole of the positional carry. It
   * counts findings that would otherwise block — not findings in the
   * payload — so it advances in step with the list the gate was handed.
   */
  let blockingIndex = 0;

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
      // CRC-B7, and AFTER the contract check rather than before it. A finding
      // with no declared `file` cannot be tagged either way, and it has
      // already been refused as incomplete one branch up — so by here `file`
      // is known present, and the tag is decidable rather than guessed.
      //
      // It DEMOTES, it does not drop (CRC-B8). The finding stays in
      // `reported`, so `advisoryReported` carries it into the notice and a
      // maintainer still sees it; it simply stops reddening a required check
      // over a defect the diff did not introduce and cannot fix.
      if (touched !== null) {
        const declared = finding[AI_REVIEW_FINDING_FIELDS.file];
        // A non-string `file` is a CONTRACT violation, not a demotion input.
        // `blockingContractViolations` refuses `undefined`, `null` and the
        // empty string and lets a number or an object through, so without
        // this a finding declaring `file: {}` stringifies to
        // `[object Object]`, matches nothing, and demotes itself.
        if (typeof declared !== "string") {
          reasons.push("BLOCKING_FINDING_INCOMPLETE");
          detail.push(
            `finding ${i} blocks and declares a non-string ` +
              `'${AI_REVIEW_FINDING_FIELDS.file}' (${typeof declared}). A path that is not a ` +
              `string cannot be compared to the changed-file list, and a comparison that ` +
              `cannot be made is not a finding that is pre-existing`,
          );
          return;
        }
        const named = normaliseRepoPath(declared);
        // Undecidable is NOT pre-existing. The finding is well-formed and
        // this reader simply cannot resolve its path, so it keeps blocking —
        // the direction this stage is allowed to be wrong in.
        if (named === null) {
          detail.push(
            `finding ${i} declares ${JSON.stringify(declared)}, which could not be read as a ` +
              `repository path, so it could not be compared to the changed-file list. It ` +
              `keeps blocking: undecidable is not pre-existing`,
          );
        } else if (!touched.has(named)) {
          demoted += 1;
          detail.push(
            `finding ${i} is Pre-existing: it names ${JSON.stringify(
              finding[AI_REVIEW_FINDING_FIELDS.file],
            )}, which this pull request does not touch. It is reported and does not block — ` +
              `ai-review reads the merge ref, so a defect already on the base branch is ` +
              `adjudicated against whichever pull request is standing closest to it`,
          );
          return;
        }
      }
      // CRC-B4, and LAST of the three demotions, deliberately. The verifier
      // group votes on the findings that would otherwise block, so it must
      // see the set the earlier stages leave behind rather than the raw
      // severity list — spending a full agent context on a finding the
      // contract check or CRC-B7 has already removed is the budget this
      // criterion is careful about.
      //
      // It DEMOTES, it does not drop (CRC-B8). The finding stays in
      // `reported`, so `advisoryReported` carries it into the notice and a
      // maintainer still sees what the group voted down.
      //
      // BY POSITION, and never by re-deriving the finding's identity.
      //
      // The list has one entry per finding that reaches this point, in the
      // order they reach it — which is exactly the list the gate was handed
      // as `blockingReported`, because pass one and pass two are this same
      // function over the same payload and the only thing that differs is
      // applied AFTER the decision each entry describes.
      //
      // An earlier cut keyed the verdict by `advisoryKey` and looked it up
      // here, which made two findings sharing an identity share a vote:
      // whichever the group voted on, the other was withheld or upheld on a
      // verdict that was never about it. `lib/finding-arbiter.ts`'s
      // `SHARED_BALLOT` had already refused precisely that — *"a vote is
      // about a finding"* — and its remedy is one group per finding, in
      // input order. A hash looked up twice is two derivations of one
      // identity; a position is none.
      //
      // `null` means this finding keeps blocking. The gate separates "the
      // group voted it down" from "no group could be convened" where the
      // ballot is counted; by here there are only two outcomes.
      if (withheld !== undefined) {
        const voted = withheld[blockingIndex];
        blockingIndex += 1;
        if (voted !== undefined && voted !== null) {
          demoted += 1;
          detail.push(`finding ${i} is withheld by the verifier group: ${voted}`);
          return;
        }
      }
      blocking.push(item);
      detail.push(renderFinding(i, finding));
    }
  });

  // The positional carry's own precondition, asserted rather than assumed.
  //
  // It is reachable: `withheld` comes from an INJECTED gate, so a caller
  // that returns a list of the wrong length is a real input and not a
  // hypothetical. Padding the short end would uphold findings nobody voted
  // on and truncating the long end would discard votes somebody cast —
  // `BALLOT_COUNT_MISMATCH`'s argument in `lib/finding-arbiter.ts`, one
  // level up. Neither is taken: the reading refuses.
  if (withheld !== undefined && withheld.length !== blockingIndex) {
    reasons.push("JURY_VERDICT_COUNT_MISMATCH");
    detail.push(
      `the verifier quorum returned ${withheld.length} verdict(s) for ${blockingIndex} finding(s) ` +
        `that would otherwise block. Which group voted on which finding is not recoverable from ` +
        `a list of the wrong length, so none of it is used`,
    );
  }

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
  // The agreement is measured BEFORE the demotions, not after them.
  //
  // The reviewer is not given the pull request's file list, so it cannot know
  // a finding is pre-existing and its `BLOCK` over one is honest. Comparing
  // its word against the post-demotion count would turn every successful
  // demotion into a CONTRADICTION — the arm would fire on the mechanism
  // working, which is the loudest possible way to be wrong.
  //
  // CRC-B4's withholding counts into the SAME number, for the same reason
  // one step further out: the reviewer never saw the ballot either. A
  // `BLOCK` over a finding a later verifier group voted down is an honest
  // verdict that was overruled, not a reviewer disagreeing with itself.
  //
  // The real contradiction #1178 exists for is untouched: a `BLOCK` over a
  // payload whose findings are ALL advisory has `demoted === 0`, so it still
  // fires. Measured at roughly 6 of 20 runs when that was written.
  const wouldBlock = blocked || demoted > 0;
  const agreed = verdict === (wouldBlock ? AI_REVIEW_BLOCK_VERDICT : AI_REVIEW_PASS_VERDICT);
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

/**
 * The pull request's changed files, read from a newline-delimited file.
 *
 * `null` means the path was given and could not be read, which the caller
 * must NOT collapse into "no list was supplied" — see `readAiReviewFindings`
 * on why `undefined` and `[]` are different facts. This returns the third
 * one, and it is the same distinction a third time.
 *
 * Blank lines are dropped before the emptiness test, so a file containing
 * only whitespace reads as empty rather than as one unnamed file.
 */
/**
 * One repository path, in the one spelling both sides of CRC-B7's comparison
 * are reduced to — or `null` for "this cannot be read as a repository path".
 *
 * **`null` is the important return.** The first cut of CRC-B7 compared
 * `String(finding.file).toLowerCase()` against a raw list, and every input
 * the comparison could not read demoted a `critical` to CLEAN, because a
 * spelling that is never in the set is indistinguishable from a file the
 * pull request did not touch. Measured against a list holding `lib/mine.ts`:
 *
 * ```
 * CLEAN 0 blocking   {}   123   "./lib/mine.ts"   "lib/mine.ts:12"
 * CLEAN 0 blocking   "lib\mine.ts"                "/lib/mine.ts"
 * ```
 *
 * Six for six, five of them the SAME FILE spelt differently. `./x`, `/x`,
 * `x` and `x:12` are one file and four strings, and an equality test over
 * raw strings answers a different question from the one being asked.
 *
 * So both sides go through here, and a `null` on either side is a refusal
 * rather than a mismatch. The git C-quoted form — `"lib/\303\251.ts"`, which
 * git emits for a non-ASCII path unless `core.quotePath=false` — is
 * deliberately `null` rather than unescaped here: decoding octal escapes to
 * compare a path is a second parser, and the right repair is to produce the
 * list with `-z` or `core.quotePath=false` in the first place.
 */
export function normaliseRepoPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let p = value.trim().replace(/\\/g, "/");
  // git's C-quoted spelling. Not comparable without a second unescaper.
  if (p.startsWith('"') && p.endsWith('"')) return null;
  p = p.replace(/^\/+/, "").replace(/:\d+(?::\d+)?$/, "");

  // Dot segments are COLLAPSED, not stripped once. `.replace(/^\.\//, "")`
  // removes one leading `./` and leaves `././lib/a.ts` as `./lib/a.ts`, which
  // the shape test below accepts — `.` and `..` are both legal matches for
  // `[\w.@+-]+`. Measured on this file before the fix:
  //
  //   "././lib/mine.ts"    -> "./lib/mine.ts"
  //   "lib/./mine.ts"      -> "lib/./mine.ts"
  //   "lib/../lib/mine.ts" -> "lib/../lib/mine.ts"
  //
  // Each compares unequal to `lib/mine.ts`, so a blocking finding naming the
  // file in one of those spellings was demoted to Pre-existing against a
  // change list that contained it — the same fail-open round one shipped,
  // in a narrower spelling. Found by the push review on this branch.
  //
  // A `..` that would leave the repository root is refused rather than
  // clamped: `../outside.ts` is not a repository-relative path, and turning
  // it into `outside.ts` invents a file this change may well have touched.
  const out: string[] = [];
  for (const segment of p.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.pop() === undefined) return null;
      continue;
    }
    out.push(segment);
  }
  p = out.join("/");
  if (p === "") return null;

  return /^(?:[\w.@+-]+\/)*[\w.@+-]+$/.test(p) ? p.toLowerCase() : null;
}

export function readChangedFiles(path: string): string[] | null {
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** Read the payload from disk. An absent file and an unreadable one differ. */
export function readAiReviewFindingsFile(
  path: string,
  changedFiles?: readonly string[],
  withheld?: readonly (string | null)[],
): AiReviewFindingsReading {
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
  return readAiReviewFindings(raw, changedFiles, withheld);
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

/** The annotation title the verifier quorum's own reading is printed under. */
export const AI_REVIEW_JURY_NOTICE_TITLE = "AI review verifier quorum";

/**
 * The verifier quorum, as `main` consumes it (CRC-B4).
 *
 * **Injected, not imported**, and the reason is mechanical rather than
 * stylistic. This module is copied into a scratch directory by three
 * mutation batteries, which carry its one relative dependency —
 * `./ai-review-step`, which has none — along with it. `lib/ai-review-jury.ts`
 * pulls in the finding arbiter and the filing gate behind it, and a mutant
 * that dies on module resolution reports zero findings, which reads exactly
 * like a guard behaving differently
 * (`.claude/rules/self-referential-tests.md`, Tier 1, last row).
 *
 * The seam is closed rather than left open: a ballot path with no gate wired
 * is `BALLOT_UNWIRED`, which is UNMEASURED and refuses. So the two entry
 * points — `scripts/ai-review-findings.ts`, which supplies the gate, and
 * this module's own `import.meta.main`, which does not — cannot diverge into
 * one that ignores the ballot and reports a pass.
 */
export interface AiReviewJuryGate {
  (
    blocking: readonly unknown[],
    ballotPath: string,
  ): {
    /** Findings the group voted down, by key, with the sentence saying so. */
    withheld: Readonly<Record<string, string>>;
    /** Non-null when the ballot source itself could not be read. */
    unreadable: string | null;
    /** One sentence per finding voted on. */
    detail: readonly string[];
  };
}

/**
 * The CLI the generated workflow step runs: one argument, the payload's path.
 *
 * Returns the exit code rather than calling `process.exit`, so a test can run
 * it in-process as well as spawn it.
 */
export function main(argv: string[], jury: AiReviewJuryGate | null = null): number {
  const path = argv[0];
  // CRC-B7. The SECOND argument is a path to the pull request's changed
  // files, and it is optional: a caller that does not pass one gets exactly
  // the reading this module gave before the criterion was wired, which is
  // what keeps every existing consumer working unchanged.
  //
  // An unreadable list is NOT silently treated as absent. "I was told to read
  // a list and could not" is a reading that failed, and under it a finding
  // would never be demoted — so the run blocks, loudly, rather than quietly
  // behaving like a caller that never asked for the tag at all.
  const changedPath = argv[1];
  const changed =
    changedPath === undefined || changedPath === "" ? undefined : readChangedFiles(changedPath);
  // CRC-B4. The THIRD argument is a path to the verifier group's ballot, and
  // it is optional on the same terms as the second: a caller that passes
  // none gets exactly the reading this module gave before the quorum was
  // wired. What it may NOT do is pass one and have it quietly ignored, which
  // is what `BALLOT_UNWIRED` below refuses.
  const ballotPath = argv[2];
  const reading0 =
    path === undefined || path === ""
      ? unmeasured(
          ["FINDINGS_FILE_ABSENT"],
          ["no findings payload path was given to the findings reader"],
        )
      : changed === null
        ? unmeasured(
            ["CHANGED_FILES_EMPTY"],
            [
              `a changed-file list was named at ${changedPath} and could not be read, so no ` +
                `finding could be tagged Pre-existing. That is a reading that failed, not a ` +
                `caller declining the tag`,
            ],
          )
        : readAiReviewFindingsFile(path, changed);

  // CRC-B4, in two passes of the SAME function and never two deciders.
  //
  // Pass one has no ballot, so `blockingReported` is the existing decider's
  // own answer to "which of these block". That list — and nothing re-derived
  // from the severities — is what the group's votes are looked up for, which
  // is the criterion's first clause: a quorum over the advisory tail spends
  // a full agent context per nit. Pass two is the identical read with the
  // withheld keys subtracted, so the jury only ever REMOVES from a set it
  // did not compute.
  //
  // Reading the payload twice costs one `readFileSync` of a file the step
  // just wrote. A single-pass version would have to answer "does this block"
  // inside the gate, which is the fourth shape in
  // `.claude/rules/checks-must-be-able-to-fail.md`: two deciders agreeing,
  // of which a mutation leaves either one holding every case up.
  let reading = reading0;
  let juryDetail: readonly string[] = [];
  if (ballotPath !== undefined && ballotPath !== "") {
    if (jury === null) {
      reading = unmeasured(
        ["BALLOT_UNWIRED"],
        [
          `a verifier ballot was named at ${ballotPath} and this entry point has no quorum ` +
            `wired to count it, so no finding could be withheld and none could be upheld. ` +
            `That is a vote that was not taken, not a group that agreed`,
        ],
        reading0.reported,
      );
    } else if (
      path !== undefined &&
      path !== "" &&
      changed !== null &&
      reading0.blockingReported !== null &&
      reading0.blockingReported.length > 0
    ) {
      const gate = jury(reading0.blockingReported, ballotPath);
      juryDetail = gate.detail;
      if (gate.unreadable !== null) {
        reading = unmeasured(["BALLOT_UNREADABLE"], [gate.unreadable], reading0.reported);
      } else {
        reading = readAiReviewFindingsFile(path, changed, gate.withheld);
      }
    }
  }

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

  // AFTER the refusal and BEFORE the exit code, and on its own title. A
  // `::notice` rather than a `::warning` or an `::error`: the advisory tail
  // does not block, and a notice is what GitHub records against the check run
  // without changing its conclusion. It goes through the same single escaper
  // the refusal does — this is a new value reaching a workflow command, and
  // `escapeAnnotation`'s own docblock has the measured instance of what an
  // unescaped one can do to a verdict.
  const advisory = advisoryNotice(reading);
  if (advisory !== null) {
    console.log(`::notice title=${AI_REVIEW_ADVISORY_TITLE}::${escapeAnnotation(advisory)}`);
  }

  // The quorum's own reading, on its own title, and emitted whatever the
  // outcome was. A withheld finding is the one row nothing downstream can
  // reconstruct — it is never commented on, never fixed and never filed —
  // and the ledger it is written to lives on the runner and dies with the
  // job. This annotation is the only part of it that outlives the run.
  if (juryDetail.length > 0) {
    console.log(
      `::notice title=${AI_REVIEW_JURY_NOTICE_TITLE}::${escapeAnnotation(
        `A separate verifier group voted on the ${juryDetail.length} finding(s) that would ` +
          `otherwise block. ${juryDetail.join("; ")}.`,
      )}`,
    );
  }

  return aiReviewExitCode(reading);
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
