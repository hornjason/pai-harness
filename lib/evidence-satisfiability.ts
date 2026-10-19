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
 * is why the set is small — six shapes, each of which makes the verdict a
 * constant, or makes the number being compared a different number from the
 * one the criterion is about.
 *
 * ## The three #669 clauses, and what widened the bar
 *
 * #664's run (`wf_448af2c4-6c1`) failed three of six ACs over correct and
 * complete work, and two of the three could not have passed it. All three
 * defects were in the instrument:
 *
 *   4. **A declared unit that is not what the command counts.** AC-6's
 *      threshold counts red test cases; its command counts matching lines of
 *      prose in a markdown section. Both integers, so the comparison is
 *      well-typed and meaningless.
 *   5. **A literal the tree does not hold and the brief never named.** Both
 *      AC-6 and AC-7 opened an `awk` range on a heading DISCOVERY invented.
 *      The implementer wrote a better one, the range came back empty, and the
 *      gate read `0`.
 *   6. **A flag the tool ignores.** `bun test --grep` is not a bun flag; bun
 *      exits 0 without complaining, so AC-2's command was behaviourally
 *      identical to AC-1's and the criterion that existed to be independent
 *      of AC-1 was checked by the same observation.
 *
 * Clauses 4 and 6 keep the original bar: the verdict cannot be about the code
 * under any implementation. Clause 5 is the one widening — the number it
 * produces is a constant only until somebody guesses the string, which is the
 * point. It is also the only clause that needs to read the tree, so it is the
 * only one with a context argument, and with no reader in hand it refuses
 * nothing rather than guessing at a project root.
 */

// ── Shell tokenising ─────────────────────────────────────────────────────

/** One token of a command, and whether any of it arrived inside quotes. */
interface Token {
  text: string;
  quoted: boolean;
}

/**
 * Split one pipeline stage into tokens, honouring quotes, and strip the
 * quotes. Not a shell parser — it is enough to find grep's flags and its
 * pattern argument, and anything it cannot read falls through to NO refusal.
 * A tokeniser that guesses would refuse a working command, and a false
 * refusal here stops a legitimate run cold.
 *
 * `quoted` is carried because a flag clause must not read `-t '--grep is not
 * a flag'` as an invocation of `--grep`, and the quoting is the only thing
 * that distinguishes them once the quotes are gone.
 */
function tokenizeParts(stage: string): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  let quotedHere = false;

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
      quotedHere = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || current) tokens.push({ text: current, quoted: quotedHere });
      current = "";
      started = false;
      quotedHere = false;
      continue;
    }
    current += ch;
  }
  if (started || current) tokens.push({ text: current, quoted: quotedHere });
  return tokens;
}

function tokenize(stage: string): string[] {
  return tokenizeParts(stage).map((t) => t.text);
}

/**
 * Split on delimiters that are not inside quotes.
 *
 * A naive `split("|")` cuts a command in half at the alternation inside
 * `grep -ciE 'a|b'` and then reads `b'` as the producing stage — which is
 * how #664's AC-6 passed every clause in this file while counting lines of
 * prose against a threshold of test cases. Measured: with the naive split,
 * `satisfiabilityRefusal` returns null for that AC; with this one it names
 * the mismatch.
 *
 * Delimiters are matched longest-first, so `&&` is not read as two empty
 * segments around nothing.
 */
