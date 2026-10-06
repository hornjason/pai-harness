#!/usr/bin/env bun
/**
 * IssueCloseGuard.hook.ts — PreToolUse on Bash
 *
 * SC-370 (HOOK-ARCHITECTURE-SPEC): Hook SC traceability
 * SC-371 (HOOK-ARCHITECTURE-SPEC): No hook exceeds 150 lines
 *
 * Blocks gh issue close if ship-gate hasn't passed.
 * Validates HMAC provenance on PASS results.
 * Also validates comment templates on gh issue comment.
 */

import { createHmac } from 'crypto';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseHookInput, findWorkflowState, parseRepoSlug, HARNESS_ROOT } from './lib/utils';
import { createGitHubClient, getIssue } from '../lib/github';

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

  const repo = parseRepoSlug(command) || 'hornjason/pai-config';

  const wf = findWorkflowState(issueNum);
  if (!wf) {
    // #140: `block()` used to sit inside a `try` whose `catch {}` was empty,
    // so every way of failing to READ the labels — no credential (#139), a
    // rate limit, a malformed repo, a network blip — fell through to the
    // warning below and exited 0. The close went ahead. Measured: the same
    // close of the same p1-labelled issue blocked with a token present and
    // was waved through without one.
    //
    // There is no workflow-state.json here, so the labels are the only
    // evidence available. Not being able to read them is not the same as
    // reading them and finding nothing, and only one of those is safe to
    // treat as permission.
    let labelNames: string;
    try {
      const github = createGitHubClient();
      const issueData = await getIssue(github, repo, parseInt(issueNum, 10));
      labelNames = (issueData.labels || []).map((l: any) => typeof l === 'string' ? l : l.name).join('\n');
    } catch (e: any) {
      block(
        `Cannot close #${issueNum} — no workflow-state.json, and its labels could not be ` +
        `read to check whether it is protected: ${e?.message?.slice(0, 200) || e}\n` +
        `Fix the GitHub access (GITHUB_TOKEN or GH_TOKEN) and retry, or close it on GitHub ` +
        `directly if you have already confirmed it does not need to ship.`,
      );
    }

    if (labelNames.includes('p1-ship-next') || labelNames.includes('p2-this-week')) {
      block(`Cannot close #${issueNum} — has ${labelNames.includes('p1') ? 'p1-ship-next' : 'p2-this-week'} label but no workflow-state.json. Run /ship first.`);
    }
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
