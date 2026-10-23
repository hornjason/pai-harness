/**
 * A closing keyword GitHub will never act on (#1362).
 *
 * `.claude/rules/ship-workflow.md` says to put `Fixes #<N>` in the PR body and
 * let the merge close the issue. What it cannot say, because nothing in the
 * tree measured it until now, is that **a closing keyword inside a code span
 * is inert**. GitHub parses the body as markdown and does not link a reference
 * it finds inside backticks or a fenced block, so the PR merges, the author
 * sees the sentence they wrote, and the issue stays open.
 *
 * Measured on `hornjason/pai-harness` at 2026-10-23T15:31Z: of **50** open
 * issues, **27** carry at least one merged pull request cross-reference, from
 * **65** distinct merged pull requests. Running this detector over all 65
 * produced **one** report — PR #1208, naming #1148 and #1157. Its second line
 * is the keyword and the number wrapped in backticks, the pull request says in
 * prose that the work is done and verified, and `closingIssuesReferences` is
 * empty. #1148 was rescued by the squash commit subject `fix(#1148): …`;
 * #1157 was not in the title and is still open.
 *
 * ## Why this reports the INERT ones and not the live ones
 *
 * A function that decided which references DO close an issue would be a second
 * decider competing with GitHub's own parser, and the two would agree on
 * almost every input — `.claude/rules/checks-must-be-able-to-fail.md`'s fourth
 * shape, where no behavioural test can tell a dead guard from a live one.
 *
 * This reports only what a caller can check against the API's own answer: the
 * caller already knows `closingIssuesReferences`, and an empty one beside a
 * keyword the author clearly meant is a disagreement worth refusing on. The
 * question asked here is "did you write something that looks like it closes an
 * issue and does not", which GitHub does not answer anywhere.
 *
 * ## Why the keyword must be ADJACENT to the number
 *
 * This repository writes negations constantly — `.claude/rules/` tells agents
 * never to put a closing keyword next to an issue number they are not closing,
 * and they comply by writing the denial in prose instead.
 *
 * The negative control, over the same 65 merged pull requests: loosening
 * "adjacent" to "within 40 characters" produced **21** candidates, of which
 * the same two were true and **19** were false. Three kinds of false, and only
 * the first is a negation:
 *
 * - a denial — `Closes nothing — #523 stays open`, `Fixes nothing on its own —
 *   leaving #713 open`, `Neither issue is closed by this PR`;
 * - prose about a DIFFERENT issue — `| #1281 | … | fixed, merged as #1288 |`;
 * - a window artefact, where the 40 characters end mid-number and the
 *   candidate names an issue nobody wrote.
 *
 * So adjacency is not a convenience, it is the whole precision of the check,
 * and widening it is the cheapest wrong fix available here: on the only corpus
 * that exists, the loosened rule is wrong nineteen times out of twenty-one.
 */

/**
 * The verbs GitHub acts on, in one declaring position.
 *
 * Taken from GitHub's documented list rather than invented. Every form is
 * spelled out instead of stemmed: `close|closes|closed` and not `close[sd]?`
 * with a comment, because a reader checking this against the documentation
 * compares a list to a list.
 */
export const CLOSING_KEYWORDS: readonly string[] = [
  "close",
  "closes",
  "closed",
  "fix",
  "fixes",
  "fixed",
  "resolve",
  "resolves",
  "resolved",
];

/** One closing keyword that is present in the prose and inert in the markup. */
export interface InertClosingReference {
  /** The issue number the author wrote. */
  issue: number;
  /** The keyword as they spelled it, case preserved, for the message. */
  keyword: string;
  /** Which markup swallowed it. */
  reason: "code-span" | "fenced-block";
  /** The matched text, so a message can quote what to change. */
  text: string;
}

/**
 * Byte ranges the GitHub markdown parser will not scan for references.
 *
 * Fenced blocks are taken first and their ranges removed from the input the
 * span scanner sees, because a fence contains backticks by definition and a
 * span scanner run over the raw body would pair the fence delimiters with each
 * other and report nonsense.
 */
function maskedRanges(body: string): { start: number; end: number; reason: InertClosingReference["reason"] }[] {
  const out: { start: number; end: number; reason: InertClosingReference["reason"] }[] = [];
  const fenced = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm;
  for (const m of body.matchAll(fenced)) {
    out.push({ start: m.index!, end: m.index! + m[0].length, reason: "fenced-block" });
  }
  const inFence = (i: number) => out.some(r => i >= r.start && i < r.end);
  // Single-line code spans. `[^`\n]+` keeps a span from spilling across a line,
  // which is what an unmatched backtick in ordinary prose would otherwise do —
  // and an unmatched backtick is common in a body that quotes shell.
  for (const m of body.matchAll(/(`+)([^`\n]+?)\1/g)) {
    if (inFence(m.index!)) continue;
    out.push({ start: m.index!, end: m.index! + m[0].length, reason: "code-span" });
  }
  return out;
}

/**
 * Closing keywords in `body` that name an issue and will not fire.
 *
 * Deduplicated by issue number: a body that names the same issue twice inside
 * backticks is one mistake, not two, and a message listing it twice reads as
 * two problems to fix.
 */
export function inertClosingReferences(body: string): InertClosingReference[] {
  if (!body) return [];
  const ranges = maskedRanges(body);
  const pattern = new RegExp(`\\b(${CLOSING_KEYWORDS.join("|")})\\b[ \\t]*:?[ \\t]*#(\\d+)\\b`, "gi");
  const seen = new Set<number>();
  const out: InertClosingReference[] = [];
  for (const m of body.matchAll(pattern)) {
    const hit = ranges.find(r => m.index! >= r.start && m.index! < r.end);
    if (!hit) continue;
    const issue = Number.parseInt(m[2]!, 10);
    if (seen.has(issue)) continue;
    seen.add(issue);
    out.push({ issue, keyword: m[1]!, reason: hit.reason, text: m[0] });
  }
  return out;
}

/**
 * The refusal text.
 *
 * It names the issue, the markup and the remedy, because
 * `.claude/rules/self-referential-tests.md` is explicit that a check without a
 * remedy is an obstacle. The remedy here is one character of punctuation, so
 * the message says exactly which.
 */
export function inertClosingMessage(refs: InertClosingReference[], prNumber: number): string {
  const rows = refs
    .map(r => `  ${r.text}  — inside a ${r.reason}, so GitHub never linked it (issue #${r.issue})`)
    .join("\n");
  return (
    `PR #${prNumber} has no closingIssuesReferences, and its body names ` +
    `${refs.length === 1 ? "an issue" : "issues"} with a closing keyword that the markdown ` +
    `parser cannot see:\n${rows}\n\n` +
    `GitHub does not read a reference inside backticks or a fenced block, so this ` +
    `pull request records no link to them and the merge will not close them. ` +
    `Something else still might — PR #1208 carried two inert references and its squash ` +
    `commit subject, "fix(#1148): …", closed that one anyway, while #1157 was not in ` +
    `the title and stayed open after the body said in prose it was done. Do not rely ` +
    `on that: it is a conventional-commit prefix that happens to be a closing keyword. ` +
    `Remove the backticks from that line, then re-read the field rather than the body: ` +
    `gh pr view ${prNumber} --json closingIssuesReferences. If the reference is ` +
    `deliberately inert because you are quoting a keyword rather than using one, move ` +
    `the quote so the number is not adjacent to the verb.`
  );
}
