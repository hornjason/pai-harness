/**
 * top-level-cd.ts — the decision behind TopLevelCdGuard (#992)
 *
 * One question: does this Bash command move the SESSION's working directory?
 *
 * `topLevelCdRefusal` is the only exported binding and the only decider, so
 * there is one thing to mutate and one thing for a later caller to reuse —
 * the grader, a conformity check, a transcript audit. A second copy of this
 * parse anywhere would survive any mutation of this one and both would read
 * as covered (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
 *
 * ## Why the question is "top level" and not "anywhere"
 *
 * A Bash tool call runs in a shell whose cwd PERSISTS between calls, and the
 * agent runtime resolves `isolation: 'worktree'` against that directory. So a
 * `cd` at the top level of one call can kill a peer agent's worktree creation
 * hours later, and the failure names the session's directory rather than the
 * command that moved it. A `cd` inside a subshell, a command substitution or
 * a child interpreter cannot do that: the child exits and the parent's cwd is
 * untouched.
 *
 * ## The direction this is allowed to be wrong in
 *
 * Toward REFUSAL. A false refusal costs one retyped command and teaches the
 * habit; a false allow costs another agent half a day. Three forms are
 * refused that bash would in fact fork — a pipeline element, a backgrounded
 * command, and `exec cd` — because distinguishing them needs the shell's own
 * semantics and the saving is one retype.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * Every form below moves the session and is NOT refused. They are asserted as
 * cases in `test/top-level-cd.test.ts` under AC-10, not merely listed here, so
 * a later widening that closes one goes red rather than silently changing the
 * behaviour of every session on the machine.
 *
 * - `eval "cd /x"` — the command is a string until the shell expands it.
 * - `CMD=cd; $CMD /x` — a command built from a variable. The hook has no
 *   access to shell state and cannot know what `$CMD` holds.
 * - A heredoc body sourced into the current shell (`source /dev/stdin <<EOF`).
 *   Heredoc bodies are stripped before the scan because they are data in
 *   every other case, and `cat <<EOF` carrying the word `cd` was a real false
 *   positive in the sibling guard (`lib/bash-file-read.ts`).
 * - A function defined and called in one command: `goto() { cd "$1"; }; goto /x`.
 * - A zsh function or alias from the user's rc — the token is not `cd` and
 *   nothing in the command says what it expands to.
 * - A sourced script that cds: `. ./setup.sh`, `source ./setup.sh`.
 * - A `trap 'cd /x' EXIT` body, which is quoted now and run later.
 *
 * Closing any of these needs a real shell parser plus the shell's runtime
 * state. This is a habit-former, not a sandbox.
 *
 * Issue: #992
 */

export interface CdRefusal {
  /** The top-level segment that moves the shell, trimmed. */
  segment: string;
  /** What the caller is told, naming the alternatives. */
  message: string;
}

/** Builtins that move the shell's own working directory. */
const SHELL_MOVERS = new Set(['cd', 'pushd', 'popd']);

/**
 * Wrappers that delegate to the real command. `command cd /x` and
 * `builtin cd /x` both run the builtin. `exec`, `time` and `nohup` are here
 * for the refusal direction: they would not in fact move the parent, and
 * refusing them costs one retype.
 */
const PREFIXES = new Set(['command', 'builtin', 'exec', 'time', 'nohup']);

/**
 * Shell keywords that can be immediately followed by a command which runs in
 * the CURRENT shell. `{ … }` is a group, not a subshell — it is in this list
 * deliberately, and `(` is deliberately not.
 */
const LEADING_KEYWORDS = new Set([
  'if', 'then', 'elif', 'else', 'fi',
  'while', 'until', 'do', 'done',
  '{', '}', '!',
]);

/** An inline `VAR=value` assignment preceding the command. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Remove heredoc bodies before scanning. A heredoc body is data, and the hook
 * sees the raw command string, so `cat <<EOF > f … cd /x … EOF` would
 * otherwise read as a top-level `cd` on its own line.
 *
 * Unlike `lib/bash-file-read.ts` this drops the body even when the feeding
 * command is a shell interpreter, because `bash <<EOF` runs the body in a
 * CHILD and cannot move the session. The one form that can — `source
 * /dev/stdin <<EOF` — is a declared gap above.
 */
