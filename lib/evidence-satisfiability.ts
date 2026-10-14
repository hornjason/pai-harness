/**
 * Can this AC's evidence command satisfy this AC's threshold — for ANY
 * implementation?
 *
 * #217. The discovery agent writes the statement, the threshold and the
 * command in one pass, and nothing then checks the three against each other.
 * Measured on `wf_5e3ed885-98c`, in a single AC, two independent ways:
 *
 *   grep -n 'SC-\w+' lib/conformity.ts | grep 'x]'      threshold: >= 1
 *
 * `+` is a LITERAL in a basic regular expression, so the pattern reads
 * "SC-, one word character, a plus sign" and selects nothing in any file.
 * With `grep -E` it returns lines 199 and 318. The same AC also carried
 * `contains 'checked: boolean'` against a field legitimately declared
 * `checked?: boolean`.
 *
 * ## The mirror of the house defect
 *
 * `.claude/rules/checks-must-be-able-to-fail.md` is about a check that passed
 * because of what it never looked at. This is that disease inverted: a check
 * that FAILED because of what it could never match. In both the verdict is
 * independent of the code under test, and that — not the direction — is the
 * defect. A check must be able to fail and able to pass.
 *
 * ## What this deliberately does NOT do
 *
 * It does not consult the dry-run's output. Before the work is done,
 * `grep -c newThing src/` returning 0 against a `>= 1` threshold is what a
 * CORRECT acceptance criterion looks like. An unsatisfied threshold is the
 * normal state of an AC; only an UNSATISFIABLE one is a defect, and the
 * difference is whether an implementation could change the answer.
 *
 * So every refusal here holds for all possible code. That is a hard bar and it
 * is why the set is small — three shapes, each of which makes the verdict a
 * constant.
 */

// ── Shell tokenising ─────────────────────────────────────────────────────

/**
 * Split one pipeline stage into tokens, honouring quotes, and strip the
 * quotes. Not a shell parser — it is enough to find grep's flags and its
 * pattern argument, and anything it cannot read falls through to NO refusal.
 * A tokeniser that guesses would refuse a working command, and a false
 * refusal here stops a legitimate run cold.
 */
function tokenize(stage: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < stage.length; i++) {
    const ch = stage[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || current) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
  }
  if (started || current) tokens.push(current);
  return tokens;
}

/** The pipeline stages of a command, in order, trimmed. */
function stages(command: string): string[] {
  return command.split("|").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Strip leading `VAR=value` assignments and return the command word. */
function commandWord(tokens: string[]): string {
  for (const t of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
    return t;
  }
  return "";
}

// ── grep stages ──────────────────────────────────────────────────────────

interface GrepStage {
  /** The pattern argument, quotes already removed. */
  pattern: string;
  /** -E, -P, or the egrep name: the pattern is NOT a basic regular expression. */
  extended: boolean;
  /** -c: this stage emits a count, not the matching text. */
  counting: boolean;
}

/** Short flags that consume the following token. */
const ARG_FLAGS = new Set(["m", "A", "B", "C", "d", "D", "f"]);
const LONG_ARG_FLAGS = new Set([
  "--max-count", "--after-context", "--before-context", "--context",
  "--file", "--include", "--exclude", "--exclude-dir", "--binary-files",
  "--devices", "--directories", "--label", "--color", "--colour",
]);

/**
 * Read one pipeline stage as a grep invocation, or return null if it is not
 * one — or is one this cannot read confidently.
 */
function readGrep(stage: string): GrepStage | null {
  const tokens = tokenize(stage);
  const word = commandWord(tokens);
  if (!/^(?:[a-z]*grep)$/.test(word)) return null;

  let extended = word === "egrep";
  let counting = false;
  let pattern: string | null = null;

  const rest = tokens.slice(tokens.indexOf(word) + 1);
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];

    if (t === "--") {
      pattern = rest[i + 1] ?? null;
      break;
    }

    if (t.startsWith("--")) {
      const name = t.split("=")[0];
      if (name === "--extended-regexp" || name === "--perl-regexp") extended = true;
      if (name === "--regexp") {
        pattern = t.includes("=") ? t.slice(t.indexOf("=") + 1) : rest[++i] ?? null;
        break;
      }
      if (!t.includes("=") && LONG_ARG_FLAGS.has(name)) i++;
      continue;
    }

    if (t.startsWith("-") && t.length > 1) {
      const cluster = t.slice(1);
      if (cluster.includes("E") || cluster.includes("P")) extended = true;
      if (cluster.includes("c")) counting = true;
      // `-e PATTERN` — the pattern is the next token, wherever `e` sits in
      // the cluster, because a cluster can only carry one argument-taking
      // flag and it has to be last.
      if (cluster.endsWith("e")) {
        pattern = rest[++i] ?? null;
        break;
      }
      if (ARG_FLAGS.has(cluster[cluster.length - 1])) i++;
      continue;
    }

    pattern = t;
    break;
  }

  if (pattern === null) return null;
  return { pattern, extended, counting };
}

