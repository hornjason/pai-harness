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
 * ## Where a finding points, and why that is not a question about whether it
 * is right (#1204)
 *
 * A blocking finding may name a file the pull request never touched. #1166
 * made a finding missing `file`, `line`, `summary` or `failure_scenario` its
 * own reading; that is a check on whether the payload is SELF-consistent, and
 * the payload is all it needs. "The file is not in the diff" compares the
 * payload against the PULL REQUEST, so it needs a second input — the list of
 * paths the pull request changed — and the reading is withheld until it has
 * one.
 *
 * **This is not a correctness filter and must never become one.** Nothing
 * here asks whether a finding is RIGHT. A reviewer that is wrong about real
 * code is a review problem, and suppressing findings on suspicion of being
 * wrong is the fail-open this module exists against. The only question asked
 * is whether the finding can be LOCATED, which is decidable from the diff
 * without reading the claim at all.
 *
 * And an unlocatable finding is **demoted, never dropped**. The tempting
 * repair is to filter it out of the blocking list and let the run go green —
 * which makes a review that discarded a finding byte-indistinguishable from a
 * review that found nothing. So CRC-B7 tags it `Pre-existing`: the finding is
 * carried in `reported` and in `unlocatableReported`, named in the
 * annotation, counted on the scope line, and does not get to block on its
 * own.
 *
 * #1204 wrote that refusal as `BLOCKING_FINDING_UNLOCATABLE`, a red required
 * check. CRC-B7's demotion satisfies #1204's own stated criterion — the
 * finding is not DROPPED — and does not redden a pull request over a defect
 * that was already on main, so the refusal is gone and the demotion is what
 * ships. The two were written against the same input on different branches;
 * this is the resolution, not an accident of the merge.
 *
 * The second input is NOT SUPPLIED by any generated job yet, and the absent
 * state is named rather than silently skipped — `scope.status` is
 * `NOT_SUPPLIED`, `main` prints it on every run, and the verdict is exactly
 * what it was before. That is deliberately the third option, against the two
 * #1204 tabulated: skipping silently is Silent Default Substitution, and
 * refusing an absent list would redden consumers for a reason about our
 * release rather than about their code. The generated step runs
 * `bunx rungate@<generating version>`, so a consumer's workflow and its
 * adjudicator always come from the SAME release and cannot skew apart; the
 * absent state is reachable from a hand-run CLI and from a workflow older
 * than the half that supplies the list.
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
  // `BLOCKING_FINDING_UNLOCATABLE` was here and is gone with the merge of
  // #1204 into CRC-B7. Nothing produces it: a blocking finding naming a file
  // outside the diff is DEMOTED to `Pre-existing` and the run stays readable,
  // rather than refusing the whole reading. A member nothing emits is a state
  // no test can reach, and `not.toContain` against it passes vacuously for
  // ever — which is how a deleted check goes on looking guarded.
  | "ARGUMENTS_UNREADABLE"
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
  | "CHANGED_FILES_UNREADABLE";

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

// `AI_REVIEW_CHANGED_FILES_FLAG` lived here and is gone. #1204 argued for a
// FLAG over a second positional, citing #675: `--project-root <cwd>` "would
// arrive as a second positional and be read as a second payload".
//
// That hazard was CHECKED before the constant was removed, not waved away.
// `bin/rungate.ts` appends `--project-root` only when a command declares
// `projectRootFlag`, and `ai-review-findings` declares none — which is the
// very fact #1204 cited. So nothing injects a stray positional into THIS
// command, and the argument does not reach it.
//
// The positional wins because the deployed workflow passes one and #1356
// builds on that. Two spellings for one argument would be two deciders, and
// the spelling the generated step does not use is the one that would rot.

/**
 * The prefix of the line recording how the scope reading was taken.
 *
 * Distinct from `AI_REVIEW_OUTCOME_LINE`, which the generated step lifts its
 * verdict out of by parameter expansion on the FIRST occurrence of that
 * marker. This line is printed after it and contains neither that marker nor
 * a newline, so nothing about the verdict extraction moves.
 */
export const AI_REVIEW_SCOPE_LINE = "ai-review findings scope:";

/** Whether the pull request's changed-file list was read, and if not, why. */
export type AiReviewScopeStatus = "MEASURED" | "NOT_SUPPLIED" | "UNMEASURED";

/**
 * The changed-file reading. One discriminator, `status`, and the producing
 * code's own sentence beside it.
 *
 * `NOT_SUPPLIED` and `UNMEASURED` are different facts with different fixes.
 * Nobody handed this run a list is a property of the workflow that invoked
 * it; a list that could not be read is a property of this run. Collapsing
 * them would make a release in which the input does not exist yet look like
 * a `git diff` that failed.
 */
export type AiReviewScopeReading =
  | { status: "NOT_SUPPLIED"; files: null; detail: string; reason: null }
  | { status: "MEASURED"; files: string[]; detail: string; reason: null }
  | {
      status: "UNMEASURED";
      files: null;
      detail: string;
      reason: Extract<
        AiReviewUnmeasuredReason,
        "CHANGED_FILES_UNREADABLE" | "CHANGED_FILES_EMPTY"
      >;
    };

/** The reading for a run nobody handed a changed-file list. */
export function scopeNotSupplied(): AiReviewScopeReading {
  return {
    status: "NOT_SUPPLIED",
    files: null,
    reason: null,
    detail:
      `no changed-file list was given (second positional argument), so whether ` +
      `a blocking finding names a file this pull request touches was not checked. ` +
      `This is a reading, not a pass: the generated job does not supply the list yet`,
  };
}

/**
 * The reading for a run whose changed-file list was supplied directly rather
 * than read from disk.
 *
 * Exists so a caller holding an array does not have to spell the discriminated
 * union by hand. `files` is carried raw; `readPayload` normalises.
 *
 * An EMPTY array is still MEASURED here and is refused downstream, on purpose:
 * "a list was supplied and it was empty" is a fact this type can represent and
 * `readAiReviewChangedFiles` cannot produce, so the refusal lives where every
 * caller passes through rather than only on the disk path.
 */
export function scopeMeasured(files: readonly string[]): AiReviewScopeReading {
  return {
    status: "MEASURED",
    files: [...files],
    reason: null,
    detail: `${files.length} changed path(s) supplied directly`,
  };
}

/**
 * Read the changed-file list from disk. Three states, each its own fact.
 *
 * A list that could not be read REFUSES and must never produce an empty list:
 * an empty changed set makes every blocking finding unlocatable, which is the
 * loud direction and loud for the wrong reason — it reads as the reviewer
 * having hallucinated every finding it wrote.
 *
 * A list that WAS read and names no paths refuses too, under its own reason.
 * A pull request that changes nothing is not a state this input can honestly
 * be in, so an empty file is a diff that was lost rather than a diff that was
 * empty — and the two reasons are kept apart because the fixes differ.
 *
 * The list must be taken from the RESTORED tree, before the reviewer could
 * have written to the checkout. That is why this function is handed a path
 * and never takes the diff itself: this module runs after the review, from
 * the payload's own directory, so a diff computed here is one the subject of
 * the review had an opportunity to edit.
 */
export function readAiReviewChangedFiles(path: string | undefined): AiReviewScopeReading {
  if (path === undefined || path === "") return scopeNotSupplied();

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    return {
      status: "UNMEASURED",
      files: null,
      reason: "CHANGED_FILES_UNREADABLE",
      detail:
        `the changed-file list at ${path} could not be read: ${(e as Error).message}. ` +
        `A diff that could not be taken is not a pull request that touches nothing`,
    };
  }

  // Entries are carried RAW, trimmed only. This function decides whether the
  // list is a reading; `readPayload` decides what each path means, through
  // `normaliseRepoPath`. Normalising here too would be two normalisers over
  // one input — and the weaker one would win silently, because it runs first.
  // `normaliseRepoPath` collapses dot segments, strips a `:line` suffix and
  // refuses git's C-quoted form; stripping `./` is the only thing the reader
  // that used to live here could do.
  const files = raw.split("\n").map(l => l.trim()).filter(p => p.length > 0);
  if (files.length === 0) {
    return {
      status: "UNMEASURED",
      files: null,
      reason: "CHANGED_FILES_EMPTY",
      detail:
        `the changed-file list at ${path} names no paths at all. A pull request that ` +
        `changes nothing is not a state this input can be in, so the diff was taken and ` +
        `lost rather than taken and empty — and reading it as empty would report every ` +
        `blocking finding as naming a file outside the pull request`,
    };
  }

  return {
    status: "MEASURED",
    files,
    reason: null,
    detail: `${files.length} changed path(s) read from ${path}`,
  };
}