function splitUnquoted(command: string, delimiters: readonly string[]): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    const hit = delimiters.find((d) => command.startsWith(d, i));
    if (hit) {
      parts.push(current);
      current = "";
      i += hit.length - 1;
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** The pipeline stages of a command, in order, trimmed. */
function stages(command: string): string[] {
  return splitUnquoted(command, ["|"]);
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

/**
 * What quantity a counting command counts.
 *
 * `unknown` is a count whose quantity this cannot name — bare `wc` prints
 * three numbers — and it is compatible with every unit, because a clause that
 * refused on a reading it could not take would be guessing.
 */
type CountClass = "lines" | "files" | "words" | "bytes" | "unknown";

interface CountedQuantity {
  klass: CountClass;
  /** How the refusal names it to a reader. */
  text: string;
}

/** Does this stage print file NAMES, one per line, rather than file content? */
function listsFiles(stage: string): boolean {
  const tokens = tokenize(stage);
  const word = commandWord(tokens);
  if (word === "find" || word === "ls") return true;
  if (word === "git" && tokens.includes("ls-files")) return true;
  const g = readGrep(stage);
  if (!g) return false;
  return tokens.some((t) => /^-[a-zA-Z]*[lL][a-zA-Z]*$/.test(t) || t === "--files-with-matches");
}

/**
 * The quantity this command's output IS, or null when its output is text
 * rather than a count.
 *
 * One binding, and `emitsCount` is a projection of it: a second function
 * answering "is this a count" beside this one would be two deciders agreeing
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape), and a
 * mutation of either would leave the other holding every case up.
 */
function countedQuantity(command: string): CountedQuantity | null {
  const all = stages(command);
  // `tr -d ' '` and friends reformat a value without changing what it IS, so
  // the producing stage is the last one that is not pure reformatting.
  let i = all.length - 1;
  while (i > 0 && commandWord(tokenize(all[i])) === "tr") i--;
  const last = all[i];

  if (commandWord(tokenize(last)) === "wc") {
    const flags = tokenize(last)
      .filter((t) => /^-[a-zA-Z]+$/.test(t))
      .join("");
    if (flags.includes("l")) {
      return i > 0 && listsFiles(all[i - 1])
        ? { klass: "files", text: "the files the previous stage listed, one per line" }
        : { klass: "lines", text: "lines of its input" };
    }
    if (flags.includes("w")) return { klass: "words", text: "words of its input" };
    if (flags.includes("c") || flags.includes("m")) {
      return { klass: "bytes", text: "bytes of its input" };
    }
    return { klass: "unknown", text: "a count of its input" };
  }

  const g = readGrep(last);
  if (g?.counting === true) {
    return { klass: "lines", text: "lines matching the pattern, one count per file" };
  }
  return null;
}

/** Does this command's output consist of a number rather than the matched text? */
function emitsCount(command: string): boolean {
  return countedQuantity(command) !== null;
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

// ── Clause 4: a declared unit that is not what the command counts ────────

/**
 * The quantities a `unit` can name, and the words that name them.
 *
 * Deliberately small. A word not in here is not a quantity as far as this is
 * concerned, and an AC whose unit names no quantity is accepted — "sites",
 * "windows", "occurrences", "violations" and "matches" are all one-per-line
 * readings an author is entitled to, and refusing them would make the most
 * common evidence shape in the repo unusable.
 *
 * `(?<![-\w])` keeps a hyphenated modifier out of it: #664 AC-1's unit is
 * "fixed-character slice windows", which names no quantity, and a bare
 * `\bcharacters?\b` would have read it as a count of bytes.
 *
 * `test` and `tests` are NOT here, on purpose. They are modifiers far more
 * often than heads in this repo's units — "test files read by the scan",
 * "converted test sites importing the shared helper" — and the quantity
 * #664's AC-6 actually declared is `cases`.
 */
type DeclaredClass = "lines" | "files" | "words" | "bytes" | "cases";

const UNIT_CLASSES: Array<[DeclaredClass, RegExp]> = [
  ["lines", /(?<![-\w])(?:lines?|rows?)\b/i],
  ["files", /(?<![-\w])(?:files?|paths?)\b/i],
  ["words", /(?<![-\w])words?\b/i],
  ["bytes", /(?<![-\w])(?:bytes?|characters?|chars?)\b/i],
  // A count of test cases is never a count of lines of a document, which is
  // the whole of #664 AC-6.
  ["cases", /(?<![-\w])(?:test cases?|cases?|assertions?)\b/i],
];

/** Which declared quantity is compatible with which counted one. */
const COMPATIBLE: Record<Exclude<CountClass, "unknown">, ReadonlySet<DeclaredClass>> = {
  lines: new Set<DeclaredClass>(["lines"]),
  // A list of file names IS a list of lines, so both readings are honest.
  files: new Set<DeclaredClass>(["files", "lines"]),
  words: new Set<DeclaredClass>(["words"]),
  bytes: new Set<DeclaredClass>(["bytes"]),
};

/** How a refusal names each declared quantity. */
const CLASS_LABEL: Record<DeclaredClass, string> = {
  lines: "lines",
  files: "files",
  words: "words",
  bytes: "bytes",
  cases: "test cases",
};

/**
 * The quantity the unit is ABOUT — its head phrase, cut at the first
 * preposition.
 *
 * "matching lines in lib/a.ts" is a count of lines; "red cases, one per
 * matching line" is a count of cases the author has told you how to read off
 * lines. Searching the whole string for a compatible word is the right
 * reading for the second and the wrong one for the first, so the head is
 * searched for the DISAGREEMENT and the whole string for the AGREEMENT. The
 * asymmetry is in the safe direction: anything the author related to the
 * counted quantity anywhere in the unit is accepted.
 */
function unitHead(unit: string): string {
  const cut = unit.search(
    /\b(?:in|of|per|from|across|under|by|with|over|within|into|for|on|at|between|through|after|before|against)\b/i,
  );
  return cut > 0 ? unit.slice(0, cut) : unit;
}

function classesIn(text: string): DeclaredClass[] {
  return UNIT_CLASSES.filter(([, re]) => re.test(text)).map(([k]) => k);
}

function unitDisagreementRefusal(
  id: string,
  command: string,
  threshold: { unit?: string } | undefined,
): string | null {
  const counted = countedQuantity(command);
  if (!counted || counted.klass === "unknown") return null;

  const unit = typeof threshold?.unit === "string" ? threshold.unit.trim() : "";
  if (unit.length === 0) return null;

  const compatible = COMPATIBLE[counted.klass];
  const declared = classesIn(unitHead(unit));
  if (declared.length === 0) return null;
  if (declared.some((d) => compatible.has(d))) return null;
  // The author may have related the two quantities further into the unit.
  if (classesIn(unit).some((d) => compatible.has(d))) return null;

  const named = declared.map((d) => CLASS_LABEL[d]).join(" and ");
  return (
    `${id}: the threshold's unit "${unit}" declares a count of ${named}, but the command counts ` +
    `${counted.text} — the two are both integers, so the comparison is well-typed and about ` +
    `nothing. Count the thing the unit names, or name the thing the command counts`
  );
}

// ── Clause 5: a literal the tree does not hold ───────────────────────────

/**
 * Pull the plain-text literals a command keys on out of its quoted
 * arguments.
 *
 * Quoted arguments ONLY. An unquoted path that does not exist already fails
 * the dry run with grep's exit 2 and is classified `broken` there, and a
 * second decider for a question something else already answers is the fourth
 * shape in `.claude/rules/checks-must-be-able-to-fail.md`.
 *
 * An `awk`/`sed` program is unwrapped first: `'/^## Heading/,/^## [^T]/'` is
 * one quoted token carrying two patterns, and the heading is the half a
 * reader can act on.
 *
 * A candidate must survive three filters, each of which exists to keep a
 * refusal actionable:
 *
 *  - anchors are stripped, then anything still carrying a regular-expression
 *    metacharacter is dropped. `^## [^T]` is a pattern, not a string a tree
 *    can hold, and telling an implementer to go and add it is nonsense.
 *  - it must be at least `MIN_LITERAL` characters. Short tokens are words,
 *    flags and single letters, and the thing this clause is about is an
 *    invented heading or marker.
 *  - it must contain a letter, so a number or a punctuation run is not
 *    quoted back as an interface.
 */
const MIN_LITERAL = 12;

function literalCandidates(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/'([^']*)'|"([^"]*)"/g)) {
    const raw = m[1] ?? m[2] ?? "";
    const pieces = /^\s*\/.*\/\s*(?:,\s*\/.*\/\s*)?$/.test(raw)
      ? [...raw.matchAll(/\/((?:[^/\\]|\\.)*)\//g)].map((p) => p[1])
      : [raw];
    for (const piece of pieces) {
      const text = piece.replace(/^\^/, "").replace(/\$$/, "").trim();
      if (text.length < MIN_LITERAL) continue;
      if (/[\\[\]{}()|*+?]|\.\*/.test(text)) continue;
      if (!/[A-Za-z]/.test(text)) continue;
      if (!out.includes(text)) out.push(text);
    }
  }
  return out;
}

function absentLiteralRefusal(
  id: string,
  command: string,
  evidenceType: string | undefined,
  declaredInterfaces: readonly string[],
  context: SatisfiabilityContext | undefined,
): string | null {
  const treeContains = context?.treeContains;
  // No reader, no reading. UNMEASURED, not clean — and the caller is told so
  // by the docstring rather than by a refusal this cannot support.
  if (typeof treeContains !== "function") return null;
  if (String(evidenceType ?? "").toUpperCase() !== "COMMAND") return null;

  const named = [...declaredInterfaces, ...(context?.briefInterfaces ?? [])].map(String);
  const absent = literalCandidates(command).filter(
    (lit) => !treeContains(lit) && !named.some((n) => n.includes(lit)),
  );
  if (absent.length === 0) return null;

  return (
    `${id}: the evidence keys on ${absent.map((l) => `\`${l}\``).join(", ")}, which the tree does ` +
    `not hold at run start and the implementer's brief does not name as an interface — the gate ` +
    `would be measuring whether the implementer guessed that exact string. Carry it into the ` +
    `brief as a named interface, or key the evidence on something that exists`
  );
}

