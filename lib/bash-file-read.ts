/**
 * bash-file-read.ts -- COMP-7 detection logic
 * SC-368 (hook logic lives in lib/, hooks stay thin)
 *
 * Single source of truth for "is this Bash command reading a file with
 * cat/head/tail?". Used by BOTH the enforcement hook (BashToolGuard) and the
 * grader (lib/transcript-checker.ts) so enforcement and measurement can never
 * drift apart.
 *
 * The distinction that matters: cat/head/tail with a FILE OPERAND read a file
 * and must use the Read tool instead. The same commands with no operand read
 * STDIN — they are output filters (`bun test | tail -30`), not file reads, and
 * the Read tool cannot replace them.
 *
 * The previous rule blocked any pipe into head/tail. It had a high false
 * positive rate: it blocked Anthropic's bundled skills, blocked `bun test`
 * output filtering, and blocked the git commit of its own fix because the
 * commit message body contained the literal text "| head -80".
 */

/** Commands that read files when given an operand. */
const FILE_READERS = new Set(['cat', 'head', 'tail']);

/** Flags that consume the following token as their value (`head -n 20 f`). */
const VALUE_FLAGS = new Set(['-n', '-c', '--lines', '--bytes']);

/**
 * Wrappers and prefixes that delegate to the real command, plus `VAR=value`
 * assignments. `env FOO=1 /bin/cat x` must resolve to `cat`.
 */
const PREFIXES = new Set(['command', 'exec', 'builtin', 'env', 'nohup', 'time', 'sudo']);

/**
 * Drop wrapper prefixes and inline env assignments so the first remaining
 * token is the actual command.
 */
function stripPrefixes(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && (PREFIXES.has(tokens[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i++;
  return tokens.slice(i);
}

/**
 * True when the token list (argv-style, command first) includes a file operand
 * — i.e. a non-flag argument that is not the value of a preceding flag.
 */
function hasFileOperand(tokens: string[]): boolean {
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (VALUE_FLAGS.has(tok)) {
      i++; // skip the flag's value
      continue;
    }
    if (tok.startsWith('-')) continue; // -20, -n20, --lines=20, -f
    return true;
  }
  return false;
}

/**
 * Split a shell command into pipeline/chain segments on `|`, `||`, `&`, `&&`
 * and `;`.
 *
 * Quote-aware by necessity: a naive regex split tears quoted strings apart, so
 * `git commit -m "explain grep | head -80"` yielded a bogus `head -80"` segment
 * and blocked the commit. Operators inside single or double quotes are literal
 * text and must not split.
 */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote) {
      current += ch;
      // Backslash escapes apply inside double quotes, not single quotes.
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

    // Newlines separate commands just like `;` does — multi-line scripts and
    // interpreter heredocs put each command on its own line.
    if (ch === '|' || ch === '&' || ch === ';' || ch === '\n') {
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

/** Shell interpreters that execute a heredoc body as commands. */
const INTERPRETERS = /(^|[\s;&|])(ba|z|k|da)?sh\s*$/;

/**
 * Remove heredoc bodies before scanning.
 *
 * A heredoc body is DATA, not commands — but the hook sees the whole raw
 * command string, so `git commit -F - <<EOF ... cat package.json ... EOF`
 * looked like a file read and blocked the commit. This matches the exemption
 * lib/transcript-checker.ts already applies via its `<<` check.
 *
 * Exception: when the command feeding the heredoc is a shell interpreter
 * (`bash <<EOF`), the body really does execute, so it is left in place.
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
    if (m && !INTERPRETERS.test(line.slice(0, m.index))) {
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
 * Detects cat/head/tail being used to read a file in any segment of a shell
 * command — direct, `;`-chained, `&&`-chained, or piped.
 *
 * Returns the offending segment, or null when the command is clean. Pure
 * stdin filters (`cmd | head -80`, `cmd | tail -30`, `cmd | cat`) return null.
 */
export function detectBashFileRead(command: string): string | null {
  for (const segment of splitSegments(stripHeredocBodies(command))) {
    const tokens = stripPrefixes(segment.trim().split(/\s+/).filter(Boolean));
    if (!tokens.length) continue;
    // Basename so /bin/cat and /usr/bin/head resolve to cat and head.
    const name = tokens[0].split('/').pop()!;
    if (!FILE_READERS.has(name)) continue;
    if (hasFileOperand(tokens)) return segment.trim();
  }
  return null;
}

/** Convenience boolean wrapper. */
export function isBashFileRead(command: string): boolean {
  return detectBashFileRead(command) !== null;
}
