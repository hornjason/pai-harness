/**
 * Which instruction an agent worked from (#180).
 *
 * A ship run launched in the same turn as an unrelated user message gives
 * every agent that message as its task, outranking the brief. The Workflow
 * runtime prepends it — rungate does not write it and cannot remove it:
 *
 * > `[user request]` The harness relays, verbatim and indented below, the user
 * > request that triggered this workflow run. This relayed request is the only
 * > user voice in this task; …
 *
 * ## The run
 *
 * `wf_17267830-401` shipped #178. The relayed text was a status question typed
 * in the parent session — *"What do we still need to do to get the pipeline to
 * ship?"* — and Marcus returned:
 *
 * ```json
 * {"success": true, "filesChanged": [], "testOutput":
 *  "No tests run — the relayed user request was a status/priority question, not
 *   an implementation task, and the harness framing states the user request
 *   wins over the computed task."}
 * ```
 *
 * The agent was not confused. It followed the precedence the framing gave it,
 * and the framing was wrong for this run. `marcus-brief.md` for the same run
 * was correct and complete — 63 lines, five ACs, eight files, a canary. **The
 * brief lost to text it never saw.**
 *
 * ## What changes, and what deliberately does not
 *
 * The relay is NOT removed (#180 AC-3). It is useful when the triggering
 * message *is* about the run — "focus on the API half first" should still
 * reach the agent. Two things change:
 *
 *  - **Precedence.** Every briefed prompt now states that the brief's Task and
 *    Acceptance Criteria are authoritative and that a relayed request narrows
 *    or prioritises them but does not replace them.
 *  - **Reportability.** The implement reply carries `taskSource`, so a
 *    substitution is a value in the reply rather than a sentence in prose
 *    nobody parses. That is #166 applied to which instruction was obeyed:
 *    Marcus said what it did only because it chose to narrate it.
 *
 * The notice goes on every briefed role, not a list of implement roles. A
 * hardcoded role name in harness code is the thing `.claude/rules` keeps
 * filing issues about, and the claim is true of every computed brief anyway.
 */

/** What an agent may say it worked from. */
export const TASK_SOURCES = ["brief", "relayed-request", "both"] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

/**
 * The precedence paragraph appended to every briefed prompt.
 *
 * Written as one exported function so there is a single binding to mutate —
 * a second copy of this wording somewhere else would survive the mutation and
 * the test would go green for the wrong reason.
 */
export function briefPrecedenceNotice(briefPath: string): string {
  return (
    `TASK PRECEDENCE — the brief is the task. The Task and Acceptance Criteria in ` +
    `${briefPath} and in the prompt below are computed from the issue and are authoritative. ` +
    `A relayed user request from the session that launched this run does NOT replace them: ` +
    `it may narrow or prioritise the work, and if it is about something else entirely it is ` +
    `not your task and you should say so rather than doing it. Run wf_17267830-401 did the ` +
    `other thing — it answered a status question, changed no files and reported success.\n` +
    `Report which you worked from in \`taskSource\`: "brief", "relayed-request", or "both".\n\n`
  );
}

/** Minimal shape of an implement reply, as far as this check is concerned. */
export interface TaskSourceReading {
  taskSource?: unknown;
}

/**
 * Refuse a reply whose `taskSource` is missing or says the brief was replaced.
 *
 * **Absent is a refusal, not a pass** — the same decision `worktreeRepo` made
 * in #218 and for the same reason: a field the run accepts as missing is a
 * field that stops being written, and then the channel is gone without anyone
 * deciding to remove it.
 *
 * `"both"` passes. The relay narrowing a brief is the case #180 AC-3 keeps
 * working, and an agent that read both and says so is doing exactly what the
 * notice asks.
 */
export function taskSourceRefusal(result: TaskSourceReading | null | undefined, label: string): string | null {
  const value = result?.taskSource;
  if (value === undefined || value === null || value === "") {
    return (
      `${label} reported no taskSource, so which instruction it worked from is unknown. ` +
      `The schema requires it (#180): an implement reply that cannot say whether it followed ` +
      `the brief or a relayed message from the parent session is the state wf_17267830-401 ` +
      `shipped in, where the substitution was visible only because the agent narrated it.`
    );
  }
  if (typeof value !== "string" || !(TASK_SOURCES as readonly string[]).includes(value)) {
    return (
      `${label} reported taskSource ${JSON.stringify(value)}, which is not one of ` +
      `${TASK_SOURCES.join(", ")}. An unrecognised value is not a verdict.`
    );
  }
  if (value === "relayed-request") {
    return (
      `${label} worked from the relayed user request instead of its brief. The brief carries ` +
      `this issue's acceptance criteria, governing spec, file list and verify commands; the ` +
      `relayed text is whatever was typed in the session that launched the run and is not ` +
      `guaranteed to be about this issue at all (#180).`
    );
  }
  return null;
}
