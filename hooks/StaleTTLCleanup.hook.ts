#!/usr/bin/env bun
/**
 * StaleTTLCleanup.hook.ts — Auto-cleanup stale workflow-state.json and .ship-active files (#256, #270)
 *
 * SC-370 (HOOK-ARCHITECTURE-SPEC): Hook SC traceability
 * SC-371 (HOOK-ARCHITECTURE-SPEC): No hook exceeds 150 lines
 *
 * TRIGGER: SessionStart
 *
 * Enforces 4h TTL on ship artifacts, 7d hard TTL on active phases.
 * Thin trigger: delegates to lib/stale-cleanup.ts. Issue: #544
 */

import { existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import { cleanStaleFiles } from '../lib/stale-cleanup';
import { repoRootFrom } from '../lib/paths';

const PAI_WORK = process.env.RUNGATE_WORK_DIR || process.env.PAI_WORK_DIR || join(process.env.HOME!, '.rungate');
const STALE_LOG = join(process.env.HOME!, '.claude', 'state', 'stale-cleanup.log');
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

if (!existsSync(PAI_WORK)) process.exit(0);

const timestamp = new Date().toISOString();
function log(msg: string): void {
  try { appendFileSync(STALE_LOG, `${timestamp} ${msg}\n`); } catch {}
}

// Core cleanup
const result = cleanStaleFiles(PAI_WORK, FOUR_HOURS_MS, SEVEN_DAYS_MS);
let deletedCount = result.deleted;
for (const msg of result.logs) log(msg);

// Resolve the project root ONCE from the repo, not from wherever the terminal
// happened to be (#68). A session opened in ~ used to skip worktree cleanup
// entirely while still reporting success.
const PROJECT_ROOT = repoRootFrom(process.cwd());
if (!PROJECT_ROOT) log('cleanup skipped: cwd is not inside a git repository');

// Worktree cleanup
if (PROJECT_ROOT) try {
  const { cleanupWorktrees } = await import('../lib/worktree-cleanup.ts');
  const projectRoot = PROJECT_ROOT;
  if (existsSync(join(projectRoot, '.claude', 'worktrees'))) {
    const wr = await cleanupWorktrees({ projectRoot, maxAgeMs: 24 * 60 * 60 * 1000 });
    if (wr.removed.length) {
      deletedCount += wr.removed.length;
      log(`WORKTREE cleanup [${projectRoot}]: removed ${wr.removed.length} stale worktrees`);
    }
  }
} catch (e) { log(`WORKTREE cleanup error: ${e}`); }

// Scratch cleanup — test fixtures the suite leaked into the repo root (#437).
// Reported alongside worktree cleanup deliberately: both are resources created
// by tooling that only get cleaned on the happy path, and 34 of these
// accumulated because each one had to be found by eye.
if (PROJECT_ROOT) try {
  const { cleanupScratchDirs } = await import('../lib/scratch-cleanup.ts');
  // Gated on the directory the allowlist is derived FROM, the way the
  // worktree block is gated on `.claude/worktrees`. Without a `test/` there
  // is nothing to derive and nothing could be swept anyway — but a sweep
  // that runs with an empty allowlist and reports success is the shape this
  // repo keeps finding, so the skip is explicit rather than incidental.
  const sr = existsSync(join(PROJECT_ROOT, 'test'))
    ? cleanupScratchDirs({ repoRoot: PROJECT_ROOT })
    : { removed: [], kept: [], refused: [], errors: [] };
  if (sr.removed.length) {
    deletedCount += sr.removed.length;
    log(`SCRATCH cleanup [${PROJECT_ROOT}]: removed ${sr.removed.length} leaked test scratch dirs`);
  }
  for (const e of sr.errors) log(`SCRATCH cleanup error: ${e}`);
} catch (e) { log(`SCRATCH cleanup error: ${e}`); }

// Branch cleanup (#516, #1079). Thin trigger: lib/branch-cleanup.ts holds
// every decision. This arm issues `git push origin --delete`, the one
// irreversible thing this hook does and the only thing in it that reaches a
// remote, at EVERY SessionStart from the shared checkout — so it is DISARMED
// by default and signals nothing. Set RUNGATE_BRANCH_CLEANUP=1 to arm it.
//
// A disarmed arm and a run that could not resolve the repository both say so
// by name: zero deletions has three causes here and only one is a clean
// sweep. `.claude/rungate/hooks.json` names this arming and the #1079 slug
// refusal as the two things that must BOTH hold before this hook may be
// reconsidered for consumer deployment.
if (PROJECT_ROOT) try {
  const { runBranchCleanupArm } = await import('../lib/branch-cleanup.ts');
  const br = await runBranchCleanupArm({ projectRoot: PROJECT_ROOT, maxAgeDays: 7 });
  deletedCount += br.deleted;
  for (const line of br.lines) log(line);
} catch (e) { log(`BRANCH cleanup error: ${e}`); }

// Orphaned test-suite processes (#690). Thin trigger: lib/orphan-reaper.ts
// holds every decision. It is a READING by default and signals nothing —
// arming it is a deployment decision, not a code one, because this hook runs
// from the shared checkout at every SessionStart and a merge that armed it
// would arm it for every live peer at once. Set RUNGATE_REAP_ORPHANS=1 to
// signal; the log line is identical except that it says `armed`.
//
// The arming read is `armedFromEnv` and not an inline `===`, so there is one
// binding a case can drive over the values that must NOT arm it. A call site
// that stops passing it is itself a case — see test/orphan-reaper.test.ts.
let orphansSignalled = 0;
try {
  const { reapOrphans, reapReportLines, armedFromEnv } = await import('../lib/orphan-reaper.ts');
  const report = reapOrphans({ armed: armedFromEnv() });
  const candidates = report.decisions.length;
  orphansSignalled = report.signalled.length;
  // Silence is reserved for "nothing to say about any process". A reading
  // that could not be taken, and a reading with candidates in it, both go in
  // the log naming pids and reasons — "Cleaned up N" with nothing behind it
  // is what made #690 cost two days.
  if (report.reading === 'UNMEASURED' || candidates > 0) {
    for (const line of reapReportLines(report)) log(line);
  }
} catch (e) { log(`ORPHAN reap error: ${e}`); }

// Gap scan — drift detection
let gapWarns = 0;
if (PROJECT_ROOT) try {
  const { scanGaps } = await import('../lib/gap-scanner.ts');
  const projectRoot = PROJECT_ROOT;
  const gapResult = scanGaps(projectRoot, PAI_WORK);
  for (const r of gapResult.results) {
    if (r.status === 'WARN') {
      gapWarns++;
      log(`GAP ${r.check}: ${r.detail}`);
    }
  }
} catch (e) { log(`GAP scan error: ${e}`); }
// Stranded work (#1038): a push CREATES a ref where the branch arm destroys one.
let rescued = 0;
if (PROJECT_ROOT) try {
  const { rescueStrandedBranches, rescueReportLines } = await import('../lib/worktree-cleanup.ts');
  const rs = rescueStrandedBranches(PROJECT_ROOT); rescued = rs.pushed.length;
  for (const line of rescueReportLines(rs)) log(line);
} catch (e) { log(`STRANDED rescue error: ${e}`); }

const parts: string[] = [];
if (deletedCount > 0) parts.push(`${deletedCount} removed`);
if (orphansSignalled > 0) parts.push(`${orphansSignalled} orphaned processes signalled`);
if (gapWarns > 0) parts.push(`${gapWarns} gap warnings`);
if (rescued > 0) parts.push(`${rescued} stranded branch(es) pushed`);
if (parts.length > 0) {
  console.log(`Stale TTL cleanup: ${parts.join(', ')}`);
} else {
  console.log('Stale TTL cleanup: no stale files found');
}
