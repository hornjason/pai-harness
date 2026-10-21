/**
 * Evidence that a hook fired, and what it decided (#910).
 *
 * ## Why this exists
 *
 * #910's registration claim was wrong and was corrected by parsing the
 * settings. Its execution claim could not be corrected, because there was
 * nothing to correct it against: neither `TestSuiteRelease.hook.ts` nor
 * `ProjectStateSync.hook.ts` wrote anything anywhere, so no search could ask
 * whether either had ever run.
 *
 * That is `.claude/rules/checks-must-be-able-to-fail.md`'s #646 shape with the
 * store removed entirely. The rule there is *"before believing an empty search
 * over a store you did not write, name a string that must be PRESENT if the
 * store has anything in it at all"*. For these two hooks there was no such
 * string, and so no reading of their execution was available to anyone —
 * including whoever picks up the issue next.
 *
 * ## The distinction a record has to preserve
 *
 * A hook that fired and deliberately declined, and a hook that never fired,
 * are the same observation when nothing is written. They have different fixes,
 * so they must look different:
 *
 * | outcome | means |
 * |---|---|
 * | no record at all | the call was out of the hook's population, or the hook did not run |
 * | `declined-*` | it ran, reached the decision, and chose not to act |
 * | the acting outcome | it ran and did the thing |
 *
 * **Only in-population calls are recorded.** Both hooks are attached to tool
 * events that fire on every Bash call and every Write and Edit in every
 * session, so recording every invocation would produce a file nobody can read
 * — and the question is about full-suite commands and `project-state.json`
 * writes, not about every tool call. The hook headers say which population
 * each one records.
 *
 * ## Never throw
 *
 * A `PostToolUse` hook that throws fails the tool call it is attached to. So
 * `appendEvidence` returns `false` rather than raising — and returns it rather
 * than swallowing it, because a write that did not happen is not a write that
 * happened, and a caller that wants to know can ask.
 */

import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export const HOOK_EVIDENCE_FILE = "hook-firings.jsonl";

export interface HookFiring {
  /** ISO-8601, so a record can be compared against a run. */
  at: string;
  hook: string;
  /** What the hook decided. `declined-*` for a deliberate no-op. */
  outcome: string;
  detail?: Record<string, unknown>;
}

/**
 * Where the evidence lives, from an environment and a home directory.
 *
 * Both are parameters rather than reads of `process.env` and `homedir()`, so
 * a case can drive this without touching the machine's real work directory.
 * `RUNGATE_WORK_DIR` is the same override every other hook in this tree
 * honours (`hooks/StaleTTLCleanup.hook.ts`, `hooks/lib/paths.ts`).
 */
export function hookEvidencePath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return join(env.RUNGATE_WORK_DIR || join(home, ".rungate"), HOOK_EVIDENCE_FILE);
}

/**
 * One record, rendered.
 *
 * Pure, and the single place the on-disk shape is decided, so a case can
 * assert the shape without a filesystem and the writer cannot disagree with
 * the reader about it.
 */
export function firingLine(
  hook: string,
  outcome: string,
  detail: Record<string, unknown>,
  at: Date,
): string {
  const record: HookFiring = { at: at.toISOString(), hook, outcome };
  if (Object.keys(detail).length > 0) record.detail = detail;
  // JSONL: the trailing newline terminates THIS record. Without it a crash
  // mid-append leaves two records concatenated into one unparseable line, and
  // the reader below would refuse the whole file over it.
  return `${JSON.stringify(record)}\n`;
}

/**
 * Read records back.
 *
 * A line that does not parse is DROPPED rather than throwing, and this is the
 * one place in this tree where that is the right call: the file is appended to
 * concurrently by hooks in unrelated sessions, so a torn final line is an
 * expected state of a log and not a corrupt config. The distinction
 * `.claude/rules/config-access.md` protects is about a document whose absence
 * and whose corruption mean different things; here both mean "no record", and
 * a reader that threw would make the evidence unreadable exactly when it is
 * most wanted.
 */
export function parseFirings(text: string): HookFiring[] {
  const out: HookFiring[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as HookFiring);
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Append one rendered line, creating the directory.
 *
 * Returns `false` on any failure and NEVER throws — see the module docblock.
 */
export function appendEvidence(path: string, line: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line);
    return true;
  } catch {
    return false;
  }
}

/**
 * The one call a hook makes.
 *
 * One binding, so there is one thing to mutate and one site to grep for when
 * asking which hooks are observable at all.
 */
export function recordHookFiring(
  hook: string,
  outcome: string,
  detail: Record<string, unknown> = {},
): boolean {
  return appendEvidence(hookEvidencePath(), firingLine(hook, outcome, detail, new Date()));
}
