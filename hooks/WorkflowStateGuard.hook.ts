#!/usr/bin/env bun
/**
 * WorkflowStateGuard.hook.ts -- PreToolUse on Write, Edit
 *
 * SC-370 (HOOK-ARCHITECTURE-SPEC): Hook SC traceability
 * SC-371 (HOOK-ARCHITECTURE-SPEC): No hook exceeds 150 lines
 *
 * Blocks direct Write/Edit of workflow-state.json.
 * All writes must go through writeWorkflowState() for Zod validation.
 *
 * ## One of two hooks on this artifact, and what this one is authoritative for (#1152)
 *
 * `GateResultProtection.hook.ts` matches the same tool calls. The split:
 *
 *  - THIS hook is authoritative for **whether a tool call may write the
 *    artifact at all** — it refuses every Write/Edit regardless of content,
 *    because the sanctioned writer is `writeWorkflowState()` and the Write
 *    and Edit tools bypass its Zod validation.
 *  - `GateResultProtection` is authoritative for **what a permitted write may
 *    contain** — forged, erased or changed gate results, and `phase` DONE.
 *
 * Neither subsumes the other. THIS hook is the one that ships
 * (`deployToConsumers: true`); the specific guard is OPT-IN and a scaffolded
 * consumer does not get it. So on a consumer tree this is the ONLY guard on
 * the artifact — which is why its matcher being case-SENSITIVE while the
 * specific guard's is case-folded (#1184) is a consumer-reachable gap and not
 * a tidiness question.
 *
 * The contract is executed, not described:
 * `test/workflow-state-write-contract.test.ts` runs both hooks over one corpus
 * and records both answers. Change either hook and update that table and
 * `specs/HOOK-ARCHITECTURE-SPEC.md` § "The workflow-state.json write contract"
 * in the same commit.
 */

import { parseHookInput } from './lib/utils';

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);

  const tool = input.tool_name;
  if (tool !== 'Write' && tool !== 'Edit') process.exit(0);

  const toolInput = input.tool_input || {};

  // Write tool uses file_path; Edit tool uses file_path
  const path = (toolInput.file_path as string) || (toolInput.path as string) || '';

  if (!path.includes('workflow-state.json')) process.exit(0);

  // Block the write
  const reason = [
    'BLOCKED: workflow-state.json is protected.',
    'All writes must go through writeWorkflowState() for Zod validation.',
    'Use this pattern instead:',
    '',
    'bun -e "import {writeWorkflowState} from \'./gates/orchestrator.ts\'; import {readFileSync} from \'fs\'; const s = JSON.parse(readFileSync(\'WORK_DIR/workflow-state.json\',\'utf8\')); /* apply fix */; writeWorkflowState(\'WORK_DIR/workflow-state.json\', s);"',
  ].join('\n');

  console.log(JSON.stringify({ decision: 'block', reason }));
}

main();