// `unlocatableBlockingFinding` lived here and is gone. It was #1204's
// refusal predicate, and the merge with CRC-B7 retired the refusal; the
// comparison it performed now happens inside `readPayload` against
// `normaliseRepoPath`, which is the stronger reader. Deleted rather than
// left exported with no caller — `lib/ai-review-rounds.ts` (CRC-N4) and
// `lib/finding-jury.ts` (CRC-B4) are both open issues about exactly that,
// and adding a third would be the cheapest way to pretend this merge kept
// more than it did.

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
  /** How the pull request's changed-file list was read, and whether it was. */
  scope: AiReviewScopeReading;
  /**
   * Blocking findings naming a file the pull request does not touch — CARRIED,
   * never dropped, and `null` when the scope check did not run.
   *
   * `null` rather than `[]` for the did-not-run case on purpose: an empty list
   * and a check nobody performed are the states this module exists to keep
   * apart. `scope.status` is the discriminator; this is a projection of it.
   */
  unlocatableReported: unknown[] | null;
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
    scope: scopeNotSupplied(),
    unlocatableReported: null,
  };
}

/**
 * The ONE place a scope reading meets a payload reading.
 *
 * Every reading is built carrying the NOT_SUPPLIED default and passes through
 * here. A second site that set `scope`, or that raised a reading on a refused
 * scope, would be a second statement about the same input and the two could
 * disagree.
 *
 * A scope reading that REFUSES raises the whole reading, carrying the
 * payload's own reasons and findings with it rather than replacing them:
 * "the diff could not be taken" and "the payload is not JSON" are both true
 * of such a run, and a reader fixing one needs to see the other.
 */
