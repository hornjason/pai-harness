import { interpreterPrograms, stripHeredocs } from "./bash-write-guard";

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
 * including backticks, a path-qualified binary, quoted arguments, trailing
 * `#` comments, backslash line continuations, and `-c` / `-lc` / `eval`
 * wrappers. **Every one of those was a measured bypass of an earlier version
 * of this file**, and each has a row in `test/verify-phase-lock.test.ts`.
 *
 * Out of scope ON PURPOSE, and not a gap to file:
 *
 * - `curl` against the REST API, or the GitHub MCP tools — neither is Bash,
 *   so the hook never sees them.
 * - `ssh host "gh issue create …"` — that runs on another machine against
 *   whatever repo it is configured for, and descending into every remote
 *   command mentioning `gh` buys false refusals, not safety.
 * - Variable indirection — `GH=gh; $GH issue create`. Resolving it means
 *   tracking assignments across clauses, which is the shell interpreter this
 *   file is explicitly not, and nobody reaches for `$GH` by reflex.
 * - A caller who writes a script and runs it.
 * - A `cd` in an earlier clause, which retargets the tracker invisibly.
 *   Resolving it needs directory state across clauses, same reason as above.
 *
 * Each of those takes a decision to get around the lock, and an agent that
 * has made that decision is a problem no matcher fixes. Chasing them trades
 * false refusals — which teach people to work around a guard — for
 * protection against someone already doing so.
 *
 * **Here-strings and here-documents left this list in #1302, and the entry is
 * kept here rather than deleted because the reason it gave was wrong.** It
 * read "a deliberate construction, not a reflex" — an argument about how
 * often a shape is typed, which is not a property of the input and cannot be
 * measured. What settled it was that the body of a heredoc had to be parsed
 * either way: `clauses` was reading the bodies that go into FILES, which is
 * the one case that is certainly not a command, and refusing real work for
 * it. Once `stripHeredocs` removes those, `interpreterPrograms` has to put
 * the executable ones back, and that binding returns herestrings in the same
 * list. So the scope widened as a consequence of fixing a false refusal, and
 * narrowing it again would mean writing a second decider that disagrees with
 * `lib/bash-write-guard.ts`. See `heredocView` below.
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
      // A backslash-newline is a line continuation: it joins, and adds
      // nothing. Treating it as an escaped character put a literal newline
      // inside the token, so `gh issue \⏎ create` produced `\ncreate` and
      // the lock allowed it — and wrapping a long command across lines is
      // something people do on purpose.
      if (cmd[i + 1] === "\n") {
        i++;
        continue;
      }
      cur += cmd[++i];
      started = true;
      continue;
    }
    // `#` starts a comment only at the start of a word, which is the shell's
    // own rule. Without it, `--label bug # --label follow-up` read the
    // commented-out override as a real one.
    if (!quote && !started && c === "#") {
      while (i < cmd.length && cmd[i] !== "\n") i++;
      i--;
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
  for (const t of tokenize(heredocView(cmd))) {
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

/**
 * The command text, with heredoc bodies routed by where they GO (#1302).
 *
 * A heredoc body handed to an interpreter is a program and is parsed. A body
 * going anywhere else — `cat > doc.md <<'EOF'`, `tee`, `gh --body-file -` —
 * is a DOCUMENT and is removed, because text on its way into a file is not a
 * command however exactly it is spelled.
 *
 * **Both halves come from `lib/bash-write-guard.ts`, which already decided
 * this and proved it over 5,060 real commands in #1240.** Writing the split
 * again here would be two deciders on one question — the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md` — and they were already
 * disagreeing: `BashWriteGuard` read the interpreter body and stripped the
 * document body, and this parser did the exact inverse. The inverse is the
 * one that false-positives, and it blocked real work: a `cat > probe.ts`
 * whose body quoted a filing was refused as though it were one.
 *
 * It is the same expression `decideBashWrite` builds its own view from, so
 * the two guards now read a command the same way by construction rather than
 * by agreement.
 *
 * Two behaviours worth knowing, both inherited and both in the safe
 * direction. An UNTERMINATED heredoc is left in place, so a filing hidden
 * behind an unclosed delimiter does not become invisible. And a herestring
 * to a shell — `bash <<< '…'` — now parses where it did not before. That
 * last one is a DOCUMENTED boundary being reversed, not an oversight being
 * corrected: the module docblock listed it as out of scope and
 * `test/verify-phase-lock.test.ts` asserted the allow. Both are updated in
 * the same commit, with the reason, because a boundary that moves silently
 * is worse than either position.
 */
function heredocView(cmd: string): string {
  return [stripHeredocs(cmd), ...interpreterPrograms(cmd).map(p => p.program)].join("\n");
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
 * Flags of `gh issue create` that do NOT consume the following token.
 *
 * Everything else that looks like a flag is assumed to take a value, which
 * is the conservative direction here — see `labelValues`.
 */
const BOOLEAN_FLAGS = new Set(["-w", "--web", "-h", "--help", "--recover-only"]);

/**
 * The values passed to `--label` / `-l`, in both the spaced and `=` forms.
 *
 * `gh` accepts a comma-separated list in one flag, so `--label a,b` is two
 * labels and not one named `a,b`.
 *
 * **A token that is another flag's value is data, not a flag.** Scanning for
 * `--label=` anywhere in the clause reintroduced #365 exactly — the defect
 * this whole file exists to fix — through the back door:
 *
 *     gh issue create --label bug --title "--label=follow-up"
 *
 * `gh` gives that title to the issue and applies only `bug`; the old scan
 * read the title as an override and allowed it. Found by the third round of
 * commit security review, and it is the same bypass as the original with one
 * more layer of quoting. The unquoted form is the same command — the shell
 * strips the quotes either way, so the quoting is not what makes it work.
 *
 * So the walk tracks arity the way `gh`'s own flag parser does: a flag
 * consumes the next token unless it is known to be boolean. An unknown flag
 * is assumed to take a value, which can only ever cause a `--label` to be
 * MISSED — and a missed label is a refusal, the direction this guard is
 * allowed to be wrong in.
 */
export interface FlagQuery {
  /** The long form, with its dashes: `--label`. */
  long: string;
  /** The short form, with its dash: `-l`. Omit when there is none to read. */
  short?: string;
  /** `gh` reads `--label a,b` as two labels. A title is one value. */
  commaSeparated?: boolean;
}

/** `--label` / `-l`, the one query this file's own decision needs. */
export const LABEL_FLAG: FlagQuery = { long: "--label", short: "-l", commaSeparated: true };

/**
 * Short flags of `gh issue create` whose value may be ATTACHED: `-lfollow-up`.
 *
 * `-a` assignee, `-b` body, `-F` body-file, `-l` label, `-m` milestone,
 * `-p` project, `-t` title, `-T` template, `-R` repo. `-w` and `-h` are
 * boolean and live in `BOOLEAN_FLAGS`.
 *
 * **One table, consulted by every query, because where a token ends is a
 * property of the COMMAND and not of the question being asked.** The first
 * cut of this made it a per-query letter, so a walk looking for `--title`
 * recognised `-tFoo` as attached while a walk looking for `--label` read the
 * same token as an unknown flag and blindly consumed the one after it. Two
 * readings of one command line, disagreeing about token boundaries — found
 * by the AI review on #1282, which is right that the consequence is a
 * silently dropped argument: `gh issue create -tFoo --body "…"` lost the
 * body, so the finding arrived with no symptom and escaped the dedupe.
 *
 * It is a real change to `labelValues`, and in the direction of accuracy.
 * `gh issue create -aalice --label follow-up` applies the override label and
 * was REFUSED before this, because `-aalice` ate the `--label`. That was the
 * accepted error direction — a missed label is a refusal — but it was still
 * a wrong answer about a command somebody can type, and nothing about the
 * widening lets a label be read where none was written: the token after an
 * attached short is now parsed on its own merits rather than swallowed, and
 * it still has to BE a `--label` argument to count. An unknown short flag is
 * absent from this table and keeps the old conservative default.
 */
const VALUE_SHORT_FLAGS = new Set(["a", "b", "F", "l", "m", "p", "t", "T", "R"]);

/** `-lfollow-up` — a short flag with its value glued on. */
const ATTACHED_SHORT = /^-([A-Za-z])[^-=]/;

/**
 * The values passed to one flag of a `gh issue create` clause.
 *
 * One arity walk, parameterised, so a second reader of the same clause — see
 * `lib/issue-filing-gate.ts`, which needs `--title` and `--body` — agrees with
 * this one about where a flag's value is. Two walks would disagree the first
 * time either learned a flag the other did not have.
 */
export function flagValues(tokens: string[], q: FlagQuery): string[] {
  const out: string[] = [];
  const add = (v: string) => {
    for (const part of q.commaSeparated === true ? v.split(",") : [v]) {
      const t = q.commaSeparated === true ? part.trim() : part;
      if (t) out.push(t);
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith("-") || t === "-" || t === "--") continue;

    const eq = t.indexOf("=");
    if (eq !== -1) {
      const name = t.slice(0, eq);
      if (name === q.long || name === q.short) add(t.slice(eq + 1));
      continue; // `--flag=value` carries its own value; it consumes nothing
    }
    if (t === q.long || t === q.short) {
      if (i + 1 < tokens.length) add(tokens[++i]);
      continue;
    }
    // `-lfollow-up` — pflag lets a short flag carry its value attached. Its
    // value is IN the token, so it consumes nothing whether or not it is the
    // flag this query is collecting. That second half is the fix: a query
    // that skipped it here would also skip the `continue` and eat the next
    // token, which is the desync `VALUE_SHORT_FLAGS` exists to prevent.
    const attached = ATTACHED_SHORT.exec(t);
    if (attached !== null && VALUE_SHORT_FLAGS.has(attached[1])) {
      if (q.short === `-${attached[1]}`) add(t.slice(2));
      continue;
    }
    if (!BOOLEAN_FLAGS.has(t)) i++; // this flag eats the next token
  }
  return out;
}

export function labelValues(tokens: string[]): string[] {
  return flagValues(tokens, LABEL_FLAG);
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
