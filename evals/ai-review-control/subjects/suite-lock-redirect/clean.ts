/** Only `bun test`, so the operand scan can start at a fixed index. */
const SUITE_INVOCATION = /^bun\s+test(?![:\w-])/;

/** A redirection operator, attached target or not: `>`, `2>`, `&>>`, `2>&1`. */
const REDIRECT = /^(?:\d*|&)>>?(?:&\d+)?(.*)$/;

/** An operand naming a file or a directory, rather than a bare word. */
function looksLikePath(operand: string): boolean {
  return operand.includes("/") || /\.(test\.)?(ts|tsx|js|jsx)$/.test(operand);
}

/**
 * True for a whole-suite run, false for one scoped to paths.
 *
 * The caller is a guard that refuses a full suite, so `false` is the
 * permissive answer: anything this misreads as targeted runs unguarded.
 */
export function isFullSuite(command: string): boolean {
  if (!SUITE_INVOCATION.test(command)) return false;

  const tokens = command.trim().split(/\s+/);
  const operands: string[] = [];

  for (let i = 2; i < tokens.length; i++) {
    const token = tokens[i];

    // Flags never make a run targeted.
    if (token.startsWith("-")) continue;

    const redirect = token.match(REDIRECT);
    if (redirect) {
      // `2>/dev/null` carries its target; a bare `>` consumes the next token.
      // Either way the target is a sink, not a test path.
      if (!redirect[1]) i++;
      continue;
    }

    operands.push(token);
  }

  return !operands.some(looksLikePath);
}
