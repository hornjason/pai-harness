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
 * An input this cannot READ is refused for the same reason and said out loud:
 * a command that is absent, or not a string, has not been examined and found
 * clean. See `unreadableMessage`, and the `|| ''` it replaced.
 *
 * ## KNOWN FALSE REFUSALS — the direction this is allowed to be wrong in
 *
 * A `#` comment is not parsed. `ls # cd /tmp` is allowed because `ls` is the
 * segment's first token, but a comment carrying a separator —
 * `make # fails; cd /x is not the fix` — splits and the tail reads as a
 * top-level `cd`. Both forms are asserted in `test/top-level-cd.test.ts`.
 *
 * Stripping comments would fix it and was deliberately not done: a `#` inside
 * `$(…)` on one line comments out the closing paren, so a stripper unbalances
 * the depth counter and a later top-level `cd` falls INSIDE the unclosed
 * subshell and is allowed. That trades a rare false refusal for a new
 * false-allow path, which is the wrong direction.
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

/**
 * THE refusal exit, declared once.
 *
 * `hooks/TopLevelCdGuard.hook.ts` emits this as its `decision` and has no
 * literal of its own, so there is exactly one site to mutate and a case that
 * observes a refusal can be proved to have observed THIS one
 * (`.claude/rules/checks-must-be-able-to-fail.md`, *For a script whose job is
 * to exit non-zero*). A second inlined `'block'` anywhere in the hook would
 * survive the mutation and the case would go green having witnessed nothing —
 * `test/top-level-cd.test.ts` asserts the literal appears exactly once.
 */
export const CD_GUARD_DECISION = 'block';

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
 * What the caller is told when the command could not be read at all.
 *
 * A Bash tool call always carries a command string. If one arrives without
 * one, the guard has not examined a command and found it clean — it has
 * examined nothing, and `0`, `{}`, `null` and silence are indistinguishable
 * from success (`.claude/rules/config-access.md`). The previous shape here
 * was `payload.tool_input?.command || ''`, which is that defect exactly: an
 * absent command became an empty one and the guard passed over it.
 */
function unreadableMessage(command: unknown): string {
  return [
    '#992: refusing a Bash command this guard could not read.',
    '',
    `Received: ${typeof command} ${JSON.stringify(command) ?? String(command)}`,
    '',
    'This is UNMEASURED, not clean. The guard refuses a top-level `cd`, and it',
    'cannot tell whether this command carries one, so it refuses rather than',
    'reporting a pass it did not earn.',
    '',
    'Re-send the call with a command string. If a Bash call legitimately has',
    'no command, that is a bug in the caller, not in this guard.',
  ].join('\n');
}

/**
 * Does this command move the session's working directory at the top level?
 *
 * Returns the refusal, or null when the command is clean. THE one decider:
 * every caller — the hook, any future grader — asks this and nothing else.
 *
 * Takes `unknown` deliberately. The hook's input is JSON off a pipe, so the
 * command's type is an assumption until it is checked, and the check belongs
 * with the decision rather than at the call site where a `|| ''` is one
 * keystroke away.
 */
export function topLevelCdRefusal(command: unknown): CdRefusal | null {
  if (typeof command !== 'string' || command.trim() === '') {
    return { segment: '<unreadable>', message: unreadableMessage(command) };
  }

  for (const segment of topLevelSegments(stripHeredocBodies(command))) {
    const name = firstCommandName(segment);
    if (name === null) continue;
    if (!SHELL_MOVERS.has(name)) continue;
    const trimmed = segment.trim();
    return { segment: trimmed, message: refusalMessage(trimmed) };
  }
  return null;
}

/**
 * How loudly the guard speaks: the WARN→data→FAIL ladder
 * `specs/harness-automation-matrix.md` prescribes (#992).
 *
 * ## Why a mode exists at all, with the number that decided it
 *
 * The parser is sound: **32.7% of 31,577 unique Bash commands** from this
 * machine's transcript store since 2026-10-14 would be refused, with **zero
 * false positives** — all three deliberate over-refusal classes clean, a
 * 20-command spread hand-read and all 20 genuine, and the 245 `cd`-carrying
 * commands it allows are subshells and heredoc bodies.
 *
 * The issue's original cost model was *"a false refusal costs one retyped
 * command"*. At that rate it costs **10,332 retyped commands**, and a hook
 * refusing a third of all Bash calls is the gets-disabled failure the issue
 * itself warns about two paragraphs below its own recommendation. The
 * premise was corrected on the issue; this is the code catching up to the
 * correction.
 *
 * So `cd` is not an occasional lapse, it is the dominant navigation idiom,
 * and most instances are harmless — a top-level `cd` costs something only in
 * a session with concurrent agents holding worktrees.
 *
 * ## The default is `block`, and that is a decision, not a reading
 *
 * The paragraphs above are the argument for `warn` and they are left intact
 * because they are the honest case against what this now does. **Jason took
 * `block`** (#992), with the 32.7% in hand: the scoping to harnessed
 * projects is the answer to "mis-scoped rather than mis-tuned", and a rung
 * that costs a retype is preferred to one that costs a peer's half-day. The
 * first rung of the ladder exists and was skipped deliberately.
 *
 * `RUNGATE_CD_GUARD=warn` and `=off` are both still reachable, so reversing
 * this needs no code change — which is the property #1040 built the mode for.
 *
 * ## An unrecognised value is not silently a default
 *
 * It resolves to the default rung and the caller is TOLD which value it did
 * not understand. `0`, `{}` and silence being indistinguishable from success
 * is `.claude/rules/config-access.md`, and a typo'd
 * `RUNGATE_CD_GUARD=blcok` degrading quietly is that shape exactly. Note the
 * direction moved with the default: an unreadable value now refuses rather
 * than warns, which is the same "err toward refusal" this module takes
 * everywhere else.
 */
export type CdGuardMode = "warn" | "block" | "off";

/** The env var selecting the rung. Absent means `block` — see above. */
export const CD_GUARD_MODE_VAR = "RUNGATE_CD_GUARD";

/**
 * The rung taken when nothing selects one. Declared once so the decision is
 * a single site a mutation can move, and so `cdGuardMode`'s two default
 * paths — absent value and unrecognised value — cannot drift apart.
 */
export const CD_GUARD_DEFAULT_MODE: CdGuardMode = "block";

export interface CdGuardModeReading {
  mode: CdGuardMode;
  /** Set when the configured value was not recognised, naming it. */
  unrecognised?: string;
}

export function cdGuardMode(env: NodeJS.ProcessEnv = process.env): CdGuardModeReading {
  const raw = env[CD_GUARD_MODE_VAR];
  if (raw === undefined || raw === "") return { mode: CD_GUARD_DEFAULT_MODE };
  const v = raw.trim().toLowerCase();
  if (v === "warn" || v === "block" || v === "off") return { mode: v };
  return { mode: CD_GUARD_DEFAULT_MODE, unrecognised: raw };
}
