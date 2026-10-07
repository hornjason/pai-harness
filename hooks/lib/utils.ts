import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

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
export type CloseTarget =
  | { kind: "none" }
  | { kind: "ambiguous"; reason: string }
  | { kind: "one"; issue: string; repo?: string };

/**
 * What a command closes, or a refusal to guess.
 *
 * Inferring a `gh` invocation by regex over an arbitrary shell string is a
 * parser differential by construction: wherever this disagrees with the shell
 * and with `gh`, the guard vets one issue's labels while another issue gets
 * closed. Three rounds of security review found three such disagreements in
 * three successive versions of this parser, which is the signal to stop
 * tightening the pattern and change what the pattern is FOR.
 *
 * So the parse no longer decides *what to check*. It decides *whether the
 * command is simple enough to check at all*. Anything with more than one
 * close, a command separator, a substitution, or a flag value this cannot
 * read literally is reported ambiguous, and the caller blocks. Detection
 * stays deliberately over-broad because its failure mode is now a refusal
 * rather than a wave-through.
 *
 * The bypass that forced this: `closeMatch` took the FIRST issue number while
 * the repo scan took the LAST slug, so
 *
 *     gh issue close 1 --repo unprotected/x; gh issue close 99 --repo protected/y
 *
 * vetted issue 1 against protected/y and closed 99 in it. No amount of
 * regex care fixes that class; refusing to answer does.
 */
/** A `gh issue close` anywhere in a segment, with nothing required after it. */
const GH_CLOSE = /\bgh\b.*?\bissue\b.*?\bclose\b/;

/**
 * The harness's own close path, added by #137.
 *
 * Moving workflow steps onto `scripts/github-op.ts` would otherwise have
 * walked every automated close straight around this guard — the detector
 * above looks for `gh`, and the new path is `bun scripts/github-op.ts
 * issue-update --issue N --state closed`. A control that stops applying to
 * the caller it was written for is worse than no control, because the report
 * still says it ran.
 */
