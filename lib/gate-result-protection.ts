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
 * ## Both branches read the disk, because they are one rule
 *
 * An earlier draft decided the Edit branch from the two string fragments
 * alone. That caught erasure OF A RESULT and missed erasure of the PATH to
 * one: `old_string: '"gates"'`, `new_string: '"gates_old"'` contains no
 * forbidden substring, leaves the file valid JSON, and moves every gate
 * record out of reach of `collectGateResults`. Measured ALLOWED.
 *
 * So the Edit branch now reads the file, applies the splice in memory,
 * parses the result, and compares `collectGateResults` before against after
 * — the same reading the Write branch takes. The fragment patterns survive
 * only as a FAST PRE-FILTER that can refuse without I/O; they are never the
 * decision. Two implementations of one rule is why the branches could
 * disagree at all.
 *
 * A gate result that is ADDED, REMOVED or CHANGED all refuse. Re-running a
 * gate legitimately changes `PASS`↔`FAIL`, and that is precisely the write
 * this hook exists to route through the gate runner instead — a re-run is
 * not a reason to let the thing being gated edit the verdict by hand.
 *
 * ## UNMEASURED refuses, including the prior state
 *
 * A workflow state is always a JSON object. Content that does not parse, or
 * parses to an array, a `null` or a scalar, is a reading the guard could not
 * take — and a reading that could not be taken is not one that passed.
 *
 * That now includes the PRIOR state. If the file already on disk will not
 * parse, whether this change erases a result is UNMEASURED, and it refuses.
 * An earlier draft allowed it, reasoning that refusing would make a corrupt
 * state file unrepairable. **Measured 2026-10-22: it would not.** The
 * sanctioned repair is `bun -e "…writeWorkflowState(path, state)"`, which
 * succeeds over unparseable prior content — its own prior read sits inside a
 * `catch` that yields `null` — and which is a Bash call this PreToolUse
 * matcher never sees. The refusal names that path, because a guard nobody
 * can get out from under is a guard that gets switched off.
 *
 * That allowance was also the second half of a two-step bypass: Edit was the
 * only way to reach a corrupt prior state, since the Write branch already
 * refused unparseable incoming content — and once reached, every later Write
 * carrying no results was permitted. Refusing an Edit that leaves the file
 * unparseable closes the entry; refusing an unparseable prior closes the
 * escalation. Either alone breaks the chain; both is right.
 */

import { readFileSync } from 'fs';

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
    `Refused: this write adds, removes or changes an existing gate result (${dropped.join(', ')}). ` +
    'Erasing a FAIL reaches the same end as forging a PASS. Gate results are produced by ' +
    'gate-runner.ts and are not editable directly.'
  );
}

/**
 * Named in every refusal that turns on a state file the guard could not
 * read. A refusal with no way out is one somebody disables.
 */
const REPAIR_HINT =
  ' To repair a corrupt workflow-state.json, use the sanctioned writer — it tolerates an ' +
  'unparseable prior state and is a Bash call, not a Write/Edit: ' +
  "bun -e \"import {writeWorkflowState} from '<harness>/gates/orchestrator.ts'; " +
  "writeWorkflowState('<path>', state);\"";

const PRIOR_UNPARSEABLE_REASON =
  'Refused: the workflow-state.json already at this path could not be parsed, so whether this ' +
  'change erases a gate result is UNMEASURED — and UNMEASURED refuses rather than passes.' +
  REPAIR_HINT;

const UNMODELLABLE_EDIT_REASON =
  'Refused: the guard could not model this edit — `old_string` does not appear in ' +
  'workflow-state.json, so whether the result would erase a gate result is UNMEASURED. ' +
  'Rewrite old_string to match the file byte-for-byte and retry.' +
  REPAIR_HINT;

const EDIT_CORRUPTS_REASON =
  'Refused: applying this edit would leave workflow-state.json unparseable. Every reader of ' +
  'this artifact JSON.parses it, and a corrupt state file disables the gate-result comparison ' +
  'for every write after it.' +
  REPAIR_HINT;

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

type PriorState =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'ok'; raw: string; state: unknown };

/**
 * What is already at `filePath`, as a reading that can say it failed.
 *
 * ONE implementation, called by both branches. The Edit branch used to do
 * its own `existsSync` + `try/catch { return ALLOW }`, which made a
 * present-but-unreadable file ALLOW there and refuse on the Write path —
 * the same divergence, in the same file, that this issue is about.
 *
 * `ENOENT` is separated from every other errno rather than catching
 * everything: "there is no file here" is a fact the guard can act on, and
 * "I could not read the file that is here" is one it cannot. Collapsing
 * them is how an unreadable file comes to look like a new run. No
 * `existsSync` first — one syscall, and no window between the check and
 * the read.
 */
function readPriorState(filePath: string): PriorState {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unreadable' };
  }
  try {
    return { kind: 'ok', raw, state: JSON.parse(raw) };
  } catch {
    return { kind: 'unreadable' };
  }
}

/** Is this state's phase DONE? */
function isDone(state: unknown): boolean {
  return (
    isPlainObject(state) &&
    typeof state.phase === 'string' &&
    state.phase.toUpperCase() === 'DONE'
  );
}

/** Does this parsed state forge a gate result? */
function decideParsed(parsed: unknown): GateWriteDecision {
  if (!isPlainObject(parsed)) return { blocked: true, reason: NON_OBJECT_REASON };

  if (collectGateResults(parsed).size > 0) {
    return { blocked: true, reason: GATE_RESULT_REASON };
  }

  return ALLOW;
}