// ── Clause 6: a flag the tool does not accept ────────────────────────────

/**
 * Every long flag `bun test` accepts, transcribed from `bun test --help` and
 * `bun --help` on v1.3.x, without the leading dashes.
 *
 * Exported because `test/evidence-flag-validation.test.ts` runs the real
 * binary's help and asserts the table still covers it. A transcription with
 * nothing comparing it to the tool is #621's defect: two documents naming one
 * thing and no check between them.
 */
export const BUN_TEST_FLAGS: ReadonlySet<string> = new Set([
  // bun test
  "no-orphans", "timeout", "update-snapshots", "rerun-each", "retry", "todo", "only",
  "pass-with-no-tests", "concurrent", "randomize", "seed", "coverage", "coverage-reporter",
  "coverage-dir", "bail", "test-name-pattern", "reporter", "reporter-outfile", "dots",
  "only-failures", "max-concurrency", "path-ignore-patterns", "changed", "isolate",
  "parallel", "parallel-delay", "test-worker", "shard",
  // bun, globally
  "conditions", "console-depth", "cpu-prof", "cpu-prof-dir", "cpu-prof-interval", "cpu-prof-md",
  "cpu-prof-name", "cron-period", "cron-title", "cwd", "dns-result-order", "elide-lines",
  "env-file", "experimental-http2-fetch", "experimental-http3-fetch", "expose-gc",
  "fetch-preconnect", "heap-prof", "heap-prof-dir", "heap-prof-md", "heap-prof-name", "hot",
  "if-present", "import", "inspect", "inspect-brk", "inspect-wait", "install",
  "max-http-header-size", "no-addons", "no-clear-screen", "no-deprecation", "no-env-file",
  "no-exit-on-error", "no-install", "port", "prefer-latest", "prefer-offline",
  "redis-preconnect", "require", "revision", "sequential", "shell", "silent", "smol",
  "sql-preconnect", "throw-deprecation", "title", "unhandled-rejections", "use-bundled-ca",
  "use-openssl-ca", "use-system-ca", "user-agent", "watch", "workspaces", "zero-fill-buffers",
  "bun", "config", "eval", "filter", "help", "print", "preload", "version",
]);

