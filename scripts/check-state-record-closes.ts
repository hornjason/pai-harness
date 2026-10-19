#!/usr/bin/env bun
/**
 * Which issues will GitHub close when this session record becomes a PR? (#590)
 *
 * PR #588's squash commit carried `Filed and not fixed: #586`, rendered from
 * `project-state.json`'s session-49 summary. GitHub's closing-keyword parser
 * sees `fixed: #586`; it has no concept of the `not` in front of it. #586
 * closed one second after the merge with `stateReason: COMPLETED`, having
 * shipped nothing.
 *
 * "Filed and not fixed" is the phrase this project uses for deliberately
 * deferred work, so the exposure is not a one-off typo: **the more honest the
 * session record, the more issues it wrongly closes.** It has happened twice
 * already — `lib/issue-closure-audit.ts` records "not yet fixed: #178"
 * auto-closing #178 on 2026-10-08, and says in the same breath that it
 * deliberately does not catch it, because an auto-close carries a `commit_id`
 * and that audit asks about attribution.
 *
 * So the question here is the one neither of them asks: before the PR is
 * opened, does the set of issues GitHub would close from its title, body and
 * commit message equal the set the record SAYS it closed?
 *
 * Both directions are refusals:
 *   - a keyword-derived close that is not declared is #586 happening again;
 *   - a declared close with no keyword behind it is a record claiming a
 *     closure the PR will not perform, which reads as done and is not.
 *
 * Usage:
 *   bun scripts/check-state-record-closes.ts --state project-state.json \
 *       [--title "<pr title>"] [--body-file <f>] [--message-file <f>] \
 *       [--repo owner/name]
 *
 * Exits 0 and prints its own coverage when the sets agree; exits
 * STATE_CLOSES_REFUSE_EXIT and names both sets when they do not.
 *
 * ## Why this is not called from scripts/update-project-state.ts
 *
 * That was the obvious home for it, and it is the wrong one. The renderer's
 * only caller is `.git/hooks/pre-commit`, which invokes it as
 * `bun scripts/update-project-state.ts 2>/dev/null || true` — stderr
 * discarded, exit code discarded. A refusal wired in there would be silent,
 * and its only observable effect would be that PROJECT-STATE.md quietly
 * stopped being re-rendered. That is a fail-open amplifier rather than a
 * guard: the file whose entire purpose is telling the next session where the
 * project is would go stale, and nothing would say so.
 *
 * So the comparison is executed from the suite instead —
 * `test/closing-keywords.test.ts` runs it over the real `project-state.json`
 * on every run, with the current exposure banked by number — and from here,
 * before a state PR is opened. Measured on this tree, the live session-49
 * record reports exactly one finding, #586, which is the defect this issue
 * is about and which only the DA can repair (`project-state.json` is
 * DA-owned, #296).
 *
 * TWO PROPERTIES THIS FILE MUST KEEP, both asserted by
 * test/state-record-closes-mutation.test.ts (see
 * .claude/rules/checks-must-be-able-to-fail.md):
 *
 *   1. Every refusal exits through STATE_CLOSES_REFUSE_EXIT, declared exactly
 *      once. The test builds a mutant copy with that constant set to 0 and
 *      runs every negative case twice — real refuses, mutant does not. An
 *      exit written with a literal code would slip past the mutation, and the
 *      case guarding it would become indistinguishable from one passing by
 *      accident.
 *   2. No relative imports. The mutant runs from a temp directory, and a
 *      relative import of anything under lib/ would make it die on module
 *      resolution — a non-zero exit that reads as the mutation having been
 *      rejected on the merits.
 *
 * Both guards look at the whole file, prose included, for the reason
 * scripts/rook-review-scope.ts gives: a detector that first strips comments
 * is a detector whose view of the input can silently shrink.
 */

import { readFileSync } from "fs";

/** The one exit code every refusal travels through. See note 1 above. */
export const STATE_CLOSES_REFUSE_EXIT = 1;

