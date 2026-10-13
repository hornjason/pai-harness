#!/usr/bin/env bun
/**
 * IssueCloseGuard.hook.ts — PreToolUse on Bash
 *
 * SC-370 (HOOK-ARCHITECTURE-SPEC): Hook SC traceability
 * SC-371 (HOOK-ARCHITECTURE-SPEC): No hook exceeds 150 lines
 *
 * Blocks a close if ship-gate hasn't passed. Validates HMAC provenance on
 * PASS results, and comment templates on gh issue comment.
 *
 * ## This is a speed bump. It is not an authorization boundary. (#144)
 *
 * Read this before opening a security review against the parser below.
 * Deciding, from the TEXT of a Bash command, whether it will close an issue
 * means reimplementing shell quoting and expansion plus gh's flag parser.
 * Five review rounds on 2026-10-06 each found a real differential; a sixth
 * would too. `gh api -X PATCH repos/o/n/issues/23 -f state=closed` mentions
 * neither word it looks for, and neither does a wrapper script, an alias,
 * `xargs`, curl, or the web UI.
 *
 * **Jason's decision, 2026-10-08: Option C.** Kept, because it is fast and
 * has caught real mistakes — and reclassified to fast feedback. The control
 * is `scripts/audit-issue-closures.ts`, scheduled by
 * `.github/workflows/issue-audit.yml`, which reads the OUTCOME and so cannot
 * be bypassed by phrasing. A bypass found here is NOT a defect to file;
 * tightening the pattern is the loop #144 exists to end. See
 * specs/HARNESS-STANDARD.md § SC-833..836.
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

// Rules live in hooks/lib/comment-template.ts — SC-371 caps this file at 150.
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

  // parseCloseTarget reports whether the command is simple enough to vet.
  // Anything unreadable is refused, not guessed: a guess here checks one
  // issue's labels and closes another's.
  const target = parseCloseTarget(command);
  if (target.kind === 'none') process.exit(0);
  if (target.kind === 'ambiguous') {
    block(`Cannot vet this close — ${target.reason}.`);
  }

  const issueNum = target.issue;

  // #143: the repo must come from the same parse result as the issue number,
  // and only from the closing segment. Do NOT infer it from the git remote —
  // PR #154 did and review found two bypasses. See HOOK-ARCHITECTURE-SPEC.
  if (!target.repo) {
    block(
      `Cannot close #${issueNum} — the command names no repository, so the guard cannot tell ` +
      // Deliberately no GH_REPO suggestion: the parser matches --repo/-R only,
      // so naming it here taught operators how to create the bypass.
      `which issue #${issueNum} is. Re-run it naming one: --repo owner/name.`,
    );
  }
  const repo = target.repo;

  const wf = findWorkflowState(issueNum);
  if (!wf) {
    // #140: the labels are the only evidence left here, and FAILING to read
    // them is not the same as reading them and finding nothing. Only one of
    // those is safe to treat as permission, so the catch below blocks rather
    // than warning. Do not reintroduce an empty catch.
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
        // Naming the repo is not decoration: it is how anyone sees WHICH
        // repository the guard vetted, which is the defect #143 reports.
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
    } catch (e: any) {
      // Was `catch {}`. Non-fatal (the ship gate passed), but a failed write
      // leaves state reading un-shipped on a closed issue — report it (SC-606).
      console.error(`[close-guard] Could not persist phase=DONE for #${issueNum}: ${redactSecrets(String(e?.message || e)).slice(0, 200)}`);
    }
    process.exit(0);
  }

  block(`Cannot close #${issueNum} — ship-gate result is "${state.gates?.ship?.result || 'not set'}". Run: bun run ${HARNESS_ROOT}/gates/run-gate.ts --gate ship --slug ${wf.slug}`);
}

main();
