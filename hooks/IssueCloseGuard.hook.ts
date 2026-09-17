#!/usr/bin/env bun
/**
 * IssueCloseGuard.hook.ts — PreToolUse on Bash
 *
 * Blocks gh issue close if ship-gate hasn't passed.
 * Validates HMAC provenance on PASS results.
 * Also validates comment templates on gh issue comment.
 */

import { createHmac } from 'crypto';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseHookInput, findWorkflowState, HARNESS_ROOT } from './lib/utils';

const TEMPLATE_RULES = [
  { marker: '## AC-', required: ['Type:', 'Metric:', 'Threshold:', 'Baseline:', 'Evidence Method:', 'Pass Criteria:'] },
  { marker: '## ATTEMPT', required: ['Approach:', 'Files Changed:', 'Result:', 'Evidence:', 'Why It Failed:'] },
  { marker: '## DISCOVERY', required: ['### Docs read', '### Issue context'] },
  { marker: '## Completion Report', required: ['### Evidence per AC', '### Ship Scorecard'] },
  { marker: '## Sizing Declaration', required: ['Predicted:', 'Files:'] },
  { marker: '## Sizing Outcome', required: ['Declared:', 'Actual:'] },
];

function block(reason: string): never {
  console.log(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
  throw new Error('unreachable');
}

function validateCommentTemplate(command: string) {
  let body = '';
  const heredocMatch = command.match(/--body\s+"?\$\(cat\s+<<'?EOF'?\s*\n?([\s\S]*?)\nEOF/);
  if (heredocMatch) body = heredocMatch[1];
  else {
    const bodyMatch = command.match(/(?:--body|-b)\s+["']([^"']*(?:(?:\\.)[^"']*)*)['"]/);
    if (bodyMatch) body = bodyMatch[1];
  }
  if (!body) return;

  if (/^## AC-\d+/m.test(body))
    block('ACs (## AC-N) must be posted to the issue body via "gh issue edit --body", not as comments.');
  if (body.includes('### Docs read') && !body.includes('## DISCOVERY'))
    block('Comment contains "### Docs read" but no "## DISCOVERY" heading. Use the DISCOVERY template.');
  if (body.includes('### Evidence per AC') && !body.includes('## Completion Report'))
    block('Comment contains "### Evidence per AC" but no "## Completion Report" heading.');
  if (body.includes('REPLACE:'))
    block('Comment body contains unfilled REPLACE: placeholder(s).');

  for (const rule of TEMPLATE_RULES) {
    if (!body.includes(rule.marker)) continue;
    const missing = rule.required.filter(f => !body.includes(f));
    if (missing.length) block(`Template "${rule.marker}" missing fields: ${missing.join(', ')}. See TEMPLATES.md.`);
  }
}

function validateHmac(wf: any, slug: string, issueNum: string) {
  const gateHash = wf.gates?.ship?.hash;
  const saltPath = join(HARNESS_ROOT, 'gates', '.gate-salt');
  if (!gateHash || !existsSync(saltPath)) {
    if (!gateHash) console.error('[close-guard] WARN: Ship PASS without HMAC');
    return;
  }
  const salt = readFileSync(saltPath, 'utf-8').trim();
  const commitSha = wf.gates?.ship?.commitSha || 'unknown';
  const hmacInput = `${slug}:${wf.issue}:PASS:${commitSha}`;
  const expected = createHmac('sha256', salt).update(hmacInput).digest('hex').substring(0, 16);
  if (gateHash !== expected) block(`Cannot close #${issueNum} — gate HMAC mismatch. Results may be fabricated.`);
}

async function main() {
  const input = await parseHookInput();
  if (!input || input.tool_name !== 'Bash') process.exit(0);

  const command = input.tool_input?.command || '';

  if (/gh\s+issue\s+comment\s+\d+/.test(command)) {
    validateCommentTemplate(command);
    process.exit(0);
  }

  const closeMatch = command.match(/gh\s+issue\s+close\s+(\d+)/);
  if (!closeMatch) process.exit(0);
  const issueNum = closeMatch[1];

  const wf = findWorkflowState(issueNum);
  if (!wf) {
    console.log(`<system-reminder>\nWARNING: Closing #${issueNum} but no workflow-state.json found.\nIf this issue went through ship, gates may not have been run.\n</system-reminder>`);
    process.exit(0);
  }

  const state = wf.data;
  if (state.gates?.ship?.result === 'PASS') {
    validateHmac(state, wf.slug, issueNum);
    try {
      state.phase = 'DONE';
      state.updatedTs = new Date().toISOString();
      writeFileSync(wf.path, JSON.stringify(state, null, 2) + '\n');
      console.error(`[close-guard] Updated phase to DONE for #${issueNum}`);
    } catch {}
    process.exit(0);
  }

  block(`Cannot close #${issueNum} — ship-gate result is "${state.gates?.ship?.result || 'not set'}". Run: bun run ${HARNESS_ROOT}/gates/run-gate.ts --gate ship --slug ${wf.slug}`);
}

main();