function withScope(
  reading: AiReviewFindingsReading,
  scope: AiReviewScopeReading,
  unlocatableReported: unknown[] | null,
): AiReviewFindingsReading {
  const merged =
    scope.status === "UNMEASURED"
      ? unmeasured(
          [...reading.unmeasuredReasons, scope.reason],
          [...reading.detail, scope.detail],
          reading.reported,
        )
      : reading;
  return { ...merged, scope, unlocatableReported };
}

/**
 * Read a findings payload and decide what it means.
 *
 * `raw` is `null` for "there was no payload at all", which is a reading and
 * not an error: a job whose reviewer never wrote anything has not passed a
 * review, it has not had one.
 *
 * `scope` is the pull request's changed-file reading, and what this function
 * DOES with it is CRC-B7 (CODE-REVIEW-CONVERGENCE-SPEC): a finding naming no
 * file this pull request touched is tagged `Pre-existing` and does not block,
 * so a bug that was already on `main` does not read as the change's fault.
 * `ai-review` reads the MERGE REF, so without this every defect on `main` is
 * reported against whichever pull request is standing closest — nine of them
 * at once on 2026-10-23.
 *
 * ## #1204 and CRC-B7 answered the same question and this merge picked one
 *
 * Both asked *does this finding apply to this pull request?* over the same
 * input. #1204 refused — `BLOCKING_FINDING_UNLOCATABLE`, a red required
 * check. CRC-B7 demotes. **CRC-B7 owns the case**, because #1204's answer
 * makes its own motivating measurement worse: under it each of those nine
 * findings becomes a REFUSING required check, so every pull request standing
 * near a defect on `main` is unmergeable until somebody fixes `main`. That is
 * worse than the state it was fixing. CRC-B7 also grades the error direction,
 * which the refusal does not: an undecidable path keeps blocking, and a
 * non-string path is a contract violation rather than a demotion input.
 *
 * What #1204 keeps is the INPUT layer — `scope`, three states as a type
 * rather than as conventions over a nullable array. It is the only side that
 * can tell "nobody handed this run a list" from "every finding was
 * locatable", and those are the two readings a green check must not conflate.
 * It defaults to NOT_SUPPLIED, under which nothing is demoted and the reading
 * is exactly what it was before any of this existed.
 *
 * The finding's DECLARED `file` is the input, not a path mined out of its
 * prose. `blockingContractViolations` already refuses a blocking finding that
 * carries none, and `lib/finding-jury.ts`'s `citedPaths` text-mines only
 * because the arbiter's findings arrive as prose. Mining a field the payload
 * declares would be a second decider for a question already answered.
 */
