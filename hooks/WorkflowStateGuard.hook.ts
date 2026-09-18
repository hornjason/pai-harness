#!/usr/bin/env bun
/**
 * WorkflowStateGuard.hook.ts -- PreToolUse on Write, Edit
 *
 * Blocks direct Write/Edit of workflow-state.json.
 * All writes must go through writeWorkflowState() for Zod validation.
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