function stripHeredocBodies(command: string): string {
  if (!command.includes('<<')) return command;

  const out: string[] = [];
  let delim: string | null = null;
  let allowIndent = false;

  for (const line of command.split('\n')) {
    if (delim !== null) {
      if ((allowIndent ? line.trimStart() : line) === delim) delim = null;
      continue; // drop body and terminator
    }

    const m = line.match(/<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/);
    if (m) {
      allowIndent = m[1] === '-';
      delim = m[3];
      out.push(line.slice(0, m.index) + line.slice(m.index! + m[0].length));
      continue;
    }

    out.push(line);
  }

  return out.join('\n');
}

/**
 * Split a command into the segments that run in the CURRENT shell.
 *
 * Quote-, paren- and backtick-aware by necessity. A naive split tears quoted
 * strings apart (`git commit -m "cd into /x"` would yield a bogus `cd into
 * /x"` segment) and, worse, cannot tell `(cd /x && make)` from `cd /x &&
 * make` — which is the whole distinction this module exists for.
 *
 * Text inside `(` … `)`, `$(` … `)` and backticks is a child process, so no
 * split happens there and the enclosing segment keeps its own first token:
 * `(cd /x && make)` is one segment beginning `(cd`, which is not `cd`.
 *
 * This is deliberately NOT `splitSegments` from `lib/bash-file-read.ts`.
 * That one answers a question where depth is irrelevant — a `cat` reading a
 * file reads it in a subshell too — so it tracks quotes and nothing else.
 */
function topLevelSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let depth = 0;
  let backtick = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) current += command[++i];
      else if (ch === quote) quote = null;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === '\\' && i + 1 < command.length) {
      current += ch + command[++i];
      continue;
    }

    if (ch === '`') {
      backtick = !backtick;
      current += ch;
      continue;
    }

    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);

    if (depth === 0 && !backtick && (ch === '|' || ch === '&' || ch === ';' || ch === '\n')) {
      if ((ch === '|' || ch === '&') && command[i + 1] === ch) i++; // consume || and &&
      segments.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  segments.push(current);
  return segments;
}

/**
 * Resolve a token to the command name it invokes: quotes off, escapes off,
 * directory off. `'cd'`, `\cd` and `/usr/bin/cd` all resolve to `cd`.
 */
function commandName(token: string): string {
  let t = token;
  if (t.length > 1 && (t[0] === "'" || t[0] === '"') && t[t.length - 1] === t[0]) {
    t = t.slice(1, -1);
  }
  t = t.replace(/\\/g, '');
  return t.split('/').pop() || t;
}

/** Drop leading keywords, wrapper prefixes and inline assignments. */
function firstCommandName(segment: string): string | null {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  for (const raw of tokens) {
    if (ASSIGNMENT.test(raw)) continue;
    const name = commandName(raw);
    if (LEADING_KEYWORDS.has(name) || PREFIXES.has(name)) continue;
    return name;
  }
  return null;
}

/**
 * The refusal text. It names `git -C <path>` and the subshell form, because a
 * refusal that does not say what to do instead gets worked around rather than
 * obeyed — which is how this started as prose and ended as a hook.
 */
function refusalMessage(segment: string): string {
  return [
    '#992: refusing a top-level `cd`.',
    '',
    `Offending segment: ${segment}`,
    '',
    'A top-level `cd` moves the SESSION\'s working directory, not just this',
    'command\'s. Worktree isolation resolves against that directory, so a peer',
    'agent\'s worktree creation dies hours later with no error naming the cause.',
    '',
    'Use one of these instead:',
    '  git -C <path> <subcommand>       — for anything git, always',
    '  (cd <path> && <command>)         — a subshell; the session does not move',
    '  bun --cwd <path> <args>          — bun',
    '  make -C <path> / npm --prefix <path>',
    '',
    'If the session really must move, that is a deliberate decision — say so',
    'out loud rather than reaching for `cd` by reflex.',
  ].join('\n');
}

/**
 * Does this command move the session's working directory at the top level?
 *
 * Returns the refusal, or null when the command is clean. THE one decider:
 * every caller — the hook, any future grader — asks this and nothing else.
 */
export function topLevelCdRefusal(command: string): CdRefusal | null {
  for (const segment of topLevelSegments(stripHeredocBodies(command))) {
    const name = firstCommandName(segment);
    if (name === null) continue;
    if (!SHELL_MOVERS.has(name)) continue;
    const trimmed = segment.trim();
    return { segment: trimmed, message: refusalMessage(trimmed) };
  }
  return null;
}
