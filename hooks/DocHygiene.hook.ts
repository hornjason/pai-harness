#!/usr/bin/env bun
/**
 * DocHygiene.hook.ts — PostToolUse on Write + Edit, for `.md` files
 *
 * Governing SCs: SC-370 (traceability), SC-371 (thin trigger, under 150 lines)
 *
 * Stamps the three INFERABLE frontmatter fields onto a markdown document that
 * is missing them, and reports a doc that is not indexed in DOCS.md.
 * `owner:` is deliberately not among them (#1119) — see the stamp call.
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
import { localCalendarDay } from '../lib/local-calendar-day';

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
//
// EVERY ENTRY NAMES A CLASS OF MARKDOWN, NOT A PLACE TO WORK (#1432).
// `.claude/worktrees/` was here and is gone. It was the one entry that named
// a CHECKOUT rather than a content class, and it arrived with the #713
// migration (83385d17) carrying no stated reason — the comment above argues
// for four of the other entries and never reached it.
//
// It cost the hook most of its input. A doc in a worktree is on its way to
// `main`: it is the same file it will be after the merge, and the worktree is
// the only place this hook could stamp it before it is committed. Measured on
// this machine, 152 of 266 registered worktrees sat under that prefix, and of
// the docs on `main` that transcripts show were only ever written from such a
// path, 50% were missing at least one of the three fields against 14.1% for
// docs only ever written from a plain checkout.
//
// Removing it is narrow because every remaining entry is a SUBSTRING test: a
// `.claude/agents/` or `.claude/rules/mutations/` file nested inside a
// worktree checkout is still skipped by its own entry, and markdown that is a
// payload still goes to `/tmp/` or `~/.rungate/` wherever it is written from.
// `test/product-hook-migration.test.ts` asserts both halves.
//
// There is no walk here to make expensive, which is the usual reason a
// worktree prefix is excluded in this repo (`specs/SCAFFOLD-DECOMPOSITION-SPEC.md`
// records a scan that `.claude/worktrees/` took to twelve seconds). This hook
// is handed one path and tests it against this list. Measured cost of the
// change: +10 ms per markdown write that previously exited here.
const SKIP_PATTERNS = [
  '/archive/',
  '/MEMORY/WORK/',
  '/.pai-work/',
  '/config/',
  '/test-results/',
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

// #1119. No `owner:`, and no config key behind it. It was the literal
// `'jason'`, writing this repo's owner into a consumer's documents. The keys
// below are INFERRED from the document or the clock, which is what makes them
// safe to invent; an owner is not, so the honest stamp is none. A configured
// default is the same defect with a longer supply chain, and nothing
// downstream reads the key. Add-only (#299) leaves a declared owner alone.
const result = stampFrontmatter(content, {
  'doc-type': inferDocType(),
  status: 'active',
  // #600. `updated:` is the day the author edited the document, which is a
  // LOCAL calendar day — not a UTC one. The raw spelling this replaces was
  // wrong for the four hours a day when the two disagree, and the stamp that
  // results is written, committed and then read as a date by everything
  // downstream. `localCalendarDay` is the one binding for this question, and
  // its own docstring names `updated:` frontmatter as the case it exists for.
  updated: localCalendarDay(),
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
