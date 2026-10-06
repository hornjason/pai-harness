import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';

export const WORK_DIR = join(process.env.RUNGATE_WORK_DIR || process.env.HOME!, '.rungate');
export const HARNESS_ROOT = process.env.HARNESS_ROOT || join(process.env.HOME!, 'Projects', 'rungate');

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

/**
 * The `owner/name` a `gh` command targets, or undefined if it names none.
 *
 * Split out of IssueCloseGuard (#140) so it can be tested without driving the
 * hook, and because HOOK-ARCHITECTURE-SPEC wants the logic in lib rather than
 * in the trigger.
 *
 * The previous pattern was `--repo\s+(\S+)`, which ran to the next space and
 * so captured whatever punctuation followed — `owner/name"}}'` when the close
 * appeared inside a nested shell string. The lookup then 404'd on the mangled
 * slug. That was harmless while the guard swallowed errors; now that an
 * unreadable label set blocks the close, a sloppy parse refuses legitimate
 * work. Match the slug's shape and stop.
 *
 * This parses a command string to infer what `gh` will do, which is a
 * differential by construction: anywhere the two disagree, the guard checks
 * one repository's labels and `gh` closes an issue in another. Three
 * disagreements were found by checking against the real binary rather than
 * assuming, and all three are closed here:
 *
 *   gh issue view 23 --repo a/pai-config --repo b/pai-harness  -> LAST wins
 *   gh issue view 23 -R b/pai-harness                          -> `-R` is a real alias
 *   GH_REPO=b/pai-harness gh issue view 23                     -> env is honoured
 *
 * The first was a guard bypass: taking the first occurrence let
 * `--repo unprotected/x --repo protected/y` be vetted against `unprotected/x`
 * and closed in `protected/y`.
 */
export function parseRepoSlug(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  // Global, and keep the last — `gh` lets a later flag override an earlier one.
  const matches = [...command.matchAll(/(?:--repo|-R)[\s=]+['"]?([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/g)];
  const explicit = matches.length ? matches[matches.length - 1][1] : undefined;
  // `gh` falls back to GH_REPO when no flag is given.
  const slug = explicit ?? env.GH_REPO?.trim();
  if (!slug) return undefined;

  // `[A-Za-z0-9._-]+` admits `.` and `..`, so `--repo ../..` parsed as a slug
  // and reached Octokit, which built `/repos/../../issues/N` and issued it —
  // the request normalises to a different endpoint entirely. Observed: the
  // guard answering "Not Found - https://docs.github.com/rest" for a crafted
  // `--repo`. A GET with the operator's own token is a small prize, but a
  // relative segment is never part of a real `owner/name`, so refuse it.
  const parts = slug.split("/");
  if (parts.length !== 2) return undefined;
  if (parts.some(seg => !seg || seg === "." || seg === ".." || !/^[A-Za-z0-9._-]+$/.test(seg))) {
    return undefined;
  }
  return slug;
}

/**
 * Strip credential-shaped substrings from text that is about to be printed.
 *
 * Hook output lands in transcripts and, downstream, in issue comments. An API
 * error can carry the request URL, and a base URL given as
 * `https://user:token@host` would put a secret somewhere durable. Cheap
 * insurance at the one place that prints an upstream error verbatim (#140).
 */
export function redactSecrets(text: string): string {
  return String(text)
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "$1[REDACTED]")
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, "//[REDACTED]@");
}