/**
 * Phase DONE is a TRANSITION, not a resting state.
 *
 * The rule is that only the gate runner ADVANCES a run to DONE. An earlier
 * draft refused whenever the outcome was DONE, which refused every edit to
 * an already-finished run — measured as 6 refusals across 157 legitimate
 * operations on the 44 live states in `~/.rungate`, all of them on the two
 * runs whose phase was already DONE. Nothing was being advanced; the guard
 * was reading a resting value as an event.
 *
 * Refusing the transition loses nothing: an attacker who wants DONE has to
 * arrive from not-DONE, and the gate results of a finished run stay covered
 * by the before/after comparison either way.
 *
 * Case-insensitive because the Edit pre-filter is. Readers compare
 * `=== 'DONE'` exactly, so a lowercase spelling is not a live bypass, but
 * only the gate runner sets this field and refusing both costs nothing.
 */
function advancesToDone(prior: PriorState, after: unknown): boolean {
  if (!isDone(after)) return false;
  return !(prior.kind === 'ok' && isDone(prior.state));
}

/** Gate names whose result differs between two readings, in either direction. */
function gateResultDelta(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  const changed = new Set<string>();
  for (const [gate, result] of before) if (after.get(gate) !== result) changed.add(gate);
  for (const gate of after.keys()) if (!before.has(gate)) changed.add(gate);
  return [...changed];
}

/**
 * The Edit tool's splice, in memory. A function replacement rather than a
 * string one: `String.replace` with a string pattern interprets `$&`, `$1`
 * and friends in the replacement, so a `new_string` containing a dollar sign
 * would be spliced as something other than what lands on disk — and a guard
 * that models the write incorrectly is measuring the wrong file.
 */
function applySplice(raw: string, oldString: string, newString: string, all: boolean): string {
  if (all) return raw.split(oldString).join(newString);
  const at = raw.indexOf(oldString);
  if (at === -1) return raw;
  return raw.slice(0, at) + newString + raw.slice(at + oldString.length);
}

/**
 * Decide an Edit by modelling its OUTCOME, not by reading its fragments.
 *
 * The fragment patterns run first and can refuse with no I/O, but they are a
 * pre-filter: the decision is the before/after comparison below.
 */
function decideEdit(
  filePath: string,
  oldString: string,
  newString: string,
): GateWriteDecision {
  // Fast pre-filter — a replacement that spells a result or DONE outright.
  const text = decodeUnicodeEscapes(newString);
  if (RESULT_PATTERN.test(text)) return { blocked: true, reason: GATE_RESULT_REASON };
  if (DONE_PHASE_PATTERN.test(text)) return { blocked: true, reason: DONE_PHASE_REASON };

  const prior = readPriorState(filePath);
  // No file yet: the Edit tool refuses this itself, so there is no outcome
  // to model and nothing to protect. This is the ONLY bare allow left on
  // this path, and it is a reading, not a swallowed error.
  if (prior.kind === 'missing') return ALLOW;
  if (prior.kind === 'unreadable') {
    return { blocked: true, reason: PRIOR_UNPARSEABLE_REASON };
  }

  // An `old_string` the file does not contain is an edit this guard cannot
  // model. The earlier draft allowed it, reasoning that the Edit tool
  // refuses such an edit anyway — sound about the TOOL, and the wrong party
  // to reason about. The guard models the tool, and where the model and the
  // tool differ it is the model that is wrong; line endings, a BOM and
  // `replace_all` are three places they can. The cost settles it:
  // over-blocking costs an agent one retry, under-blocking costs the control.
  if (oldString === '' || !prior.raw.includes(oldString)) {
    return { blocked: true, reason: UNMODELLABLE_EDIT_REASON };
  }

  const before = collectGateResults(prior.state);

  // BOTH outcomes, because `replace_all`'s coercion belongs to the tool and
  // not to us. Reading it as `=== true` made every truthy non-boolean —
  // `1`, `"true"` — model a single replacement while the tool may replace
  // all, which was a live bypass: measured ALLOWED where `true` refused.
  // Guessing the coercion is a second implementation of someone else's
  // rule; evaluating both needs no guess. When `old_string` occurs once the
  // two splices are identical, which is the overwhelmingly common case.
  for (const all of [false, true]) {
    let after: unknown;
    try {
      after = JSON.parse(applySplice(prior.raw, oldString, newString, all));
    } catch {
      return { blocked: true, reason: EDIT_CORRUPTS_REASON };
    }
    if (!isPlainObject(after)) return { blocked: true, reason: NON_OBJECT_REASON };

    const delta = gateResultDelta(before, collectGateResults(after));
    if (delta.length > 0) return { blocked: true, reason: erasureReason(delta) };

    if (advancesToDone(prior, after)) {
      return { blocked: true, reason: DONE_PHASE_REASON };
    }
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
    // this write drops it — and if that file will not parse, whether it does
    // is UNMEASURED, which refuses.
    const prior = readPriorState(filePath);
    if (prior.kind === 'unreadable') {
      return { blocked: true, reason: PRIOR_UNPARSEABLE_REASON };
    }
    const before = prior.kind === 'ok' ? collectGateResults(prior.state) : new Map<string, string>();
    const delta = gateResultDelta(before, collectGateResults(parsed));
    if (delta.length > 0) return { blocked: true, reason: erasureReason(delta) };

    if (advancesToDone(prior, parsed)) {
      return { blocked: true, reason: DONE_PHASE_REASON };
    }

    return ALLOW;
  }

  if (toolName === 'Edit') {
    const newString = typeof toolInput.new_string === 'string' ? toolInput.new_string : '';
    const oldString = typeof toolInput.old_string === 'string' ? toolInput.old_string : '';
    return decideEdit(filePath, oldString, newString);
  }

  return ALLOW;
}