/**
 * A flag somebody reached for, and what the tool actually calls it.
 *
 * A refusal naming only what is wrong costs a round; naming the replacement
 * is what makes the next run a fix rather than a guess (#263).
 */
const BUN_TEST_ALTERNATIVES: Record<string, string> = {
  "--grep": "--test-name-pattern",
  "--testNamePattern": "--test-name-pattern",
  "--test-name-filter": "--test-name-pattern",
  "--testPathPattern": "a bare path argument",
  "--runInBand": "--parallel=1",
  "--verbose": "no equivalent — bun test prints every test name by default",
};

/**
 * Split a command into the things that get EXECUTED, across `|`, `&&`, `||`
 * and `;`.
 *
 * Not `stages()`, which answers a different question — which stage produces
 * the output — and must stay pipe-only to answer it. Two questions, two
 * splitters; collapsing them would make `cd /tmp && bun test …` look like a
 * command whose output is `cd`'s.
 */
function executedSegments(command: string): string[] {
  return splitUnquoted(command, ["&&", "||", "|", ";", "\n"]);
}

function unknownFlagRefusal(id: string, command: string): string | null {
  for (const segment of executedSegments(command)) {
    const tokens = tokenizeParts(segment).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text));
    if (tokens[0]?.text !== "bun" || tokens[0].quoted) continue;
    const sub = tokens.slice(1).find((t) => !t.text.startsWith("-"));
    if (sub?.text !== "test") continue;

    for (const t of tokens.slice(1)) {
      if (t.quoted || !t.text.startsWith("--") || t.text === "--") continue;
      const name = t.text.split("=")[0];
      const bare = name.slice(2);
      if (BUN_TEST_FLAGS.has(bare)) continue;
      if (bare.startsWith("no-") && BUN_TEST_FLAGS.has(bare.slice(3))) continue;
      const alternative = BUN_TEST_ALTERNATIVES[name];
      return (
        `${id}: \`bun test\` does not accept \`${name}\` — it is not in \`bun test --help\`, and ` +
        `bun IGNORES it silently rather than failing, so the command runs clean and measures ` +
        `something other than what the criterion says` +
        (alternative ? `. Use \`${alternative}\` instead` : "")
      );
    }
  }
  return null;
}

