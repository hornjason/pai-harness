/**
 * Gate result protection — the decision behind `GateResultProtection.hook.ts`.
 *
 * Deep module: the hook file is a thin trigger (SC-371) that parses stdin and
 * prints; every reading of the tool call happens here, so there is one site
 * to mutate and one site to test.
 *
 * Issue: #1137. Original hook: #471, migrated by #713.
 *
 * ## The property
 *
 * A gate verdict must not be writable by the thing being gated. The guard
 * therefore has to be at least as good at reading JSON as the readers of
 * `workflow-state.json` are, and the version this replaces was not.
 *
 * ## Three ways the first draft could be stepped around, and the shape of each fix
 *
 * **Spelling.** It enumerated two spacings of one key with `String.includes`,
 * so `"result"  :  "PASS"` walked past. Fixed by deciding on parsed structure
 * where there is one, and on a whitespace-tolerant, escape-decoded pattern
 * where there is not.
 *
 * **A list that could go stale.** It enumerated `scope`, `verify`, `ship`.
 * `gates/gate-executor.ts` also calls `writeGateResult` with `merge`, `gaps`
 * and (through its dynamic call) `prove`, so three persisted gate results
 * were unguarded. The fix is NOT a longer list — it is no list: a `result`
 * under ANY key of `gates` is refused. An allowlist on a security boundary is
 * correct until someone adds a gate, and nothing makes the next person update
 * it. Gate-agnostic cannot go stale, so "is the list complete?" stops being
 * askable. See `lib/gate-names.ts` for why the lists that remain are not this.
 *
 * **Erasure.** It asked "does the incoming content contain a result?", so a
 * bypass only had to make the answer no. A forged PASS was the attack it was
 * written against; DELETING a FAIL reaches the same end and was invisible to
 * any content-only reading. So the decision now also reads what is already at
 * `file_path` and refuses a write that drops a result that is there.
 *
 * ## Two inputs, two readings, and why they differ
 *
 * **`Write` hands us the whole file**, so it is parsed, and the decision is
 * taken on the parsed structure. That is strictly better than any pattern:
 * `JSON.parse` normalises whitespace, key order, and `\uXXXX` escapes, so
 * `{"phase": "DONE"}` arrives as `phase` with no decoder of our own.
 *
 * **`Edit` hands us a fragment** — `new_string` is spliced into the file, and
 * a fragment is usually not valid JSON — so there is nothing to parse and the
 * reading falls back to a pattern. Two consequences follow:
 *
 *  - The pattern tolerates whitespace, because JSON does.
 *  - `\uXXXX` IS decoded first, by hand. On the Write path the parser does
 *    this for us; here nothing does, and the escape is a live bypass rather
 *    than a curiosity: the Edit tool splices literally, so `"result"`
 *    lands in the file as those twelve characters and the next reader's
 *    `JSON.parse` turns it back into `result`. A guard that reads the text
 *    less carefully than the consumer does is not a guard.
 *
 * The decoder is deliberately naive — it does not track whether the
 * backslash was itself escaped, so the literal six characters `\\u0072` in a
 * JSON string are decoded too. That over-blocks a string nobody writes into
 * this file, and the direction is the correct one to be wrong in.
 *
 * ## Where UNMEASURED refuses, and the one place it does not
 *
 * A workflow state is always a JSON object. Content that does not parse, or
 * that parses to an array, a `null` or a scalar, is a reading the guard could
 * not take — and a reading that could not be taken is not one that passed.
 * Both refuse. The first draft allowed both, which is the same fail-open as
 * the `catch { // allow }` this issue was filed about, wearing two more hats.
 *
 * The exception is the PRIOR state read for the erasure check. If the file
 * already on disk is unreadable or unparseable, the erasure question is
 * UNMEASURED and the write is allowed to proceed on its own merits. Refusing
 * there would make one corrupt state file permanently unwritable by the only
 * tool that could repair it — a guard nobody can get out from under gets
 * switched off, and then it guards nothing. The forgery and non-object
 * refusals still apply to that same write, so the incoming content is never
 * unexamined; it is only the comparison that is skipped.
 */

import { existsSync, readFileSync } from 'fs';

export interface GateWriteDecision {
  blocked: boolean;
  reason?: string;
}

const ALLOW: GateWriteDecision = { blocked: false };

const GATE_RESULT_REASON =
  'Gate results must be produced by gate-runner.ts, not written directly.';
const DONE_PHASE_REASON =
  'Phase DONE must be set by gate-runner.ts after ship gate passes.';
const UNPARSEABLE_REASON =
  'Refused: the content of this write to workflow-state.json could not be parsed as JSON. ' +
  'Gate results are protected, and a guard cannot read a file it cannot parse — so an ' +
  'unparseable write to this path is refused rather than allowed. Write valid JSON.';
const NON_OBJECT_REASON =
  'Refused: this write to workflow-state.json parses to something that is not a JSON object. ' +
  'A workflow state is always an object, so this reading is UNMEASURED — and UNMEASURED ' +
  'refuses rather than passes.';