export function readAiReviewFindings(
  raw: string | null,
  scope: AiReviewScopeReading = scopeNotSupplied(),
): AiReviewFindingsReading {
  const preExisting: unknown[] = [];
  const base = readPayload(
    raw,
    scope.status === "MEASURED" ? scope.files : undefined,
    preExisting,
  );
  return withScope(base, scope, scope.status === "MEASURED" ? preExisting : null);
}

/**
 * The payload pass itself. `preExisting` is appended to rather than returned,
 * because the findings it collects belong to the reading its caller composes
 * and every early return here is a state in which none were collected.
 *
 * It holds the findings CRC-B7 demoted. A COUNT would not do: "three were
 * demoted" and "these three were demoted" differ exactly when somebody wants
 * to know whether the demotion was right, which is the only question anybody
 * asks of a demotion.
 */
function readPayload(
  raw: string | null,
  changedFiles: readonly string[] | undefined,
  preExisting: unknown[],
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
  /** How many findings CRC-B7 demoted. See the `agreed` computation below. */
  let demoted = 0;

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
          // #1204's half that survived the merge: WHICH findings were
          // demoted, not just how many. The scope line reports it, so a
          // reader can ask whether a demotion was right — the only question
          // anybody asks of one.
          preExisting.push(item);
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
      // CRC-B4's verifier quorum does NOT appear here, and its absence is
      // the decision rather than an omission.
      //
      // A quorum that subtracts from this list is a gate whose input is the
      // thing it gates: the verifier reads the cited file at the HEAD
      // checkout, so code that argues itself clean would be voting on the
      // finding about itself. And the group that would cast those votes is
      // not independent — `AI_REVIEW_ALLOWED_TOOLS` grants
      // `Read,Grep,Glob,Write` and `AI_REVIEW_DENY_RULES` denies `Task`, so
      // a verifier step cannot spawn anything and N votes from one
      // invocation are one opinion written down N times.
      //
      // Until both are fixed — structural independence, and a base-ref read
      // — the ballot is RECORDED and never acted on. `main` runs the gate
      // for the ledger and the annotation; this list is untouched by it.
      // See `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` under CRC-B4.
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
  // The agreement is measured BEFORE CRC-B7's demotion, not after it.
  //
  // The reviewer is not given the pull request's file list, so it cannot know
  // a finding is pre-existing and its `BLOCK` over one is honest. Comparing
  // its word against the post-demotion count would turn every successful
  // demotion into a CONTRADICTION — the arm would fire on the mechanism
  // working, which is the loudest possible way to be wrong.
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
    scope: scopeNotSupplied(),
    unlocatableReported: null,
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

// `readChangedFiles` lived here and is gone. It returned `null` for BOTH an
// unreadable file and — via its caller — an empty one, and `main` reported
// that single `null` as `CHANGED_FILES_EMPTY`. A failed `git diff` writes no
// file at all, so that collapsed "the diff was lost" into "the diff was
// empty", which are different facts with different repairs.
// `readAiReviewChangedFiles` replaces it and keeps them apart.

/** Read the payload from disk. An absent file and an unreadable one differ. */
export function readAiReviewFindingsFile(
  path: string,
  scope: AiReviewScopeReading = scopeNotSupplied(),
): AiReviewFindingsReading {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return withScope(
        unmeasured(["FINDINGS_FILE_ABSENT"], [`no findings payload at ${path}`]),
        scope,
        null,
      );
    }
    return withScope(
      unmeasured(
        ["FINDINGS_FILE_UNREADABLE"],
        [`the findings payload at ${path} could not be read: ${(e as Error).message}`],
      ),
      scope,
      null,
    );
  }
  return readAiReviewFindings(raw, scope);
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
 * The title the quorum's UNMEASURED state is named under.
 *
 * A SEPARATE title, because it is a different fact with a different fix: a
 * group that met and disagreed is a reading, and a group that did not meet
 * is not one. GitHub groups annotations by title, so one title for both
 * would make the absence read as part of the vote.
 */
