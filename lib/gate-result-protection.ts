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
 * `workflow-state.json` are, and the version this replaces was not: it
 * enumerated two spacings of one key with `String.includes`, so
 * `"result"  :  "PASS"` walked past it.
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
 * reading falls back to a pattern. Two consequences follow, and both are the
 * reason the branches are not shared:
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
 * ## The Edit pattern is gate-agnostic on purpose
 *
 * It matches `"result": "PASS"` anywhere in the fragment rather than only
 * under a name in `PROTECTED_GATES`. A fragment carries no reliable parent
 * key, so scoping it to the registry would make the guard WEAKER than the
 * registry — it would have to guess. Gate-agnostic is a superset of the
 * registry, so a name added to `PROTECTED_GATES` is already covered here,
 * and `lib/gate-names.ts` is what the Write branch iterates.
 *
 * ## An unparseable Write is REFUSED
 *
 * The version this replaces caught the parse error and allowed the write,
 * reasoning that it "might be a partial write". There is no partial write:
 * the Write tool replaces the whole file. And every reader of this artifact
 * does `JSON.parse(readFileSync(...))` — `lib/gate-enforcement.ts` and
 * `gates/orchestrator.ts` both — so content that does not parse is either
 * corruption or an evasion, and the one input an attacker fully controls was
 * the one that bypassed the guard. Fail closed.
 */

import { PROTECTED_GATES } from './gate-names';

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

/** Does this parsed state set a protected gate's result, or phase DONE? */
function decideParsed(parsed: unknown): GateWriteDecision {
  if (parsed === null || typeof parsed !== 'object') return ALLOW;
  const state = parsed as { gates?: Record<string, { result?: unknown }>; phase?: unknown };

  const gates = state.gates;
  if (gates && typeof gates === 'object') {
    for (const gate of PROTECTED_GATES) {
      if (gates[gate]?.result) return { blocked: true, reason: GATE_RESULT_REASON };
    }
  }

  // Case-insensitive to match the Edit path. Readers compare `=== 'DONE'`
  // exactly, so a lowercase spelling is not a live bypass — but only the gate
  // runner sets this field at all, so refusing both spellings costs nothing
  // and keeps the two branches from disagreeing about one input.
  if (typeof state.phase === 'string' && state.phase.toUpperCase() === 'DONE') {
    return { blocked: true, reason: DONE_PHASE_REASON };
  }

  return ALLOW;
}

/** Does this Edit fragment set a gate result, or phase DONE? */
function decideFragment(newString: string): GateWriteDecision {
  const text = decodeUnicodeEscapes(newString);
  if (RESULT_PATTERN.test(text)) return { blocked: true, reason: GATE_RESULT_REASON };
  if (DONE_PHASE_PATTERN.test(text)) return { blocked: true, reason: DONE_PHASE_REASON };
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
    return decideParsed(parsed);
  }

  if (toolName === 'Edit') {
    const newString = typeof toolInput.new_string === 'string' ? toolInput.new_string : '';
    return decideFragment(newString);
  }

  return ALLOW;
}