export class StateCloseRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateCloseRefused";
  }
}

/**
 * The nine words GitHub treats as closing keywords.
 *
 * Exported so the form table can assert it exercises every one of them. A
 * table that silently lost a keyword would stay green on the rows it kept,
 * which is "a detector narrower than what it detects" wearing a test's
 * clothes.
 */
export const CLOSING_KEYWORDS = [
  "close", "closes", "closed",
  "fix", "fixes", "fixed",
  "resolve", "resolves", "resolved",
] as const;

/**
 * The grammar, in one place.
 *
 * `\b` before the stem is what keeps `prefixes #586` out, and `\b` after it
 * is what keeps `closing #586` out — neither is a keyword, and a session
 * summary is full of both. The separator admits a colon because the colon is
 * the form that shipped the defect (`fixed: #586`), and requires at least one
 * space when there is no colon, so the keyword has to be the token
 * immediately before the reference. That last clause is the whole reason
 * `fixed that for itself in #510`, two sentences away in the same summary, is
 * not a close.
 *
 * Whitespace rather than spaces: a keyword at the end of a wrapped line still
 * closes, and over-detection is the safe direction here. A false refusal
 * costs a reword; a false negative closes somebody's issue.
 */
const KEYWORD_STEM = "(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)";
const SLUG = "[A-Za-z0-9][A-Za-z0-9._-]*\\/[A-Za-z0-9][A-Za-z0-9._-]*";
const CLOSING_REFERENCE = new RegExp(
  `\\b(?<keyword>${KEYWORD_STEM})\\b(?:\\s*:\\s*|\\s+)` +
    `(?:(?<slug>${SLUG})?#(?<num>\\d+)` +
    // `GH-N` is the third form GitHub documents beside `#N` and
    // `owner/repo#N`, and this detector did not read it (#696). A record
    // saying `fixes GH-586` closed #586 and the coverage comparison called it
    // undeclared-free. Over-detection is the safe direction here — see the
    // grammar note above — so the absent form is the one that costs.
    `|GH-(?<ghNum>\\d+)` +
    `|https?:\\/\\/github\\.com\\/(?<urlSlug>${SLUG})\\/(?:issues|pull)\\/(?<urlNum>\\d+))`,
  "gi",
);

/** How much of the sentence in front of a match the refusal quotes. */
const CONTEXT_CHARS = 48;

/** Where a closing reference points, once the repository is known. */
export type ReferenceTarget = "this-repo" | "other-repo" | "unknown";

export interface ClosingReference {
  /** The issue number GitHub would act on. */
  number: number;
  /** The keyword, lowercased. */
  keyword: string;
  /** `owner/name` when the reference named one, `null` for a bare `#N`. */
  slug: string | null;
  /** The matched text — the keyword and the reference, and nothing else. */
  matched: string;
  /**
   * The match with the words in front of it.
   *
   * The refusal quotes this rather than `matched`, because `fixed: #586` on
   * its own looks like a correct close and `Filed and not fixed: #586` does
   * not. The whole defect is a negation GitHub cannot see, so a refusal that
   * also cannot see it tells the reader nothing they can act on.
   */
  context: string;
  /** Which of the record's texts it was found in. */
  label: string;
  /**
   * `unknown` when the reference named a repository and the caller supplied
   * none to compare it against. Not "probably ours" and not "probably not" —
   * both of those are a verdict nobody measured.
   */
  target: ReferenceTarget;
}