// ── The one decider ──────────────────────────────────────────────────────

/** The shape this reads. Structurally `ACInput`, repeated so this stays a leaf. */
export interface SatisfiabilityInput {
  id?: string;
  evidenceMethod?: { type?: string; command?: string };
  threshold?: { op?: string; value?: string | number; unit?: string };
  /**
   * Literals this AC's evidence keys on that the implementer is being TOLD
   * about — the waiver clause 5 reads. An invented string is only a guess
   * while nobody has been shown it.
   */
  evidenceInterfaces?: readonly string[];
}

/**
 * What the decider is allowed to read about the world outside the AC.
 *
 * Optional, and every clause that uses it refuses nothing without it. The
 * alternative — defaulting a project root — is Silent Default Substitution
 * (`.claude/rules/config-access.md`) in the position where it does the most
 * damage: a refusal computed against the wrong tree.
 */
export interface SatisfiabilityContext {
  /** Does the tree, as it stands BEFORE the work, hold this literal anywhere? */
  treeContains?: (literal: string) => boolean;
  /** Literals the implementer's brief names as interfaces. */
  briefInterfaces?: readonly string[];
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
export function satisfiabilityRefusal(
  ac: SatisfiabilityInput | null | undefined,
  context?: SatisfiabilityContext,
): string | null {
  const command = ac?.evidenceMethod?.command;
  if (typeof command !== "string" || command.trim().length === 0) return null;

  const id = typeof ac?.id === "string" && ac.id.length > 0 ? ac.id : "this AC";
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

  // #669. Three clauses about the instrument rather than the pattern: what
  // the number counts, what string the command bets on, and whether the tool
  // is even reading the flag.
  const unitDisagreement = unitDisagreementRefusal(id, command, ac?.threshold);
  if (unitDisagreement) reasons.push(unitDisagreement);

  const absentLiteral = absentLiteralRefusal(
    id,
    command,
    ac?.evidenceMethod?.type,
    Array.isArray(ac?.evidenceInterfaces) ? ac.evidenceInterfaces : [],
    context,
  );
  if (absentLiteral) reasons.push(absentLiteral);

  const unknownFlag = unknownFlagRefusal(id, command);
  if (unknownFlag) reasons.push(unknownFlag);

  if (reasons.length === 0) return null;
  return reasons.join("; ");
}
