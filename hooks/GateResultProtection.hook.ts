#!/usr/bin/env bun
/**
 * GateResultProtection.hook.ts — PreToolUse on Write + Edit
 *
 * Governing SCs: SC-370 (traceability), SC-371 (thin trigger, under 150 lines)
 *
 * TRIGGER: PreToolUse (matcher: Write, Edit)
 *
 * PURPOSE:
 * Block direct writes to workflow-state.json that modify gate result fields.
 * Gate results must be produced by the gate runner, not written directly.
 *
 * PROTECTED FIELDS:
 *  - gates.<name>.result, for every name in lib/gate-names.ts
 *  - phase = "DONE" (only the gate runner advances to DONE)
 *
 * ALLOWED:
 *  - Writes that don't target workflow-state.json
 *  - Writes to workflow-state.json that don't touch gate result fields
 *    (e.g., adding ACs, updating changelog, setting phase to BUILD/SCOPE/VERIFY)
 *
 * REFUSED, and this is the #1137 change:
 *  - A Write to workflow-state.json whose content does not parse as JSON.
 *    It used to be allowed. See lib/gate-result-protection.ts for why that
 *    was backwards, and for why the Edit branch decodes unicode escapes.
 *
 * PORTABILITY (#713): `workflow-state.json` is a rungate gate artifact. Both
 * imports are rungate-owned and both sit in `package.json` `files[]`, so this
 * guards the same artifact on a consumer repo as it does here.
 *
 * ## One of two hooks on this artifact, and what this one is authoritative for (#1152)
 *
 * `WorkflowStateGuard.hook.ts` matches the same tool calls. The split:
 *
 *  - `WorkflowStateGuard` is authoritative for **whether a tool call may
 *    write the artifact at all**, and refuses every Write/Edit of it.
 *  - THIS hook is authoritative for **what a permitted write may contain**.
 *
 * Since #1211 case-folded the blanket guard's matcher, this hook's refusals
 * are a SUBSET of the blanket guard's: both now agree on which paths are the
 * artifact, and the blanket guard refuses every Write/Edit of it. Until then
 * the one input this hook refused and the blanket guard permitted was
 * `WORKFLOW-STATE.JSON` — a hole in the SHIPPING guard, not a feature of this
 * one, which is why closing it was right even though it made this hook
 * behaviourally subsumed in a tree holding both.
 *
 * Subsumed is not dead, and the reason is deployment rather than behaviour:
 * this hook does not travel to consumers (below), and in a session on this
 * machine its registration resolves to a tree outside this repository (#713).
 * Because the blanket guard fires first in THIS repository, this hook's
 * ALLOW-path is not observable from an ordinary session here — that is #1152,
 * and the reason the contract test runs each hook on its own rather than
 * through a session.
 *
 * Note the reach is the opposite way round from what #1152's body assumes:
 * `WorkflowStateGuard` is `deployToConsumers: true` and this hook is
 * `deployToConsumers: false` (OPT-IN), so a scaffolded consumer gets the
 * blanket guard and not this one. If that flag is ever turned on, this hook's
 * refusals become part of a consumer's write contract and the authority table
 * in the spec needs rewriting.
 *
 * The contract is executed, not described:
 * `test/workflow-state-write-contract.test.ts` runs both hooks over one corpus
 * and records both answers. Change either hook and update that table and
 * `specs/HOOK-ARCHITECTURE-SPEC.md` § "The workflow-state.json write contract"
 * in the same commit.
 *
 * Issues: #471, #1137, #1152
 */

import { parseHookInput } from './lib/parseStdin';
import { decideGateResultWrite } from '../lib/gate-result-protection';

async function main() {
  const input = await parseHookInput();
  // No parseable hook payload is not a tool call we can read, and every hook
  // in this tree treats it as a no-op. It is not the decision surface: by
  // definition it names no file, so it cannot be a write to a gate artifact.
  if (!input) process.exit(0);

  let decision;
  try {
    decision = decideGateResultWrite(
      input.tool_name || '',
      (input.tool_input || {}) as Record<string, unknown>,
    );
  } catch (e) {
    // A guard that crashes must not thereby allow the thing it guards (#1137).
    // Scoped to a payload that already named workflow-state.json, so a bug
    // here refuses writes to one artifact rather than bricking the session.
    const named = String((input.tool_input as { file_path?: unknown })?.file_path ?? '');
    if (!named.endsWith('workflow-state.json')) process.exit(0);
    decision = {
      blocked: true,
      reason: `Refused: gate-result protection could not evaluate this write (${String(e)}).`,
    };
  }

  if (decision.blocked) {
    console.log(JSON.stringify({ decision: 'block', reason: decision.reason }));
  }
  // If not blocked, exit silently (allow)
  process.exit(0);
}

main().catch(() => process.exit(0));
