import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';

export const WORK_DIR = join(process.env.HOME!, '.pai-work');
export const HARNESS_ROOT = process.env.HARNESS_ROOT || join(process.env.HOME!, 'Projects', 'pai-harness');

export interface HookInput {
  tool_name?: string;
  tool_input?: { command?: string; name?: string; subagent_type?: string; prompt?: string; [k: string]: unknown };
  tool_response?: { output?: string; content?: string; [k: string]: unknown } | string;
  session_id?: string;
  [k: string]: unknown;
}

export async function parseHookInput(timeoutMs = 2000): Promise<HookInput | null> {
  try {
    const raw = await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    if (!raw?.trim()) return null;
    return JSON.parse(raw) as HookInput;
  } catch { return null; }
}

const AGENT_CONFIG: Record<string, { match: string[]; exclude: string[] }> = {
  marcus: { match: ['marcus', 'engineer', 'marcus webb'], exclude: ['council'] },
  quinn: { match: ['quinn', 'qatester', 'quinn torres'], exclude: [] },
  rook: { match: ['rook', 'pentester', 'rook blackburn'], exclude: [] },
};

export function detectAgent(toolInput: { name?: string; subagent_type?: string; prompt?: string }): { key: string; name: string } | null {
  const name = (toolInput.name || '').toLowerCase();
  const type = (toolInput.subagent_type || '').toLowerCase();
  const prompt = (toolInput.prompt || '').toLowerCase();
  for (const [key, cfg] of Object.entries(AGENT_CONFIG)) {
    if (cfg.exclude.some(ex => prompt.includes(ex))) continue;
    if (cfg.match.some(p => name.includes(p) || type === p || prompt.includes(p)))
      return { key, name: toolInput.name || key };
  }
  return null;
}

export interface WorkflowResult { path: string; data: any; slug: string }

export function findWorkflowState(issueNum?: string, phases?: string[]): WorkflowResult | null {
  if (!existsSync(WORK_DIR)) return null;
  const validPhases = phases || ['BUILD', 'VERIFY', 'SCOPE', 'SHIP', 'DONE'];
  const candidates: (WorkflowResult & { mtime: number })[] = [];

  const collect = (wfPath: string, slug: string) => {
    if (!existsSync(wfPath)) return;
    try {
      const data = JSON.parse(readFileSync(wfPath, 'utf-8'));
      if (!validPhases.includes(data.phase)) return;
      candidates.push({ path: wfPath, data, slug, mtime: statSync(wfPath).mtimeMs });
    } catch {}
  };

  try {
    for (const d of readdirSync(WORK_DIR, { withFileTypes: true }).filter(d => d.isDirectory())) {
      collect(join(WORK_DIR, d.name, 'workflow-state.json'), d.name);
      try {
        for (const sd of readdirSync(join(WORK_DIR, d.name), { withFileTypes: true }).filter(sd => sd.isDirectory()))
          collect(join(WORK_DIR, d.name, sd.name, 'workflow-state.json'), `${d.name}/${sd.name}`);
      } catch {}
    }
  } catch {}

  if (!candidates.length) return null;
  if (issueNum) {
    const match = candidates.find(c => String(c.data.issue) === issueNum);
    return match ? { path: match.path, data: match.data, slug: match.slug } : null;
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return { path: candidates[0].path, data: candidates[0].data, slug: candidates[0].slug };
}

export function extractIssueNumber(text: string): string | undefined {
  return text.match(/#(\d+)/)?.[1];
}
