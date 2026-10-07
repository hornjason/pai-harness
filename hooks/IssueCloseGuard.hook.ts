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
import { parseHookInput, findWorkflowState, parseCloseTarget, redactSecrets, HARNESS_ROOT } from './lib/utils';
import { commentTemplateViolation, COMMENT_INVOCATION } from './lib/comment-template';
import { createGitHubClient, getIssue } from '../lib/github';

function block(reason: string): never {
  console.log(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
  throw new Error('unreachable');
}

// Rules live in hooks/lib/comment-template.ts — HOOK-ARCHITECTURE-SPEC wants
// the trigger thin, and SC-371 caps this file at 150 lines.
function validateCommentTemplate(command: string) {
  const violation = commentTemplateViolation(command);
  if (violation) block(violation);
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

  if (COMMENT_INVOCATION.test(command)) {
    validateCommentTemplate(command);
    process.exit(0);
  }

  // The parse reports whether the command is simple enough to vet, not what
  // to vet — see parseCloseTarget. Anything it cannot read unambiguously is
  // refused rather than guessed at, because a guess here checks one issue's
  // labels and closes another's.
  const target = parseCloseTarget(command);
  if (target.kind === 'none') process.exit(0);
  if (target.kind === 'ambiguous') {
    block(`Cannot vet this close — ${target.reason}.`);
  }

  const issueNum = target.issue;

  // #143: this fell back to a literal slug naming a DIFFERENT repository, so
  // a close that named none was decided by whatever issue shared that number
  // over there. The repo must come from the same parse result as the issue
  // number — and only from the closing segment, since a `--repo` elsewhere in
  // a compound command belongs to another invocation. It is not inferred from
  // the machine either: PR #154 derived it from the git remote and review
  // found two bypasses, because that is a second parser surface on a boundary
  // that already has one too many (#144). A bare `gh issue close 23` now
  // blocks; the guard either knows which issue it is vetting or says so.
  if (!target.repo) {
    block(
      `Cannot close #${issueNum} — the command names no repository, so the guard cannot tell ` +
      `which issue #${issueNum} is. Re-run it naming one: --repo owner/name (or export GH_REPO).`,
    );
  }
  const repo = target.repo;

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
      // Scrub before printing — the message can carry the request URL, and a
      // block reason is echoed into transcripts and issue comments.
      const detail = redactSecrets(String(e?.message || e)).slice(0, 200);
      block(
        // Naming the repo is not decoration: it is the only way an operator —
        // or a test — can see WHICH repository the guard decided to vet, and
        // vetting the wrong one is exactly the defect #143 reports.
        `Cannot close #${issueNum} — no workflow-state.json, and its labels in ${repo} could ` +
        `not be read to check whether it is protected: ${detail}\n` +
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
