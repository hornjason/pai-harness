#!/usr/bin/env bun
/**
 * One GitHub operation, performed over Octokit, for workflow agent steps (#137).
 *
 * ## Why this exists
 *
 * `GITHUB-API-MIGRATION-SPEC.md` describes two layers: `mcp__github__*` in
 * agent prompts, Octokit in TypeScript. The prompt layer has never worked in
 * this harness, and the run that found it said so plainly — `ToolSearch` for
 * `mcp__github__add_issue_comment` returned nothing, so `finalize` posted no
 * comment and the run still reported SHIPPED. Two independent reasons, either
 * one sufficient:
 *
 *  1. No role in `.claude/rungate/roles.json` grants `mcp__github__*`, and a
 *     workflow subagent gets the tools its role names.
 *  2. The server `.mcp.json` points at — `@modelcontextprotocol/server-github`
 *     — is deprecated on npm ("Package no longer supported") and does not
 *     connect here, so the tools do not exist for any agent, role or not.
 *
 * The spec's answer to an unavailable MCP server is D-7, an Octokit fallback,
 * with the constraint that it live at the orchestrator level rather than
 * inline in a prompt. It was never built. It also cannot be built where the
 * constraint literally says: `workflows/ship.js` runs in a sandbox with no
 * module loading and no filesystem (#69), so the orchestrator cannot call
 * Octokit itself.
 *
 * So the fallback is a script, invoked from a workflow step the same way
 * `collect-worktree-files.ts` is. The agent runs one command and reports the
 * outcome; the decision of what to send is this script's, in a process that
 * can import `lib/github.ts`. No second copy of the API logic exists to drift.
 *
 * ## Contract
 *
 * One JSON object on stdout, diagnostics on stderr, exit 0 on success and 1 on
 * failure. Callers that need the result parse stdout; callers that only need
 * "did it work" read the exit code. Every failure prints a reason — this
 * replaced a path whose failure mode was silence.
 *
 * Bodies come from a file rather than an argument. A PR body contains
 * newlines, backticks and quotes, and an agent assembling that into a shell
 * argument is how injection and truncation both happen.
 *
 * Usage:
 *   bun scripts/github-op.ts pr-upsert    --repo o/n --head B --base main --title T [--body-file F]
 *   bun scripts/github-op.ts comment      --repo o/n --issue N (--body-file F | --body S)
 *   bun scripts/github-op.ts issue-update --repo o/n --issue N [--state closed] [--body-file F]
 *   bun scripts/github-op.ts issue-label  --repo o/n --issue N --labels a,b
 *   bun scripts/github-op.ts issue-get    --repo o/n --issue N
 *   bun scripts/github-op.ts issue-create --repo o/n --title T [--body-file F] [--labels a,b]
 */

import { readFileSync } from "fs";
import {
  addComment,
  addLabels,
  createGitHubClient,
  createIssue,
  getIssue,
  updateIssue,
  upsertPR,
} from "../lib/github";

export type Flags = Record<string, string>;

/**
 * `--name value` and `--name=value`, nothing else.
 *
 * Deliberately strict: an unrecognised shape is an error rather than a
 * silently ignored argument. The caller is a language model assembling a
 * command line, and the failure this script replaced was a GitHub write that
 * quietly did not happen.
 */
export function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument "${arg}" — every option is --name value`);
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    flags[arg.slice(2)] = value;
  }
  return flags;
}

function required(flags: Flags, name: string): string {
  const v = flags[name];
  if (v === undefined || v === "") throw new Error(`--${name} is required`);
  return v;
}

/**
 * A title, from `--title` or `--title-file`.
 *
 * The file form exists for the same reason `--body-file` does: a title
 * assembled from a spec heading or an issue is text this process did not
 * write, and routing it through a shell argument is how a quote in it becomes
 * a command. Trimmed to one line, because a multi-line title is always a
 * quoting accident rather than an intention.
 */
function titleFrom(flags: Flags): string {
  if (flags["title-file"] !== undefined) {
    const text = readFileSync(flags["title-file"], "utf-8").split("\n")[0].trim();
    if (!text) throw new Error(`--title-file ${flags["title-file"]} has no title on its first line`);
    return text;
  }
  return required(flags, "title");
}

function issueNumber(flags: Flags): number {
  const raw = required(flags, "issue");
  const n = Number(raw);
  // `parseInt` would accept "12abc" and the write would land on #12. An issue
  // number arriving malformed means the caller built the command wrong, and
  // guessing which issue they meant is the one thing worse than failing.
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--issue must be a positive integer, got "${raw}"`);
  return n;
}

/**
 * The body text, from `--body-file` or `--body`.
 *
 * `allowEmpty` separates "the caller said nothing about the body" from "the
 * caller asked for an empty one" — a comment with no text is a mistake, a PR
 * description with no text is not.
 */