function erasureReason(dropped: string[]): string {
  return (
    `Refused: this write removes or changes an existing gate result (${dropped.join(', ')}). ` +
    'Erasing a FAIL reaches the same end as forging a PASS. Gate results are produced by ' +
    'gate-runner.ts and are not editable directly.'
  );
}

/** The artifact this module guards. */
export function isWorkflowState(filePath: string): boolean {
  return filePath.endsWith('workflow-state.json');
}

/** Whitespace-tolerant, because JSON is. */
const RESULT_PATTERN = /"result"\s*:\s*"(?:PASS|FAIL)"/;
const DONE_PHASE_PATTERN = /"phase"\s*:\s*"DONE"/i;

/**
 * Decode `\uXXXX` so a pattern sees what `JSON.parse` would see.
 * Naive by design — see the module docstring.
 */
export function decodeUnicodeEscapes(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/** A plain JSON object — not an array, not null, not a scalar. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Every `gates.<name>.result` present, keyed by gate name.
 *
 * Gate-AGNOSTIC: it iterates the keys the content actually carries rather
 * than a list of names this module knows. That is what makes it impossible
 * for a new gate to arrive unguarded.
 */
export function collectGateResults(parsed: unknown): Map<string, string> {
  const found = new Map<string, string>();
  if (!isPlainObject(parsed)) return found;
  const gates = parsed.gates;
  if (!isPlainObject(gates)) return found;
  for (const [name, record] of Object.entries(gates)) {
    if (isPlainObject(record) && record.result !== undefined && record.result !== null) {
      found.set(name, String(record.result));
    }
  }
  return found;
}

/** The gate results already on disk at `filePath`, or null if unreadable. */
function existingGateResults(filePath: string): Map<string, string> | null {
  try {
    if (!existsSync(filePath)) return new Map();
    return collectGateResults(JSON.parse(readFileSync(filePath, 'utf-8')));
  } catch {
    // UNMEASURED for the erasure question only — see the module docstring.
    return null;
  }
}

/** Does this parsed state set a gate result, or phase DONE? */
function decideParsed(parsed: unknown): GateWriteDecision {
  if (!isPlainObject(parsed)) return { blocked: true, reason: NON_OBJECT_REASON };

  if (collectGateResults(parsed).size > 0) {
    return { blocked: true, reason: GATE_RESULT_REASON };
  }

  // Case-insensitive to match the Edit path. Readers compare `=== 'DONE'`
  // exactly, so a lowercase spelling is not a live bypass — but only the gate
  // runner sets this field at all, so refusing both spellings costs nothing
  // and keeps the two branches from disagreeing about one input.
  if (typeof parsed.phase === 'string' && parsed.phase.toUpperCase() === 'DONE') {
    return { blocked: true, reason: DONE_PHASE_REASON };
  }

  return ALLOW;
}

/** Does this Edit fragment set a gate result, or phase DONE? */
function decideFragment(newString: string, oldString: string): GateWriteDecision {
  const text = decodeUnicodeEscapes(newString);
  if (RESULT_PATTERN.test(text)) return { blocked: true, reason: GATE_RESULT_REASON };
  if (DONE_PHASE_PATTERN.test(text)) return { blocked: true, reason: DONE_PHASE_REASON };

  // Erasure: the text being replaced carried a result and the replacement
  // does not. Same end as a forged PASS, and invisible to `new_string` alone.
  const replaced = decodeUnicodeEscapes(oldString);
  if (RESULT_PATTERN.test(replaced)) {
    return { blocked: true, reason: erasureReason(['an edited gate record']) };
  }

  return ALLOW;
}

/**
 * The single decision. `toolInput` is the raw hook payload's `tool_input`.
 *
 * Anything that is not a `Write` or `Edit` targeting `workflow-state.json` is
 * allowed — the guard is scoped to one artifact, and widening the refusal to
 * every unparseable write anywhere would be a brick, not a guard.
 */
export function decideGateResultWrite(
  toolName: string,
  toolInput: Record<string, unknown>,
): GateWriteDecision {
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
  if (!isWorkflowState(filePath)) return ALLOW;

  if (toolName === 'Write') {
    const content = typeof toolInput.content === 'string' ? toolInput.content : '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { blocked: true, reason: UNPARSEABLE_REASON };
    }

    const onContent = decideParsed(parsed);
    if (onContent.blocked) return onContent;

    // The content carries no gate result. If the file already on disk does,
    // this write drops it.
    const before = existingGateResults(filePath);
    if (before && before.size > 0) {
      const after = collectGateResults(parsed);
      const dropped = [...before.keys()].filter(g => after.get(g) !== before.get(g));
      if (dropped.length > 0) return { blocked: true, reason: erasureReason(dropped) };
    }

    return ALLOW;
  }

  if (toolName === 'Edit') {
    const newString = typeof toolInput.new_string === 'string' ? toolInput.new_string : '';
    const oldString = typeof toolInput.old_string === 'string' ? toolInput.old_string : '';
    return decideFragment(newString, oldString);
  }

  return ALLOW;
}
