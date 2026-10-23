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
 * THIS hook is the one that ships (`deployToConsumers: true`); the specific
 * guard is OPT-IN and a scaffolded consumer does not get it. So on a consumer
 * tree this is the ONLY guard on the artifact, and that is why its matcher
 * being case-SENSITIVE while the specific guard's was case-folded (#1184) was
 * a consumer-reachable gap and not a tidiness question. #1211 closed it: the
 * matcher below case-folds, so the two predicates now agree on WHICH paths are
 * the artifact and differ only in reach — `.includes()` here against
 * `.endsWith()` there.
 *
 * The specific guard's refusals are therefore a SUBSET of this hook's. That is
 * the safe direction and it is asserted, not assumed: this hook refusing every
 * Write/Edit of the artifact means a consumer tree is covered for the question
 * "may a tool call write this at all", which is the only question a consumer
 * tree has a guard for. Subsumed is not dead — the two do not ship to the same
 * trees, and the specific guard's refusal messages name the forgery while this
 * one names the sanctioned writer.
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

  // Case-FOLDED (#1211). `WORKFLOW-STATE.JSON` and `workflow-state.json` are one
  // file on a case-insensitive filesystem — measured in #1184, which closed this
  // in GateResultProtection and never carried the fix here. This is the guard
  // that ships, so the uppercase spelling was reaching a consumer's disk with no
  // guard at all. The population the fold newly claims is enumerated and bounded
  // in test/workflow-state-guard-case.test.ts; it is case-variants of this name
  // and nothing else.
  if (!path.toLowerCase().includes('workflow-state.json')) process.exit(0);

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
