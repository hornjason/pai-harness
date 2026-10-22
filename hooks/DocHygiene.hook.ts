#!/usr/bin/env bun
/**
 * DocHygiene.hook.ts — PostToolUse on Write + Edit, for `.md` files
 *
 * Governing SCs: SC-370 (traceability), SC-371 (thin trigger, under 150 lines)
 *
 * Stamps the four required frontmatter fields onto a markdown document that
 * is missing them, and reports a doc that is not indexed in DOCS.md.
 *
 * PORTABILITY (#713): the `.pai` copy carried its own 90-line copy of the
 * frontmatter parser and said so in its header — "Mirror of lib/frontmatter.ts
 * in rungate, which is where this is tested". That mirror is deleted here
 * rather than moved: this hook now calls `../lib/frontmatter`, which is the
 * binding the tests already drive, so the two cannot drift apart again. The
 * add-only stamping rule, the refusal to rewrite a block it cannot parse, and
 * the blank-line handling that #299 turned on are all that module's now.
 *
 * ONE DELIBERATE BEHAVIOUR CHANGE, recorded because it is not a file move:
 * the `.pai` copy treated a REQUIRED key present with an EMPTY value as
 * missing and overwrote it. `stampFrontmatter` leaves any key that is present
 * exactly as it is. The library's rule is the correct one — filling a gap is
 * this hook's job, having opinions about a value somebody wrote is not — and
 * it is the behaviour `test/rules-frontmatter.test.ts` already asserts.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, basename, join } from 'path';
import { stampFrontmatter } from '../lib/frontmatter';

const input = JSON.parse(readFileSync(0, 'utf-8'));
const toolInput = input?.tool_input || {};
const filePath: string = toolInput.file_path || '';

// ── Guard: only .md files
if (!filePath.endsWith('.md')) process.exit(0);

// ── Guard: skip excluded paths
// `/tmp/` and `~/.rungate/` hold markdown that is a PAYLOAD, not a document:
// GitHub issue bodies, PR bodies and comments, written to a file and handed to
// `--body-file`. Stamping a doc header on those publishes
// `doc-type: reference / owner: jason` as the first four lines of the issue,
// where it renders as literal text.
// `.claude/rules/mutations/` is the same shape as `.claude/agents/`: a
// committed, in-repo markdown class whose first line belongs to a different
// consumer than the doc index. A mutation record is identified by its one `# `
// heading, so a stamp there is not a missing field being filled in, it is a
// convention being broken one file at a time.
const SKIP_PATTERNS = [
  '/archive/',
  '/MEMORY/WORK/',
  '/.pai-work/',
  '/config/',
  '/test-results/',
  '.claude/worktrees/',
  '.claude/agents/',
  '.claude/rules/mutations/',
  '/tmp/',
  '/.rungate/',
];
if (SKIP_PATTERNS.some(p => filePath.includes(p))) process.exit(0);
if (basename(filePath) === 'PRD.md') process.exit(0);

const tag = `[doc-hygiene] ${basename(filePath)}`;

let content: string;
try {
  content = readFileSync(filePath, 'utf-8');
} catch {
  process.exit(0);
}

// ── Infer the values for any of the four that are absent
const fname = basename(filePath).toUpperCase();

function inferDocType(): string {
  if (filePath.includes('/adr/')) return 'adr';
  if (/RUNBOOK|SETUP|PLAYBOOK|ADDING/.test(fname)) return 'runbook';
  if (/ARCHITECTURE|PRINCIPLES|HERO-INSTALL/.test(fname)) return 'architecture';
  if (fname === 'BACKLOG.MD') return 'backlog';
  return 'reference';
}

const result = stampFrontmatter(content, {
  'doc-type': inferDocType(),
  status: 'active',
  owner: 'jason',
  updated: new Date().toISOString().slice(0, 10),
});

if (result.refused) {
  // Unreadable block. Leave it exactly as it is — rewriting one you cannot
  // read is what #299 was.
  console.log(`${tag} — ${result.refused}`);
  checkDocsIndex(filePath, tag);
  process.exit(0);
}

if (result.stamped.length > 0) {
  try {
    writeFileSync(filePath, result.content, 'utf-8');
    console.log(`${tag} — auto-stamped header (${result.stamped.join(', ')})`);
  } catch {
    console.log(`${tag} — could not auto-stamp header (write failed)`);
  }
}

// ── Check DOCS.md index coverage
checkDocsIndex(filePath, tag);

function checkDocsIndex(fp: string, t: string): void {
  // Walk up from the file to find DOCS.md at the project root
  let dir = dirname(fp);
  let docsIndex: string | null = null;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'DOCS.md');
    if (existsSync(candidate)) {
      docsIndex = candidate;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (!docsIndex) return;

  const name = basename(fp);
  try {
    if (!readFileSync(docsIndex, 'utf-8').includes(name)) {
      console.log(`${t} — not in DOCS.md index (add a row if this is a permanent doc)`);
    }
  } catch {
    // DOCS.md unreadable — skip silently
  }
}
