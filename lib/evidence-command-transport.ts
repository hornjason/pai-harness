/**
 * Moving an agent-authored evidence command from discovery to the state file,
 * and recording every legitimate change made to one on the way (#614).
 *
 * ## The defect this module exists for
 *
 * `workflows/ship.js` persisted discovery's ACs by interpolating
 * `JSON.stringify(discovery.acs…)` into a DOUBLE-QUOTED `bun -e "…"` shell
 * string in the setup agent's prompt. Inside double quotes a shell expands
 * `$1` to the empty string, `${VAR}` to the environment, and `$(cmd)` by
 * RUNNING it. On run `wf_c92dd0a7-fe6` the command
 *
 *     grep -rhcE '^export function localCalendarDay' lib | awk '{s+=$1} END {print s+0}'
 *
 * arrived in `workflow-state.json` as `awk '{s+=} END {print s+0}'` — an awk
 * syntax error. The AC could never produce evidence, stayed PENDING, and took
 * the verify gate down with four failures. The blast radius was every evidence
 * command containing a `$`.
 *
 * The fix is to stop putting agent-authored text where a shell looks. The
 * payload leaves the generator as a SINGLE-QUOTED argument — the one shell
 * construct with no expansion inside it at all — and the `bun -e` program
 * reads it out of `process.argv` instead of carrying it as program text.
 *
 * ## Why the provenance half is in the same module
 *
 * Three places legitimately rewrite an evidence command: discovery's path
 * normaliser, discovery's evidence-type-ratio upgrade, and the git-ref
 * qualification at the execution boundary (#118). Each used to overwrite
 * `evidenceMethod.command` in place, so a reader of a broken command could not
 * tell a repair from a corruption — which is exactly the question #614 took a
 * run and a post-mortem to answer. `recordEvidenceRewrite` is the single site
 * that changes a command, and it keeps the FIRST authored form.
 *
 * It belongs here because it is the same claim from the other side: the first
 * half says nothing may change the command by accident, the second says
 * everything that changes it on purpose must say so.
 *
 * `workflows/ship.js` cannot import (#69). It carries an inlined copy inside
 * the `AC-PAYLOAD-TRANSPORT` markers, and `test/evidence-command-roundtrip.test.ts`
 * runs both over one matrix so drift is red.
 */
import { shellSingleQuote } from "./phase2-decomposition";

/**
 * Where the payload arrives inside the `bun -e` program.
 *
 * `bun -e '<program>' a b` gives the program `process.argv[1] === "a"`.
 */
export const AC_PAYLOAD_ARGV_INDEX = 1;

/** One recorded change to an evidence command. */
export interface EvidenceRewrite {
  /** The site that made the change, named so a reader can go and read it. */
  by: string;
  /** The command as it stood before this change. */
  from: string;
  /** The command as it stands after it. */
  to: string;
}

/** The AC fields the setup step persists into workflow-state.json. */
export interface AcPayloadRecord {
  id: unknown;
  type: unknown;
  statement: unknown;
  threshold: unknown;
  evidenceMethod: unknown;
  specElement: unknown;
  coversCriteria: unknown[];
  contextFiles: unknown[];
}

/**
 * Project discovery's ACs onto the fields `writeACs` persists.
 *
 * Kept as a function rather than inlined at the two call sites because the
 * two used to be two copies of the same object literal, and a field added to
 * one of them would have been silently missing from the fix-acs fallback.
 */
export function acPayloadRecords(acs: unknown): AcPayloadRecord[] {
  return (Array.isArray(acs) ? acs : []).map((ac: any) => ({
    id: ac.id,
    type: ac.type,
    statement: ac.statement,
    threshold: ac.threshold,
    evidenceMethod: ac.evidenceMethod,
    specElement: ac.specElement,
    coversCriteria: ac.coversCriteria || [],
    contextFiles: ac.contextFiles || [],
  }));
}

/** The payload exactly as it will be written to disk. */
export function acPayloadJson(acs: unknown): string {
  return JSON.stringify(acPayloadRecords(acs));
}

/**
 * The payload as a shell WORD, to sit after the closing quote of the
 * `bun -e "…"` program.
 *
 * Single quotes are the one shell construct with no expansion inside them at
 * all, so this is the only position in the command where agent-authored text
 * is safe. `shellSingleQuote` closes, escapes and reopens on an apostrophe,
 * which is the single character the construct cannot carry verbatim — and
 * evidence commands are full of apostrophes, because that is how an awk or
 * grep expression is quoted.
 *
 * ## Why an argument and not a file
 *
 * The obvious alternative — write the payload to `${WORK_DIR}/…json` and have
 * the `bun -e` read it — was built first and does not work, for a reason
 * worth recording rather than rediscovering. `initWorkflow` calls `beginRun`,
 * whose whole job (#288) is to sweep the work directory into
 * `previous-run-<id>/` so a dead run's artefacts cannot be read as this
 * run's. A payload written before `initWorkflow` is archived by it, and the
 * read that follows is an ENOENT; a payload written after it needs a third
 * command in the agent's prompt. The argument has neither problem: one
 * process, no new file in a swept directory, and no ordering to get wrong.
 */
export function acPayloadShellArgument(acs: unknown): string {
  return shellSingleQuote(acPayloadJson(acs));
}

/**
 * The JavaScript expression that reads the payload back, for embedding in the
 * `bun -e` program that calls `writeACs`.
 *
 * It contains no agent-authored text and no `$`, so it is safe inside the
 * double-quoted shell string the setup step still is.
 */
export function acPayloadReadExpression(): string {
  return `JSON.parse(process.argv[${AC_PAYLOAD_ARGV_INDEX}])`;
}

/**
 * Change an evidence command, on the record.
 *
 * Returns true when the command actually changed. A no-op records nothing: a
 * recorder that logged every call would leave `rewrites` non-empty on every
 * AC and the field would stop meaning "this command was changed".
 *
 * `authoredCommand` is written once and never overwritten. A field holding
 * "whatever it was one rewrite ago" cannot answer the question #614 asks,
 * which is what the agent wrote.
 */
export function recordEvidenceRewrite(
  evidenceMethod: { command?: string; authoredCommand?: string; rewrites?: EvidenceRewrite[] } | undefined | null,
  by: string,
  next: string,
): boolean {
  if (!evidenceMethod || typeof evidenceMethod.command !== "string") return false;
  const from = evidenceMethod.command;
  if (from === next) return false;
  if (evidenceMethod.authoredCommand === undefined) evidenceMethod.authoredCommand = from;
  evidenceMethod.command = next;
  evidenceMethod.rewrites = [...(evidenceMethod.rewrites || []), { by, from, to: next }];
  return true;
}
