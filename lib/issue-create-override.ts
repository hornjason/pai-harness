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
 */

/** Labels that permit an issue to be filed mid-VERIFY, and what each means. */
export const OVERRIDE_LABELS: Record<string, string> = {
  "follow-up": "follow-up work from a shipped issue",
  "external-audit": "a defect found outside the ship loop",
};

/**
 * Split a command the way a shell would, so an argument can be told from a
 * word inside a quoted string.
 *
 * Not a full shell parser and does not need to be: the only question is
 * which tokens are arguments. Unterminated quotes yield the rest of the
 * string as one token, which keeps a malformed command from silently
 * splitting into tokens that look like flags.
 */
export function tokenize(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;
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
    if (/\s/.test(c)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

/** Shell operators that end one command and begin another. */
const SEPARATORS = new Set(["&&", "||", ";", "|", "&"]);

/** The command list, one token array per clause. */
export function clauses(cmd: string): string[][] {
  const out: string[][] = [[]];
  for (const t of tokenize(cmd)) {
    if (SEPARATORS.has(t)) out.push([]);
    else out[out.length - 1].push(t);
  }
  return out.filter(c => c.length > 0);
}

/** Does this clause invoke `gh issue create`? */
export function createsIssue(tokens: string[]): boolean {
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (tokens[i] === "gh" && tokens[i + 1] === "issue" && tokens[i + 2] === "create") return true;
  }
  return false;
}

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