export const AI_REVIEW_JURY_UNMEASURED_TITLE = "AI review verifier quorum UNMEASURED";

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
 * **The gate decides nothing.** It is consulted after the reading is
 * complete, its answer reaches an annotation and the finding ledger, and
 * `reading` is not rebuilt from it. So a gate that is absent, broken or
 * wired wrong cannot change a verdict in either direction — which is the
 * only honest arrangement while the group that casts the votes is not yet
 * structurally independent. See `AI_REVIEW_JURY_NOTICE_TITLE`.
 *
 * **It takes the findings and nothing else.** The ballot directory is
 * bound by whoever supplies the gate, so this module never learns a path
 * and the CLI's argv contract — two positionals, `argv[2]` and up refused
 * — is untouched. A gate that is `null` is the whole of "no ballot".
 */
export interface AiReviewJuryGate {
  (blocking: readonly unknown[]): {
    /**
     * One entry per blocking finding, **in input order** — the sentence
     * saying the group would have withheld it, or `null`.
     *
     * Positional rather than keyed, and that is the contract rather than a
     * convenience. A map from a finding identity would be a SECOND
     * derivation of that identity over a list already produced in order,
     * and two findings sharing a key would share a vote.
     * `lib/finding-arbiter.ts`'s `SHARED_BALLOT` refuses exactly that one
     * level down — *"a vote is about a finding"*.
     *
     * **"Would have".** Nothing here subtracts: the entry is recorded and
     * announced, and the finding blocks exactly as it did before the group
     * met.
     */
    wouldWithhold: readonly (string | null)[];
    /** Non-null when the ballot source could not be read. Never fatal. */
    unmeasured: string | null;
    /** One sentence per finding voted on. */
    detail: readonly string[];
  };
}

/**
 * The line recording how the scope reading was taken, and the two counts a
 * reader needs to see differ when the gate fires (#1204).
 *
 * The number of findings PRODUCED and the number ALLOWED TO BLOCK are both
 * printed, because a review that quietly demoted a finding and a review that
 * never had one are otherwise the same output. The blocking count is
 * `withheld` under an UNMEASURED reading rather than `0` — the decision is
 * withheld there, and printing a number would be inventing one.
 */
export function aiReviewScopeLine(reading: AiReviewFindingsReading): string {
  const produced = reading.reported?.length ?? 0;
  const blocking =
    reading.blockingReported === null ? "withheld" : String(reading.blockingReported.length);
  const unlocatable =
    reading.unlocatableReported === null ? "not checked" : String(reading.unlocatableReported.length);
  return (
    `${AI_REVIEW_SCOPE_LINE} ${reading.scope.status} — findings reported: ${produced}, ` +
    `allowed to block: ${blocking}, unlocatable: ${unlocatable}. ${reading.scope.detail}`
  );
}

// `parseFindingsArgv` and `AiReviewFindingsArgv` lived here and are gone.
// The parser refused a SECOND POSITIONAL argument by design, which is
// exactly the invocation CRC-B7 deploys, so the flag CLI and the
// positional one could not both stand. See `main` below.
//
// What the parser ALSO did is kept, in `argumentsBeyondTheContract`: it
// refused an argument nothing reads, rather than dropping it. Deleting the
// parser silently took that with it — measured, not assumed, on the merged
// tree: `main([payload, list, "extra"])` returned 0 and printed CLEAN. A
// dropped argument is a caller asking for something that did not happen,
// which is the same fault as a skipped check wearing different clothes.

/**
 * The arguments past the two this CLI reads. One exported binding, so the
 * refusal has a single site to mutate (`checks-must-be-able-to-fail.md`).
 *
 * It returns the arguments rather than a boolean because the refusal names
 * them: "an argument was ignored" is not something an operator can act on,
 * and the failing invocation is usually a workflow line nobody can see from
 * the log.
 */
