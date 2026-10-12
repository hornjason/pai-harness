/**
 * #299 — stamping a doc header must ADD fields, never replace the block.
 *
 * A PostToolUse formatter rewrote the frontmatter of every `.md` it touched
 * by rebuilding the block from its four required keys:
 *
 *     const fmLines = REQUIRED.map(k => `${k}: ${stamped[k]}`).join('\n');
 *     newContent = content.replace(FRONTMATTER_RE, `---\n${fmLines}\n---`);
 *
 * Everything else in the block was discarded. Editing
 * `.claude/rules/key-files.md` dropped its `description:` — the field Claude
 * Code's rule loading surfaces a rule by — and `.claude/rules/*.md` carried
 * that field unanimously. The damage was one file per edit, only to files
 * someone had touched, and nothing went red: a rules file that has stopped
 * being surfaced to agents looks exactly like one that is surfaced and
 * ignored.
 *
 * There is a second failure underneath it. The parser was
 * `line.split(":")`, which cannot see a YAML block value:
 *
 *     paths:
 *       - ".github/workflows/**"
 *
 * reads as `paths: ""` plus two unparseable lines. So even a merge written
 * over that parser's output would have flattened `harness-managed.md`'s
 * `paths:` list — the list that defines which files the scaffold owns.
 *
 * Both are fixed here, in one place, with the parse and the serialise written
 * against each other so a value the parser cannot represent is a parse
 * failure rather than a silent truncation.
 *
 * ## Scope
 *
 * This is deliberately NOT a YAML implementation. It handles the two shapes
 * doc frontmatter actually uses — `key: scalar` and a `key:` followed by
 * indented lines — and REFUSES anything else by returning null, so a caller
 * leaves a block it does not understand alone rather than rewriting it into
 * something smaller. A formatter that half-understands its input is how this
 * issue happened.
 */

export interface FrontmatterEntry {
  key: string;
  /** The text after `key:` on the same line, trimmed. Empty for a block. */
  inline: string;
  /** Continuation lines verbatim, including their indentation. */
  block: string[];
}

export interface ParsedFrontmatter {
  entries: FrontmatterEntry[];
  /** Everything after the closing `---`, verbatim. */
  body: string;
}

const OPEN = /^---\r?\n/;

/** A key line: an identifier at column 0, then a colon. */
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/;

/**
 * Parse a document's frontmatter.
 *
 * Returns null when there is no frontmatter block, when it is unterminated,
 * or when it contains a line this module cannot represent. Null means "do not
 * touch it", never "it was empty".
 */
export function parseFrontmatter(content: string): ParsedFrontmatter | null {
  if (!OPEN.test(content)) return null;
  const afterOpen = content.replace(OPEN, "");
  const close = afterOpen.search(/^---\r?$|^---$/m);
  if (close === -1) return null;

  // One trailing newline is the separator before the closing fence, not a
  // blank line in the block. Keeping it parks an empty line on the last
  // entry's block, which then lands in the MIDDLE of the block as soon as a
  // key is appended after it.
  const raw = afterOpen.slice(0, close).replace(/\r?\n$/, "");
  const body = afterOpen.slice(close).replace(/^---\r?\n?/, "");

  const entries: FrontmatterEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") {
      // A blank line inside the block belongs to whatever came before it; an
      // entry-less blank at the top is representable as nothing.
      if (entries.length > 0) entries[entries.length - 1].block.push(line);
      continue;
    }
    const m = KEY_LINE.exec(line);
    if (m) {
      entries.push({ key: m[1], inline: m[2].trim(), block: [] });
      continue;
    }
    // Not a key line. Only legal as a continuation of the previous key, and
    // only if it is indented — anything else is a shape this module does not
    // understand, and guessing is what caused #299.
    if (entries.length === 0 || !/^\s/.test(line)) return null;
    entries[entries.length - 1].block.push(line);
  }
  return { entries, body };
}

/** Render a parsed block back to text. Round-trips byte-for-byte. */
export function serialiseFrontmatter(parsed: ParsedFrontmatter): string {
  const lines: string[] = [];
  for (const e of parsed.entries) {
    lines.push(e.inline === "" ? `${e.key}:` : `${e.key}: ${e.inline}`);
    lines.push(...e.block);
  }
  // Trailing blanks captured into the last entry's block would double the
  // newline before the closing fence.
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return `---\n${lines.join("\n")}\n---\n${parsed.body}`;
}

/**
 * Add the given fields to a document's frontmatter without removing anything.
 *
 * - A key already present is LEFT AS IT IS, including its block value. The
 *   formatter's job is to fill gaps, not to have opinions about values
 *   somebody wrote on purpose.
 * - New keys are appended in the order given, after everything existing, so a
 *   diff shows additions rather than a reordered block.
 * - A document with no frontmatter gets one.
 * - A block this module cannot parse is returned UNCHANGED, with `stamped`
 *   empty and `refused` set. Leaving a file alone is always safe; rewriting
 *   one you cannot read is what #299 was.
 */
export function stampFrontmatter(
  content: string,
  fields: Record<string, string>,
): { content: string; stamped: string[]; refused: string | null } {
  const hasOpen = OPEN.test(content);
  const parsed = hasOpen ? parseFrontmatter(content) : { entries: [], body: content };

  if (!parsed) {
    return {
      content,
      stamped: [],
      refused:
        "the frontmatter block could not be parsed, so it was left alone. Rewriting a " +
        "block you cannot read is how #299 dropped `description:` from every rules file.",
    };
  }

  const present = new Set(parsed.entries.map(e => e.key));
  const stamped: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (present.has(key)) continue;
    parsed.entries.push({ key, inline: value, block: [] });
    stamped.push(`${key}: ${value}`);
  }

  if (stamped.length === 0) return { content, stamped: [], refused: null };

  const body = hasOpen ? parsed.body : `\n${parsed.body}`;
  return { content: serialiseFrontmatter({ ...parsed, body }), stamped, refused: null };
}

/** The keys a document declares, in order. `[]` when there is no block. */
export function frontmatterKeys(content: string): string[] {
  return parseFrontmatter(content)?.entries.map(e => e.key) ?? [];
}