/** Every closing reference in one text, in the order GitHub would read them. */
export function closingReferences(
  text: string,
  opts: { label?: string; repo?: string | null } = {},
): ClosingReference[] {
  const label = opts.label ?? "text";
  const repo = opts.repo ? opts.repo.toLowerCase() : null;
  const out: ClosingReference[] = [];
  CLOSING_REFERENCE.lastIndex = 0;
  for (const m of text.matchAll(CLOSING_REFERENCE)) {
    const g = m.groups ?? {};
    const slug = (g.slug ?? g.urlSlug ?? null) as string | null;
    const num = Number(g.num ?? g.ghNum ?? g.urlNum);
    if (!Number.isFinite(num)) continue;
    const target: ReferenceTarget = slug === null
      ? "this-repo"
      : repo === null
        ? "unknown"
        : slug.toLowerCase() === repo
          ? "this-repo"
          : "other-repo";
    const start = Math.max(0, (m.index ?? 0) - CONTEXT_CHARS);
    const context = (start > 0 ? "…" : "") + text.slice(start, (m.index ?? 0) + m[0].length);
    out.push({
      number: num,
      keyword: (g.keyword ?? "").toLowerCase(),
      slug,
      matched: m[0],
      context: context.replace(/\s+/g, " ").trim(),
      label,
      target,
    });
  }
  return out;
}

/**
 * The record's declared closures, from whatever shape the record holds them
 * in. `project-state.json` writes an array of numbers; the renderer turns it
 * into the comma-joined string `PROJECT-STATE.md` shows.
 *
 * An entry that is not a number THROWS rather than being dropped, because
 * dropping it would make a typo the cheapest way past the comparison.
 */
