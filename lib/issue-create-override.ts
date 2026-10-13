/**
 * Whether a `gh issue create` may run during VERIFY, and why not (#365).
 *
 * `hooks/VerifyPhaseLock.hook.ts` asked the question in eight lines:
 *
 *     if (cmd.includes('--label') && cmd.includes('follow-up')) process.exit(0);
 *
 * That is not a test that a label argument equals `follow-up`. It is a test
 * that the string `follow-up` appears SOMEWHERE in the command, so
 *
 *     gh issue create --label bug --title "Fix the follow-up handler"
 *
 * bypasses the lock entirely while applying no override label at all. A
 * detector whose input is the whole command string cannot tell an argument
 * from a word in a title — shape two of
 * `.claude/rules/checks-must-be-able-to-fail.md`, pointed outward: the guard
 * is wider than the thing it guards.
 *
 * The same shape hid a second bypass one line down. `cmd.includes('gh issue
 * comment')` is unreachable for a plain comment, because the create check
 * above it has already exited — but it IS reachable for
 * `gh issue comment … && gh issue create …`, where the comment clause
 * exempts the create clause.
 *
 * ## The second defect is about the tracker, not the hook
 *
 * `follow-up` means "follow-up work from a shipped issue", and it was the
 * only override, so anything filed during VERIFY had to claim an origin it
 * did not have. On 2026-10-13 an external audit of two consumer projects
 * surfaced three consumer-blocking defects here; #362, #363 and #364 all
 * wear `follow-up` and not one of them is follow-up work from a shipped
 * issue. An agent filtering that label to find loose ends from recent ships
 * gets three unrelated results. `external-audit` exists for exactly that
 * origin and is accepted here.
 *
 * ## What this is, and what it is not
 *
 * Stated because two rounds of commit security review walked the parser
 * inward and a third would too. **This is workflow discipline over `gh`
 * invocations reaching PreToolUse on Bash. It is not a sandbox.** It exists
 * to catch a reflex — an agent mid-VERIFY reaching for `gh issue create`
 * when `verifyBlockers[]` is the right place — and a reflex is defeated by
 * saying no to the command shapes someone actually types.
 *
 * So the parser is held to ordinary shapes: operators with or without
 * surrounding whitespace, newlines, subshells, command substitution
 * including backticks, a path-qualified binary, quoted arguments, and
 * `-c` / `-lc` / `eval` wrappers. **Every one of those was a measured bypass
 * of an earlier version of this file**, and each has a row in
 * `test/verify-phase-lock.test.ts`.
 *
 * Out of scope ON PURPOSE, and not a gap to file:
 *
 * - `curl` against the REST API, or the GitHub MCP tools — neither is Bash,
 *   so the hook never sees them.
 * - `ssh host "gh issue create …"` — that runs on another machine against
 *   whatever repo it is configured for, and descending into every remote
 *   command mentioning `gh` buys false refusals, not safety.
 * - A caller who writes a script and runs it.
 *
 * Each of those takes a decision to get around the lock, and an agent that
 * has made that decision is a problem no matcher fixes. Chasing them trades
 * false refusals — which teach people to work around a guard — for
 * protection against someone already doing so.
 */

/** Labels that permit an issue to be filed mid-VERIFY, and what each means. */
export const OVERRIDE_LABELS: Record<string, string> = {
  "follow-up": "follow-up work from a shipped issue",
  "external-audit": "a defect found outside the ship loop",
};

/**
 * Shell operators that end one command and begin another.
 *
 * Emitted as their OWN tokens, which is the whole point. The first version
 * of this file split on whitespace alone, so `foo;gh issue create` and
 * `gh issue comment 1&&gh issue create` produced the tokens `foo;gh` and
 * `1&&gh` — and since those are not the word `gh`, `createsIssue` said no
 * and the lock allowed both. That is the same defect as the substring
 * matcher this file replaced, one layer in: a parser that disagrees with the
 * shell about where a command begins. Found by the commit security review,
 * not by me.
 *
 * A newline is in the list for the same reason. Without it,
 * `gh issue create --label follow-up` and `gh issue create --label bug` on
 * two lines are one clause, and the first line's override covers the second.
 *
 * Backticks are here for the same reason `(` and `)` are: they delimit a
 * command substitution, and without them `` `gh issue create` `` yields the
 * token `` `gh `` rather than `gh`.
 *
 * Longest first: `&&` must be tried before `&`, `||` before `|`.
 */
const OPERATORS = ["&&", "||", ";;", ";", "|", "&", "(", ")", "`", "\n"];

/**
 * Split a command the way a shell would, so an argument can be told from a
 * word inside a quoted string — and an operator from a word glued to one.
 *
 * Not a full shell parser and does not need to be: the only question is
 * where one command ends and the next begins, and which tokens are its
 * arguments. Unterminated quotes yield the rest of the string as one token,
 * which keeps a malformed command from splitting into things that look like
 * flags nobody wrote.
 */
