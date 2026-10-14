/**
 * Which backtick spans in AGENTS.md are file references (#380).
 *
 * `refreshAgentsMd` checked that every path mentioned in AGENTS.md resolves.
 * Its pattern was:
 *
 * ```
 * /`([^`]+\.(md|json|ts|js|tsx|yml|yaml))`/g
 * ```
 *
 * **A backtick span is not a path.** AGENTS.md has a Commands table, and
 * several of its commands end in a filename, so the whole command string was
 * handed to `existsSync`. Measured on this repo at the time of the fix:
 *
 * | span | verdict | correct? |
 * |---|---|---|
 * | `bun scripts/typecheck.ts` | BROKEN | no |
 * | `bun scripts/test-clean-env.ts` | BROKEN | no |
 * | `bun test test/scaffold-conformity.test.ts` | BROKEN | no |
 *
 * Three reports, three false positives, and **zero** true positives — the
 * check had never once validated a real reference here.
 *
 * That is worse than noise. A standing false positive trains readers to
 * ignore the whole class, so the day it finds a genuinely dangling pointer
 * nobody looks. It is also unfixable from the doc's side: the span is not a
 * path, so no edit to AGENTS.md makes it green except deleting the Commands
 * row — the detector dictating the document.
 *
 * ## The predicate
 *
 * Positive, not a blacklist. A reference is a span that is *nothing but* a
 * path: path characters only, ending in a known extension. A blacklist of
 * "things that look like commands" is the detector-narrower-than-what-it-
 * detects shape from `.claude/rules/checks-must-be-able-to-fail.md`, one
 * unanticipated command away from being wrong again.
 *
 * ## The direction this is allowed to be wrong in
 *
 * Toward NOT reporting. A real path this refuses to check costs a dangling
 * link nobody is told about — recoverable, and the same call
 * `.claude/rules/claiming-sc-coverage.md` makes for the same reason. The
 * other direction is what shipped: a report that cannot be acted on, three
 * times a run, drowning the signal it exists to carry.
 *
 * Deliberately NOT done: extracting the path out of a command and checking
 * that. It would catch more — `bun scripts/typecheck.ts` really does name a
 * file — but a Commands table also holds `<file>` placeholders, generated
 * build outputs and paths relative to somewhere else, and guessing which is
 * which reintroduces the false positives from the other end.
 */

/** Extensions the reference check knows how to resolve. */
const EXTENSIONS = ["md", "json", "ts", "js", "tsx", "yml", "yaml"] as const;

/**
 * A span that is nothing but a relative path ending in a known extension.
 *
 * `[\w.\-/@]` admits what paths in this repo are made of and nothing else.
 * No whitespace, so a command is out. No `:`, so a URL is out. No `<`, `[`
 * or `$`, so a placeholder or a variable is out.
 */
const PATH_SPAN = new RegExp(`^[\\w.\\-/@]+\\.(?:${EXTENSIONS.join("|")})$`);

/** Every backtick span in the document, whether or not it is a path. */
const BACKTICK_SPAN = /`([^`\n]+)`/g;

/**
 * Whether one backtick span should be resolved against the filesystem.
 *
 * The single exported predicate. `refreshAgentsMd` has two scans — broken
 * links and staleness — and they must agree about what a reference is, or
 * the second silently stops covering spans the first rejects.
 */
export function isPathReference(span: string): boolean {
  // No glob guard in front of this. The first draft had
  // `if (span.includes("*")) return false;` and it scored 0 on mutation:
  // `*` is not in the character class, so a glob never reached it. A branch
  // that cannot change an answer reads to the next person as if it can.
  return PATH_SPAN.test(span);
}

/** The path references in a document, in order, deduplicated. */
export function referencedPaths(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(BACKTICK_SPAN)) {
    if (isPathReference(m[1])) out.add(m[1]);
  }
  return [...out];
}