export function argumentsBeyondTheContract(argv: readonly string[]): string[] {
  return argv.slice(2);
}

/**
 * The CLI the generated workflow step runs: the payload's path, and
 * optionally a second POSITIONAL path to the pull request's changed files.
 *
 * Positional, not a `--changed-files` flag. #1204 wrote the flag and CRC-B7
 * wrote the positional; the generated step passes positionally and #1356
 * builds on that, so the flag is the spelling that goes. Two spellings for
 * one argument would be two deciders over the same input, and the one the
 * deployed workflow does not use is the one that would rot.
 *
 * The second argument is optional: a caller that does not pass one gets
 * exactly the reading this module gave before any of this was wired, which
 * is what keeps every existing consumer working unchanged.
 *
 * An unreadable list is NOT silently treated as absent, and `readAiReview-
 * ChangedFiles` is what keeps those apart — `CHANGED_FILES_UNREADABLE` for a
 * list that was named and could not be read, `CHANGED_FILES_EMPTY` for one
 * that was read and names nothing. A failed `git diff` writes no file at
 * all, so collapsing the two would report a diff that was lost as a diff
 * that was taken.
 *
 * An argument past those two REFUSES. Nothing reads it, and a CLI that
 * accepts an argument it ignores reports success for an invocation that did
 * not happen.
 *
 * Separate from `main` so the argv contract is decided in one place and
 * `main` is only the printing. A refusal reached here still prints the
 * outcome line and the scope line, because the generated step reads the
 * outcome line before it reads the exit code.
 */
function readArgv(argv: string[]): AiReviewFindingsReading {
  const extra = argumentsBeyondTheContract(argv);
  if (extra.length > 0) {
    // Scope is NOT read here. The argv is already known to be a shape this
    // CLI does not accept, so which file argv[1] names is a question about
    // an invocation that is being refused.
    return withScope(
      unmeasured(
        ["ARGUMENTS_UNREADABLE"],
        [
          `${extra.length} argument(s) past the findings payload and the changed-file ` +
            `list were given and nothing reads them: ${extra.map(a => JSON.stringify(a)).join(", ")}. ` +
            `Usage: <path-to-findings.json> [<path-to-changed-files.txt>]`,
        ],
      ),
      scopeNotSupplied(),
      null,
    );
  }

  const path = argv[0];
  const scope = readAiReviewChangedFiles(argv[1]);
  return path === undefined || path === ""
    ? withScope(
        unmeasured(
          ["FINDINGS_FILE_ABSENT"],
          ["no findings payload path was given to the findings reader"],
        ),
        scope,
        null,
      )
    : readAiReviewFindingsFile(path, scope);
}

/**
 * The CLI entry point. `readArgv` above decides what the arguments mean;
 * everything here is emission.
 *
 * Returns the exit code rather than calling `process.exit`, so a test can run
 * it in-process as well as spawn it.
 */
