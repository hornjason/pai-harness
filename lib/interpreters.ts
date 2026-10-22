/**
 * One binding for "is this word an interpreter" (#1240).
 *
 * Two modules were asking the same question with two different answers.
 * `lib/bash-write-guard.ts` asked it of a command word, to decide whether a
 * `-c`/`-e` argument is a program; `lib/bash-file-read.ts` asked it of the
 * text before a `<<`, to decide whether a heredoc body is a program or a
 * document. The second list was shells only, so a `python3` heredoc read as
 * a document there — and the write guard, which never asked the heredoc
 * question at all, could not see a `python3 <<'PY'` program either.
 *
 * The write guard's list is the one kept, because `python3 <<'PY'` is as
 * much a program as `bash <<'EOF'`.
 *
 * ## The third binding is NOT this question, and stays where it is
 *
 * `lib/hook-trees.ts` has an `INTERPRETERS` set of
 * `bun/bunx/node/npx/npm/pnpm/yarn/deno/ts-node/tsx` — package runners, no
 * shells. It answers "which leading token do I skip to find the hook file",
 * which is a different population reached for a different reason, and its
 * own docblock already carries a written reason not to share its parser
 * ("the cheap generalisation 'reuse this parser everywhere' still has a
 * written reason not to"). Folding it in here would widen it to `sh`, `php`
 * and `osascript`, none of which register a hook. Two bindings collapse into
 * one; the third is left with the reason restated rather than implied.
 */

/**
 * Programs that take source on the command line or on stdin and run it.
 *
 * Spelled as names rather than a regex so membership is one lookup and the
 * list reads as a list. `python` without a suffix is included: `python <<PY`
 * is still a program on a machine where `python` resolves to 3.
 */
export const INTERPRETER_NAMES: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh',
  'python', 'python2', 'python3',
  'perl', 'ruby', 'php', 'osascript',
  'node', 'bun', 'deno',
]);

/** Interpreters whose inline argument and heredoc body are SHELL. */
export const SHELL_NAMES: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/**
 * The bare name of a token: leading directories and a leading `\` removed.
 *
 * `/bin/bash`, `\bash` and `bash` are one program to the shell, and the
 * reason this exists rather than a `basename()` call is that a leading
 * backslash is quoting, not a path component.
 */
export function interpreterName(token: string): string {
  return token.replace(/^\\/, '').replace(/^.*\//, '');
}

/** Is this token an interpreter — `/usr/bin/python3` as readily as `sh`? */
export function isInterpreterWord(token: string): boolean {
  return INTERPRETER_NAMES.has(interpreterName(token));
}

/** Is this token a shell, whose program text this module can parse as shell? */
export function isShellWord(token: string): boolean {
  return SHELL_NAMES.has(interpreterName(token));
}
