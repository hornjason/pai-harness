/** Only `bun test`, so the operand scan can start at a fixed index. */
const SUITE_INVOCATION = /^bun\s+test(?![:\w-])/;

/** A redirection operator, attached target or not: `>`, `2>`, `&>>`, `2>&1`. */
const REDIRECT = /^(?:\d*|&)>>?(?:&\d+)?(.*)$/;

/**
 * True for a whole-suite run, false for one scoped to paths.
 *
 * The caller is a guard that refuses a full suite, so `false` is the
 * permissive answer: anything this misreads as targeted runs unguarded.
 */
export function isFullSuite(command: string): boolean {
  if (!SUITE_INVOCATION.test(command)) return false;

  const tokens = command.trim().split(/\s+/);
  const args: string[] = [];

  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i];

    // Flags never make a run targeted.
    if (t.startsWith("-")) continue;

    const redirect = t.match(REDIRECT);
    if (redirect) {
      // `2>/dev/null` carries its target; a bare `>` consumes the next token.
      // Either way the target is a sink, not a test path.
      if (!redirect[1]) i++;
      continue;
    }

    args.push(t);
  }

  return !args.some(a => a.includes("/") || /\.(test\.)?(ts|tsx|js|jsx)$/.test(a));
}