export function main(argv: string[], jury: AiReviewJuryGate | null = null): number {
  const reading = readArgv(argv);

  // CRC-B4, AFTER the reading and feeding nothing back into it.
  //
  // The group votes on `blockingReported` — the existing decider's own
  // answer to "which of these block", never a list re-derived from the
  // severities, which is the criterion's first clause: a quorum over the
  // advisory tail spends a full agent context per nit.
  //
  // WHAT IT DOES NOT DO IS SUBTRACT, and that is a decision with two
  // reasons, both of them properties of the tree rather than of this
  // function:
  //
  //  - **The group is not independent yet.** `AI_REVIEW_ALLOWED_TOOLS`
  //    grants the review action `Read,Grep,Glob,Write` and
  //    `AI_REVIEW_DENY_RULES` denies `Task`, so one invocation cannot spawn
  //    verifiers. Independence has to be a property of the WORKFLOW — one
  //    action invocation per verifier — and a ballot that subtracts before
  //    that holds is a quorum wired to a constant: populated, plausible,
  //    and filtering nothing. That is the counterfeit CRC-B4 names.
  //  - **The verifier reads the head checkout.** A subtracting ballot would
  //    make the branch under review an input to the gate on the branch
  //    under review.
  //
  // So the votes are counted, written to the finding ledger at decision
  // time, and announced. Nothing below reads `gate` except the annotation.
  // CRC-B4's *"surfaced only if enough agree"* clause is therefore NOT
  // satisfied, and the spec says so rather than this comment alone.
  //
  // **The ballot directory is NOT a third positional argument**, and that
  // is deliberate rather than incidental. `argumentsBeyondTheContract`
  // refuses `argv[2]` and up, and one of the invocations it catches is a
  // changed-file path containing a space that an unquoted expansion
  // word-split into two — `test/ai-review-changed-files-step.test.ts`
  // CF-6 names that case. Widening the contract by one slot to carry a
  // ballot would turn that refusal into an accepted argv whose second
  // half is read as a ballot directory. So the directory binds at the
  // wrapper, which closes over it and hands this function a gate or
  // `null`; "no ballot" and "a ballot nothing reads" collapse into one
  // state that cannot be reached.
  let juryDetail: readonly string[] = [];
  let juryUnmeasured: string | null = null;
  if (jury !== null && reading.blockingReported !== null && reading.blockingReported.length > 0) {
    const gate = jury(reading.blockingReported);
    juryDetail = gate.detail;
    juryUnmeasured = gate.unmeasured;
  }

  // FIRST, and before any branch below can return. The generated workflow step
  // greps its own output for this prefix and will not read the exit code as a
  // verdict without it (#1013) — an adjudicator that could not run and one that
  // refused both exit non-zero, and only this line tells them apart.
  console.log(`${AI_REVIEW_OUTCOME_LINE} ${reading.outcome}`);

  // AFTER the outcome line, and never instead of it. The generated step lifts
  // its verdict from the FIRST occurrence of that marker, so this line cannot
  // move it. Printed on EVERY run, including the one where no list was
  // supplied: an absent input that nothing reports is Silent Default
  // Substitution, and this line is the whole of what makes the skip a
  // reading. Escaped at emission like the annotation below — a path arriving
  // on the command line reaches a stream GitHub parses workflow commands out
  // of, and this module escapes exactly once, at the point of emission.
  console.log(escapeAnnotation(aiReviewScopeLine(reading)));

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
  // outcome was. The ledger row is the durable record and it lives on the
  // runner, which dies with the job; this annotation is the only part of
  // the vote that outlives the run, so it carries the whole reading rather
  // than a count.
  //
  // A `::notice`, never an `::error`. The ballot decides nothing this round
  // and an annotation that reddened a check would be a gate arriving by the
  // back door — see the block above `juryDetail`.
  if (juryDetail.length > 0) {
    console.log(
      `::notice title=${AI_REVIEW_JURY_NOTICE_TITLE}::${escapeAnnotation(
        `A separate verifier group voted on the ${juryDetail.length} finding(s) that would ` +
          `otherwise block. ${juryDetail.join("; ")}. THE VOTE IS RECORDED AND CHANGES ` +
          `NOTHING: every finding above blocks exactly as it would have without it. The ` +
          `group is not yet structurally independent and reads the head checkout, so acting ` +
          `on it would be a gate whose input is the thing it gates.`,
      )}`,
    );
  }

  // A `::warning`, and the state is NAMED. An absent or unreadable ballot
  // exiting 0 with no output is the Silent Default Substitution
  // `.claude/rules/config-access.md` forbids: `0`, `{}` and `null` are
  // indistinguishable from success and UNMEASURED is not. It does not
  // refuse, because the consumer decides whether an unmeasured quorum is
  // fatal and the honest default for a mechanism with no readings yet is an
  // annotation rather than a red pipeline.
  if (juryUnmeasured !== null) {
    console.log(
      `::warning title=${AI_REVIEW_JURY_UNMEASURED_TITLE}::${escapeAnnotation(
        `The verifier quorum is UNMEASURED for this run: ${juryUnmeasured}. No finding's ` +
          `status changed either way.`,
      )}`,
    );
  }

  return aiReviewExitCode(reading);
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