export function parseDeclaredCloses(raw: unknown): number[] {
  if (raw === undefined || raw === null) return [];
  const parts = Array.isArray(raw)
    ? raw
    : String(raw).split(/[,\s]+/).filter(Boolean);
  const out: number[] = [];
  for (const part of parts) {
    const n = typeof part === "number" ? part : Number(String(part).replace(/^#/, "").trim());
    if (!Number.isInteger(n) || n <= 0) {
      throw new StateCloseRefused(
        `"Issues closed:" holds ${JSON.stringify(part)}, which is not an issue number — ` +
          `the comparison cannot tell a typo from a closure nobody declared`,
      );
    }
    out.push(n);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** One session record, reduced to the two things the comparison reads. */
export interface StateRecordCloses {
  /**
   * The texts GitHub will parse. Every one of the PR title, the PR body and
   * the commit message is read, because a keyword in any of them closes.
   */
  texts: { label: string; text: string }[];
  /** The record's own `Issues closed:` list. */
  declared: number[];
  /** `owner/name`, or `null` when it is not known. */
  repo?: string | null;
}

const list = (ns: number[]) => (ns.length ? ns.join(", ") : "(none)");

/**
 * Every disagreement between what GitHub will close and what the record says,
 * in one list.
 *
 * One decider, one binding to mutate. The CLI below re-checks nothing — two
 * guards answering the same question about the same input are behaviourally
 * one guard, and a mutation of either leaves the other holding the case up.
 */
export function stateRecordCloseViolations(record: StateRecordCloses): string[] {
  const repo = record.repo ?? null;
  const present = record.texts.filter(t => t.text.trim().length > 0);
  if (present.length === 0) {
    return [
      `no text was read, so nothing was compared. "No closes found in zero texts" and ` +
        `"no closes found" are the same string — supply the PR title, body and commit message.`,
    ];
  }

  const refs = present.flatMap(t => closingReferences(t.text, { label: t.label, repo }));
  const out: string[] = [];

  for (const r of refs) {
    if (r.target !== "unknown") continue;
    out.push(
      `${r.label} says "${r.matched}" and no repository was supplied, so which repository ` +
        `${r.slug}#${r.number} belongs to is unknown. Pass --repo owner/name.`,
    );
  }

  const keywordSet = [...new Set(refs.filter(r => r.target === "this-repo").map(r => r.number))]
    .sort((a, b) => a - b);
  const declared = [...new Set(record.declared)].sort((a, b) => a - b);
  const both =
    `keyword-derived closes: [${list(keywordSet)}]; declared "Issues closed:": [${list(declared)}]`;

  for (const n of keywordSet) {
    if (declared.includes(n)) continue;
    const where = refs.find(r => r.number === n && r.target === "this-repo")!;
    out.push(
      `GitHub will CLOSE #${n} from the ${where.label} — "${where.context}" — but #${n} is ` +
        `not in the record's "Issues closed:" list. Reword it or declare it. ${both}`,
    );
  }

  for (const n of declared) {
    if (keywordSet.includes(n)) continue;
    out.push(
      `the record declares #${n} closed, but no closing keyword in the title, body or commit ` +
        `message will make GitHub close it, so #${n} stays open while the record reads done. ${both}`,
    );
  }

  return out;
}

/** What the run read, so a PASS is distinguishable from a PASS over nothing. */
export function coverageLine(record: StateRecordCloses): string {
  const present = record.texts.filter(t => t.text.trim().length > 0);
  const refs = present.flatMap(t => closingReferences(t.text, { label: t.label, repo: record.repo ?? null }));
  const mine = refs.filter(r => r.target === "this-repo");
  return (
    `${present.length} of ${record.texts.length} texts read ` +
    `(${present.map(t => t.label).join(", ") || "none"}), ` +
    `${refs.length} closing references found, ${mine.length} in this repository, ` +
    `${[...new Set(record.declared)].length} declared`
  );
}

const OPTIONS = new Set(["state", "title", "body-file", "message-file", "repo"]);

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const m = /^--([A-Za-z][A-Za-z-]*)$/.exec(arg);
    if (!m) {
      throw new StateCloseRefused(`unexpected argument "${arg.slice(0, 80)}" — every input is a --flag with a value`);
    }
    if (!OPTIONS.has(m[1])) {
      throw new StateCloseRefused(`unknown option --${m[1]}`);
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new StateCloseRefused(`--${m[1]} needs a value`);
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * The record the CLI compares, read out of `project-state.json` plus whatever
 * the caller is about to push.
 *
 * The session summary is included because it IS the commit message: PR #588's
 * squash commit was the summary, verbatim, which is how #586 closed.
 */
export function recordFromState(state: unknown, args: Record<string, string>): StateRecordCloses {
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new StateCloseRefused("the state document is not an object");
  }
  const session = (state as Record<string, unknown>).session;
  if (session === undefined || session === null || typeof session !== "object") {
    throw new StateCloseRefused(
      `the state document has no "session" record, so there is no "Issues closed:" list to compare against`,
    );
  }
  const s = session as Record<string, unknown>;
  const texts: { label: string; text: string }[] = [
    { label: "session summary", text: String(s.summary ?? "") },
  ];
  if (args.title) texts.push({ label: "pull request title", text: args.title });
  if (args["body-file"]) {
    texts.push({ label: "pull request body", text: readFileSync(args["body-file"], "utf-8") });
  }
  if (args["message-file"]) {
    texts.push({ label: "commit message", text: readFileSync(args["message-file"], "utf-8") });
  }
  return { texts, declared: parseDeclaredCloses(s.issues_closed), repo: args.repo ?? null };
}

// CLI entry point. Guarded so the module can be imported by tests without
// running the comparison and calling process.exit.
if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.state) {
      throw new StateCloseRefused("--state is required: the comparison needs the record it is checking");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(args.state, "utf-8"));
    } catch (e) {
      throw new StateCloseRefused(`${args.state} could not be read as JSON — ${(e as Error).message}`);
    }
    const record = recordFromState(parsed, args);
    const violations = stateRecordCloseViolations(record);
    if (violations.length > 0) {
      console.error(`state-record-closes: ${coverageLine(record)}`);
      console.error(`state-record-closes: this record and the PR it becomes disagree:`);
      for (const v of violations) console.error(`  - ${v}`);
      process.exit(STATE_CLOSES_REFUSE_EXIT);
    }
    console.log(`state-record-closes: OK — ${coverageLine(record)}`);
  } catch (e) {
    console.error(`state-record-closes: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(STATE_CLOSES_REFUSE_EXIT);
  }
}