const OP_CLOSE = /github-op\.ts\s+issue-update\b[^\n]*--state[\s=]+['"]?closed\b/;

const CLOSE_INVOCATION = new RegExp(`${GH_CLOSE.source}|${OP_CLOSE.source}`);

/** `https://github.com/owner/name/issues/123`, which `gh` accepts in place of a number. */
const ISSUE_URL = /https?:\/\/[^\s"'`]*?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/issues\/(\d+)/;

export function parseCloseTarget(command: string, env: NodeJS.ProcessEnv = process.env): CloseTarget {
  // Detection is deliberately loose and requires NOTHING after `close`. The
  // previous version demanded `close\s+(\d+)`, so `gh issue close --repo a/b 23`
  // — flag first, number last, which gh accepts — matched nothing, returned
  // "no close here", and the guard stepped aside entirely. A detector that
  // can under-match is a bypass; a detector that over-matches is at worst an
  // inconvenient refusal.
  if (!CLOSE_INVOCATION.test(command)) return { kind: "none" };

  const ambiguous = (reason: string): CloseTarget => ({ kind: "ambiguous", reason });

  // Indirection that cannot be resolved from the source text. `gh` acts on
  // the expanded command; we only ever see what was typed.
  if (/\$\(|`|\$\{/.test(command)) return ambiguous("a command substitution makes the target unreadable — run the close on its own");
  if (/\beval\b/.test(command)) return ambiguous("an eval makes the target unreadable — run the close on its own");

  // Split on separators rather than rejecting them outright, so an ordinary
  // `cd somewhere && gh issue close 23 --repo a/b` still gets vetted. Exactly
  // one segment may be closing an issue: two let the issue number from one be
  // paired with the repository from the other, which is the bypass that
  // prompted all of this.
  const closing = command.split(/[;|&\n]+/).filter(s => CLOSE_INVOCATION.test(s));
  if (closing.length !== 1) {
    return ambiguous(`${closing.length} issue closes in one command — run them separately so each can be checked`);
  }
  const segment = closing[0];

  // The github-op form is parsed on its own terms rather than squeezed
  // through the gh rules below. Its grammar is strictly `--flag value`, with
  // no positional issue number and no URL form, so none of the ambiguity the
  // gh path has to reason about exists here — and reusing those rules would
  // have been a fourth parser differential waiting to happen.
  if (OP_CLOSE.test(segment)) {
    // No GH_REPO fallback: scripts/github-op.ts requires --repo and does not
    // read the environment, so inheriting one here would vet a repository the
    // command is not going to touch.
    const repo = parseRepoSlug(segment, {} as NodeJS.ProcessEnv);
    if (!repo) {
      return ambiguous("github-op needs a literal --repo owner/name so the close can be checked");
    }
    // Last wins, matching the script's own flag parsing, where a repeated
    // flag overwrites the earlier value.
    const issues = [...segment.matchAll(/--issue[\s=]+['"]?([^\s'"]+)/g)];
    const last = issues.length ? issues[issues.length - 1][1] : undefined;
    if (!last || !/^\d+$/.test(last)) {
      return ambiguous("the --issue value is not a literal number — pass it literally so it can be checked");
    }
    return { kind: "one", issue: last, repo };
  }

  // A URL carries its own owner/name, which overrides --repo. If both are
  // present and disagree, we cannot tell which gh will use.
  const url = segment.match(ISSUE_URL);
  const flagRepo = parseRepoSlug(segment, env);
  if (url) {
    const urlRepo = `${url[1]}/${url[2]}`;
    if (flagRepo && flagRepo !== urlRepo) {
      return ambiguous("the issue URL and --repo name different repositories — pass one of them");
    }
    return { kind: "one", issue: url[3], repo: urlRepo };
  }

  // A flag is present but its value is not a literal slug (`--repo "$REPO"`).
  // Defaulting here would vet an entirely different repository.
  if (/(?:--repo|-R)[\s=]/.test(segment) && !flagRepo) {
    return ambiguous("the --repo value is not a literal owner/name — pass it literally so it can be checked");
  }

  // Prefer the number immediately after `close`, which is the ordinary form
  // and is unambiguous even when other digits appear in a comment body.
  const direct = segment.match(/\bclose\b\s+['"]?#?(\d+)\b/);
  if (direct) return { kind: "one", issue: direct[1], repo: flagRepo };

  // Otherwise gh is taking the number from somewhere later in the line. Only
  // act when exactly one candidate exists; guessing between several is how
  // the wrong issue gets vetted.
  const after = segment.slice(segment.search(/\bclose\b/));
  const numbers = [...new Set((after.match(/(?<![\w/.-])#?(\d+)\b/g) || []).map(n => n.replace("#", "")))];
  if (numbers.length === 1) return { kind: "one", issue: numbers[0], repo: flagRepo };
  return ambiguous(
    numbers.length === 0
      ? "no issue number could be read from the command — pass it directly after `close`"
      : `several numbers could be the issue (${numbers.join(", ")}) — put the issue number directly after \`close\``,
  );
}

export function parseRepoSlug(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  // Global, and keep the last — `gh` lets a later flag override an earlier one.
  const matches = [...command.matchAll(/(?:--repo|-R)[\s=]+['"]?([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/g)];
  const explicit = matches.length ? matches[matches.length - 1][1] : undefined;
  // `gh` falls back to GH_REPO when no flag is given.
  return validRepoSlug(explicit ?? env.GH_REPO?.trim());
}

/**
 * `owner/name`, or undefined if that is not what this is.
 *
 * `[A-Za-z0-9._-]+` admits `.` and `..`, so `--repo ../..` parsed as a slug and
 * reached Octokit, which built `/repos/../../issues/N` and issued it — the
 * request normalises to a different endpoint entirely. Observed: the guard
 * answering "Not Found - https://docs.github.com/rest" for a crafted `--repo`.
 * A GET with the operator's own token is a small prize, but a relative segment
 * is never part of a real `owner/name`, so refuse it.
 *
 * One implementation, because #143 added a second source of slugs (the git
 * remote) and two validators would mean the stricter one could be walked around
 * by arriving through the other door.
 */
function validRepoSlug(slug: string | undefined): string | undefined {
  if (!slug) return undefined;
  const parts = slug.split("/");
  if (parts.length !== 2) return undefined;
  if (parts.some(seg => !seg || seg === "." || seg === ".." || !/^[A-Za-z0-9._-]+$/.test(seg))) {
    return undefined;
  }
  return slug;
}

/**
 * The repository a close will act on, or undefined when it cannot be known.
 *
 * #143: the caller used to fall back to a literal `owner/name` — a DIFFERENT
 * repository from the one the harness ships. Issue numbers are per-repo, so a
 * close naming no repository was decided from the labels of an unrelated
 * issue: permitted when that issue was unlabelled, blocked when it happened to
 * carry p1-ship-next. Neither answer had anything to do with the issue being
 * closed.
 *
 * `gh` resolves an unqualified command against the working directory's remote,
 * so that is what is read here. When neither the command nor the remote yields
 * a slug there is nothing left to derive, and undefined means the caller must
 * refuse — the same rule parseCloseTarget already applies to a command it
 * cannot read: derive what can be derived, refuse what cannot, never guess.
 */
export function resolveRepo(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string | undefined {
  const named = parseRepoSlug(command, env);
  if (named) return named;
  // A flag or GH_REPO is present but unreadable. `gh` will act on whatever it
  // expands to, which is by definition not the directory's remote, so falling
  // back here would vet a repository the command is not going to touch.
  if (/(?:--repo|-R)[\s=]/.test(command) || env.GH_REPO?.trim()) return undefined;
  return gitRemoteSlug(cwd);
}

/**
 * `origin`'s `owner/name`, or undefined for anything that is not a GitHub
 * remote — another host, a bare path, a repo with no origin, a directory that
 * is not a repo at all. Derived rather than assumed, and refused rather than
 * approximated: inventing a slug out of a URL `gh` resolves differently is the
 * same class of wrong answer as the literal this replaced.
 *
 * execFileSync, not execSync: no shell, so the remote URL is never anywhere a
 * shell could read it. The timeout is there because this runs inside a
 * PreToolUse hook, where a wedged git would stall the caller's tool call.
 */
function gitRemoteSlug(cwd: string): string | undefined {
  let url: string;
  try {
    url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return undefined;
  }
  // Covers every form git accepts for GitHub: https://, ssh://, and the scp
  // shorthand `git@github.com:owner/name.git`.
  const m = url.match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/);
  return m ? validRepoSlug(`${m[1]}/${m[2]}`) : undefined;
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
