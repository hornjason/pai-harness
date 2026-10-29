/**
 * findWorkflow.ts — Shared workflow discovery for hooks
 *
 * Used by: ScopeGateGuard, AutoVerifyGate
 * Issue: #269
 *
 * Finds workflow-state.json by issue number (preferred) or mtime fallback.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { isRunDirectory } from '../../lib/active-workflow';

// `PAI_WORK_DIR` second, as every sibling resolves it — VerifyPhaseLock,
// StaleTTLCleanup, AgentVerdictCapture and lib/issue-filing-gate.ts all read
// the same three in the same order. This file read RUNGATE_WORK_DIR twice,
// so a consumer still on the legacy variable silently got `~/.rungate`.
const RUNGATE_WORK_DIR = process.env.RUNGATE_WORK_DIR || process.env.PAI_WORK_DIR || join(process.env.HOME!, '.rungate');

interface WorkflowState {
  path: string;
  data: any;
  slug: string;
}

export function findWorkflowForIssue(issueNum?: string, phases?: string[], repo?: string, projectRoot?: string): WorkflowState | null {
  if (!existsSync(RUNGATE_WORK_DIR)) return null;

  const validPhases = phases || ['BUILD', 'VERIFY', 'SCOPE', 'SHIP', 'DONE'];
  let candidates: { path: string; data: any; mtime: number; slug: string }[] = [];

  // Collect all valid workflow entries
  const collectWorkflow = (wfPath: string, slug: string) => {
    if (!existsSync(wfPath)) return;
    try {
      const data = JSON.parse(readFileSync(wfPath, 'utf-8'));
      if (!validPhases.includes(data.phase)) return;
      const mtime = statSync(wfPath).mtimeMs;
      candidates.push({ path: wfPath, data, mtime, slug });
    } catch {}
  };

  try {
    // Hidden entries are the work dir's own bookkeeping, not runs — and
    // `Priority 3` below is an mtime fallback, so `.archive`'s newest state
    // file outranks every live run. That is #1648. Both levels, for the
    // reason in lib/active-workflow.ts.
    //
    // Blast radius, since an earlier version of this comment got it wrong:
    // `CommitEnforcement.hook.ts` is the ONLY hook importing this module.
    // `IssueCloseGuard` and `AutoVerifyGate` use `findWorkflowState` from
    // `./utils`, a third implementation of this scan that is still
    // unfiltered — #1668. Fixing this file does not reach them.
    const dirs = readdirSync(RUNGATE_WORK_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && isRunDirectory(d.name));

    for (const d of dirs) {
      // Level 1: direct children
      collectWorkflow(join(RUNGATE_WORK_DIR, d.name, 'workflow-state.json'), d.name);

      // Level 2: nested subdirectories (e.g., pai/361)
      const subDir = join(RUNGATE_WORK_DIR, d.name);
      try {
        const subDirs = readdirSync(subDir, { withFileTypes: true })
          .filter(sd => sd.isDirectory() && isRunDirectory(sd.name));
        for (const sd of subDirs) {
          collectWorkflow(join(subDir, sd.name, 'workflow-state.json'), `${d.name}/${sd.name}`);
        }
      } catch {}
    }
  } catch {}

  if (candidates.length === 0) return null;

  // Resolution priority: projectRoot > issueNum > mtime fallback

  // Priority 1: Match by projectRoot
  if (projectRoot) {
    const byRoot = candidates.filter(c => c.data.projectRoot === projectRoot);
    if (byRoot.length === 1) return { path: byRoot[0].path, data: byRoot[0].data, slug: byRoot[0].slug };
    if (byRoot.length > 1) {
      // Multiple matches — narrow by issue if available
      if (issueNum) {
        const rootAndIssue = byRoot.find(c => String(c.data.issue) === issueNum);
        if (rootAndIssue) return { path: rootAndIssue.path, data: rootAndIssue.data, slug: rootAndIssue.slug };
      }
      // Return most recent among projectRoot matches
      byRoot.sort((a, b) => b.mtime - a.mtime);
      return { path: byRoot[0].path, data: byRoot[0].data, slug: byRoot[0].slug };
    }
  }

  // Priority 2: Match by issue number
  if (issueNum) {
    const byIssue = candidates.filter(c => String(c.data.issue) === issueNum);
    if (byIssue.length > 0) {
      // Narrow by repo if provided
      if (repo) {
        const byRepo = byIssue.find(c => c.data.repo === repo);
        if (byRepo) return { path: byRepo.path, data: byRepo.data, slug: byRepo.slug };
      }
      return { path: byIssue[0].path, data: byIssue[0].data, slug: byIssue[0].slug };
    }
  }

  // If issueNum was specified but not matched, don't fall back to mtime
  if (issueNum) return null;

  // Priority 3: Most recent by mtime (last resort)
  candidates.sort((a, b) => b.mtime - a.mtime);
  return { path: candidates[0].path, data: candidates[0].data, slug: candidates[0].slug };
}

export function extractIssueNumber(text: string): string | undefined {
  const match = text.match(/#(\d+)/);
  return match ? match[1] : undefined;
}