export function tokenize(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  const flush = () => {
    if (started) out.push(cur);
    cur = "";
    started = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "\\" && quote !== "'" && i + 1 < cmd.length) {
      cur += cmd[++i];
      started = true;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    const op = OPERATORS.find(o => cmd.startsWith(o, i));
    if (op) {
      flush();
      out.push(op);
      i += op.length - 1;
      continue;
    }
    if (/\s/.test(c)) {
      flush();
      continue;
    }
    cur += c;
    started = true;
  }
  flush();
  return out;
}

const SEPARATORS = new Set(OPERATORS);

/**
 * The command list, one token array per clause, descending into `-c`.
 *
 * The recursion is why `echo 'gh issue create --label bug'` stays allowed
 * while `bash -c 'gh issue create --label bug'` does not. A quoted string is
 * data to `echo` and a command to a shell, and only the second one files an
 * issue. Refusing both would be the safer direction and the wrong one — a
 * guard that refuses commands which create nothing is a guard people learn
 * to work around.
 *
 * **There is deliberately no allowlist of shell names here.** The first
 * version had one — `sh`, `bash`, `zsh`, `dash`, `ksh`, `fish`, with the
 * program name resolved past any `VAR=value` prefix — and removing it
 * scored **0 red of 38**. No command could be written that the allowlist
 * decided: a non-shell interpreter's `-c` argument is source code, and
 * source code quotes the command it runs, so the inner text arrives as one
 * token and `createsIssue` needs three adjacent ones. `python3 -c
 * "print('gh issue create --label bug')"` is a table case and is allowed
 * with or without the allowlist. A branch no input can distinguish is a
 * branch that will be wrong silently, so it is gone rather than kept for
 * reassurance.
 */
export function clauses(cmd: string, depth = 0): string[][] {
  const flat: string[][] = [[]];
  for (const t of tokenize(cmd)) {
    if (SEPARATORS.has(t)) flat.push([]);
    else flat[flat.length - 1].push(t);
  }

  const out: string[][] = [];
  for (const c of flat) {
    if (c.length === 0) continue;
    out.push(c);
    if (depth >= 4) continue; // a wrapper chain this deep is not an accident
    for (const inner of commandArguments(c)) out.push(...clauses(inner, depth + 1));
  }
  return out;
}

/** Arguments of this clause that are themselves commands. */
function commandArguments(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (COMMAND_FLAG.test(t) || basename(t) === "eval") {
      if (i + 1 < tokens.length) out.push(tokens[i + 1]);
    }
  }
  return out;
}

/** The program a token names, ignoring any path it was reached by. */
const basename = (t: string) => t.split("/").pop()!;

/**
 * Does this clause invoke `gh issue create`?
 *
 * Compared on the basename, because `/usr/bin/gh issue create` and
 * `./gh issue create` are the same command and the first version of this
 * function allowed both.
 */
export function createsIssue(tokens: string[]): boolean {
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (basename(tokens[i]) === "gh" && tokens[i + 1] === "issue" && tokens[i + 2] === "create") {
      return true;
    }
  }
  return false;
}

/**
 * Flags whose next argument is a command string rather than data.
 *
 * `-c`, but also `-lc` and `-ic`: short flags combine, and only the last
 * letter takes the argument, so `sh -lc "…"` is a login shell running a
 * command. Both of those were allowed until the second security review.
 */
const COMMAND_FLAG = /^-[A-Za-z]*c$/;

/**
 * The values passed to `--label` / `-l`, in both the spaced and `=` forms.
 *
 * `gh` accepts a comma-separated list in one flag, so `--label a,b` is two
 * labels and not one named `a,b`.
 */
export function labelValues(tokens: string[]): string[] {
  const out: string[] = [];
  const add = (v: string) => {
    for (const part of v.split(",")) {
      const t = part.trim();
      if (t) out.push(t);
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--label" || t === "-l") {
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) add(tokens[++i]);
      continue;
    }
    if (t.startsWith("--label=")) add(t.slice("--label=".length));
    else if (t.startsWith("-l=")) add(t.slice("-l=".length));
  }
  return out;
}

/**
 * The single place that decides. `null` means allow.
 *
 * One exported function so there is one binding to mutate. Asked per clause
 * rather than per command: a command that comments on an issue AND creates
 * one is a create, and the old substring form let the first half excuse the
 * second.
 */
export function verifyPhaseRefusal(cmd: string): string | null {
  const offending = clauses(cmd).filter(createsIssue);
  if (offending.length === 0) return null;

  const names = Object.keys(OVERRIDE_LABELS);
  const allowed = offending.every(c => labelValues(c).some(l => names.includes(l)));
  if (allowed) return null;

  return (
    "[VerifyPhaseLock] During VERIFY phase, use verifyBlockers[] in " +
    "workflow-state.json instead of creating new issues. To override, apply a " +
    "label that states where the issue came from: " +
    names.map(n => `--label ${n} (${OVERRIDE_LABELS[n]})`).join(", ") +
    ". The label must be a real --label argument; a matching word in the title " +
    "is not an override."
  );
}