export function readBody(flags: Flags, { allowEmpty }: { allowEmpty: boolean }): string | undefined {
  if (flags["body-file"] !== undefined) {
    const text = readFileSync(flags["body-file"], "utf-8");
    if (!allowEmpty && !text.trim()) throw new Error(`--body-file ${flags["body-file"]} is empty`);
    return text;
  }
  if (flags.body !== undefined) {
    if (!allowEmpty && !flags.body.trim()) throw new Error("--body is empty");
    return flags.body;
  }
  if (allowEmpty) return undefined;
  throw new Error("--body-file or --body is required");
}

function labels(flags: Flags): string[] {
  return (flags.labels ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

export const COMMANDS = [
  "pr-upsert",
  "comment",
  "issue-update",
  "issue-label",
  "issue-get",
  "issue-create",
] as const;

export type Command = (typeof COMMANDS)[number];

export async function run(command: string, flags: Flags): Promise<unknown> {
  if (!(COMMANDS as readonly string[]).includes(command)) {
    throw new Error(`unknown command "${command}" — one of: ${COMMANDS.join(", ")}`);
  }
  const client = createGitHubClient();
  const repo = required(flags, "repo");

  switch (command as Command) {
    case "pr-upsert": {
      // `--title-from-issue N` composes "fix(#N): <the issue's title>" HERE,
      // from the API, rather than having the caller interpolate the title
      // into a command line. An issue title is attacker-supplied text —
      // anyone who can file an issue picks it — and a workflow prompt that
      // embeds it inside `--title "fix(#N): ${title}"` hands a shell
      // `"; curl … #` the moment someone files an issue titled that way.
      // The title then never crosses a shell at all.
      const fromIssue = flags["title-from-issue"];
      let title: string;
      if (fromIssue !== undefined) {
        if (flags.title !== undefined || flags["title-file"] !== undefined) {
          throw new Error("--title-from-issue cannot be combined with --title or --title-file");
        }
        const n = Number(fromIssue);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`--title-from-issue must be a positive integer, got "${fromIssue}"`);
        }
        const issue = await getIssue(client, flags["issue-repo"] || repo, n);
        title = `fix(#${n}): ${issue.title}`;
      } else {
        title = titleFrom(flags);
      }
      return await upsertPR(client, repo, {
        head: required(flags, "head"),
        base: flags.base || "main",
        title,
        body: readBody(flags, { allowEmpty: true }),
      });
    }

    case "comment": {
      const data = await addComment(client, repo, issueNumber(flags), readBody(flags, { allowEmpty: false })!);
      return { id: data.id, html_url: data.html_url };
    }

    case "issue-update": {
      const state = flags.state;
      if (state !== undefined && state !== "open" && state !== "closed") {
        throw new Error(`--state must be open or closed, got "${state}"`);
      }
      const body = readBody(flags, { allowEmpty: true });
      if (state === undefined && body === undefined) {
        throw new Error("issue-update needs --state or a body to change");
      }
      const data = await updateIssue(client, repo, issueNumber(flags), {
        ...(state ? { state } : {}),
        ...(body !== undefined ? { body } : {}),
      });
      return { number: data.number, state: data.state };
    }

    case "issue-label": {
      const names = labels(flags);
      if (names.length === 0) throw new Error("--labels is required and must name at least one label");
      // addLabels is POST, which appends (D-5). PATCH with a labels array
      // would replace the set and drop whatever triage had put there.
      const data = await addLabels(client, repo, issueNumber(flags), names);
      return { labels: (data || []).map((l: any) => (typeof l === "string" ? l : l.name)) };
    }

    case "issue-get": {
      const data = await getIssue(client, repo, issueNumber(flags));
      return {
        number: data.number,
        title: data.title,
        body: data.body,
        state: data.state,
        labels: (data.labels || []).map((l: any) => (typeof l === "string" ? l : l.name)),
      };
    }

    case "issue-create": {
      const data = await createIssue(client, repo, {
        title: titleFrom(flags),
        body: readBody(flags, { allowEmpty: true }),
        labels: labels(flags),
      });
      return { number: data.number, html_url: data.html_url };
    }
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) {
    console.error(`usage: bun scripts/github-op.ts <${COMMANDS.join("|")}> --repo owner/name ...`);
    process.exit(1);
  }
  try {
    const result = await run(command, parseFlags(rest));
    console.log(JSON.stringify(result));
  } catch (e: any) {
    // The message can carry a request URL; scrubbing happens at the hook
    // boundary, and here the output goes to a workflow log the operator reads.
    console.error(`github-op ${command} FAILED: ${e?.message || e}`);
    process.exit(1);
  }
}

if (import.meta.main) await main();
