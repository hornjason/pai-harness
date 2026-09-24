#!/usr/bin/env bun
/**
 * PostCompact.hook.ts — PostCompact hook
 *
 * Re-injects critical rules after context window compaction.
 * Rules that survive compaction prevent agent drift in long sessions.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const HARNESS_ROOT = process.env.RUNGATE_HARNESS_ROOT || join(process.env.HOME!, 'Projects/rungate');
const PROJECT_ROOT = process.env.RUNGATE_PROJECT_ROOT || process.cwd();

function loadCriticalRules(): string[] {
  const rules: string[] = [];

  const claudeMd = join(PROJECT_ROOT, 'CLAUDE.md');
  if (existsSync(claudeMd)) {
    const content = readFileSync(claudeMd, 'utf-8');
    const rulesSection = content.match(/## Rules\n([\s\S]*?)(?=\n##|\n---|\Z)/);
    if (rulesSection) {
      const ruleLines = rulesSection[1].split('\n').filter(l => l.startsWith('- '));
      rules.push(...ruleLines.map(l => l.replace(/^-\s*/, '').replace(/\*\*/g, '')));
    }
  }

  const agentsMd = join(PROJECT_ROOT, 'AGENTS.md');
  if (existsSync(agentsMd)) {
    const content = readFileSync(agentsMd, 'utf-8');
    const rulesSection = content.match(/## Rules\n([\s\S]*?)(?=\n##|\Z)/);
    if (rulesSection) {
      const ruleLines = rulesSection[1].split('\n').filter(l => l.startsWith('- '));
      rules.push(...ruleLines.map(l => l.replace(/^-\s*/, '').replace(/\*\*/g, '')));
    }
  }

  return rules;
}

async function main() {
  const rules = loadCriticalRules();
  if (rules.length === 0) process.exit(0);

  const output = [
    '## Critical Rules (re-injected after context compaction)',
    '',
    ...rules.map((r, i) => `${i + 1}. ${r}`),
    '',
    'Read PROJECT-STATE.md for current priorities and context.',
  ];

  console.log(`<system-reminder>\n${output.join('\n')}\n</system-reminder>`);
  process.exit(0);
}

main();