// ── Clause 1: a quantifier that is a literal ─────────────────────────────

/**
 * `+` and `?` are ordinary characters in a basic regular expression. Most of
 * the time that is harmless or even intended — `grep 'checked?: boolean'` and
 * `grep 'function foo('` are correct BREs whose author meant those characters
 * literally, and refusing them would break far more runs than it saves.
 *
 * What is NOT plausibly intended is a `+` or `?` directly after something that
 * is itself a character class or a group: `\w+`, `[0-9]+`, `)?`. A literal
 * plus sign after a word character is a pattern almost nothing contains, and
 * every instance found in this repo's run history meant the quantifier.
 *
 * So the rule is positional, not a ban on the characters. The boundary is in
 * `test/evidence-satisfiability.test.ts` in both directions, because
 * narrowing a detector is the change most likely to buy green with blindness.
 */
const LITERAL_QUANTIFIER = /(\\[wWdDsS]|\[[^\]]*\]|\))[+?]/;

function breRefusal(g: GrepStage): string | null {
  if (g.extended) return null;
  const hit = g.pattern.match(LITERAL_QUANTIFIER);
  if (!hit) return null;
  return (
    `the pattern \`${g.pattern}\` is a BASIC regular expression, where \`${hit[0].slice(-1)}\` ` +
    `after \`${hit[1]}\` is a literal character rather than a quantifier, so it matches ` +
    `nothing under any implementation — add \`-E\``
  );
}

// ── Clause 2: a count compared as text ───────────────────────────────────

/** Does this command's output consist of a number rather than the matched text? */
function emitsCount(command: string): boolean {
  const all = stages(command);
  // `tr -d ' '` and friends reformat a value without changing what it IS, so
  // the producing stage is the last one that is not pure reformatting.
  let i = all.length - 1;
  while (i > 0 && commandWord(tokenize(all[i])) === "tr") i--;
  const last = all[i];
  if (commandWord(tokenize(last)) === "wc") return true;
  const g = readGrep(last);
  return g?.counting === true;
}

function thresholdRefusal(command: string, op: string): string | null {
  if (op !== "contains" && op !== "notContains") return null;
  if (!emitsCount(command)) return null;
  return (
    `the command emits a count, not text, so a \`${op}\` threshold can never hold over ` +
    `its output — compare the count with a numeric operator instead`
  );
}

// ── Clause 3: a count of counts ──────────────────────────────────────────

/**
 * `grep -c ... | wc -l` prints the number of FILES grep reported a count for,
 * which is 1 for the single-file form regardless of how many matches there
 * were. The verdict is then a constant, and a constant satisfies or fails its
 * threshold for reasons that have nothing to do with the code.
 *
 * ship.js carried a comment naming this the "always-1 bug" and avoided
 * creating it in one branch. Nothing refused it when the discovery agent
 * wrote it directly.
 */
function countOfCountsRefusal(command: string): string | null {
  const all = stages(command);
  let i = all.length - 1;
  while (i > 0 && commandWord(tokenize(all[i])) === "tr") i--;
  if (i < 1 || commandWord(tokenize(all[i])) !== "wc") return null;
  const upstream = readGrep(all[i - 1]);
  if (!upstream?.counting) return null;
  return (
    "`grep -c` already prints a count, so piping it into `wc -l` counts the lines of " +
    "that count — one per file, whatever the matches were — and the result cannot vary " +
    "with the code"
  );
}

// ── The one decider ──────────────────────────────────────────────────────

/** The shape this reads. Structurally `ACInput`, repeated so this stays a leaf. */
export interface SatisfiabilityInput {
  id?: string;
  evidenceMethod?: { type?: string; command?: string };
  threshold?: { op?: string; value?: string | number; unit?: string };
}

/**
 * Why this AC's evidence can never satisfy its own threshold, or null if
 * nothing here can prove that it cannot.
 *
 * Null is "not provably unsatisfiable", NOT "verified satisfiable" — the
 * weaker claim is the honest one, and it is the direction this is allowed to
 * be wrong in. Missing a bad AC costs one failed run that a human reads. A
 * false refusal blocks a correct run, and nobody trusts the refuser again.
 */
export function satisfiabilityRefusal(ac: SatisfiabilityInput | null | undefined): string | null {
  const command = ac?.evidenceMethod?.command;
  if (typeof command !== "string" || command.trim().length === 0) return null;

  const reasons: string[] = [];

  const countOfCounts = countOfCountsRefusal(command);
  if (countOfCounts) reasons.push(countOfCounts);

  const op = ac?.threshold?.op;
  if (typeof op === "string") {
    const mismatch = thresholdRefusal(command, op);
    if (mismatch) reasons.push(mismatch);
  }

  for (const stage of stages(command)) {
    const g = readGrep(stage);
    if (!g) continue;
    const bre = breRefusal(g);
    if (bre) reasons.push(bre);
  }

  if (reasons.length === 0) return null;
  return reasons.join("; ");
}
