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
 * Both directions are refusals, and they are two DIFFERENT questions asked of
 * two different things (#605):
 *
 *   - **keyword -> undeclared.** A closing keyword in the title, body or
 *     commit message that the record never declared is #586 happening again.
 *     Unchanged since #590; this is the half that has earned its place twice.
 *   - **declared -> not closed.** An id in `issues_closed` that is not CLOSED
 *     on GitHub is a record that reads done over an issue that is not.
 *
 * ## Why the second question is no longer asked of the text (#605)
 *
 * It used to be "a declared close with no keyword behind it". That reads
 * `issues_closed` as *what this PR will close*, and it is not: it is *what
 * the session closed*, across days of work and many PRs, almost all of them
 * merged before the state PR exists. Session 50 declared #274, #585, #586 and
 * #590 — four issues closed by four of their own PRs — and the check refused
 * all four, correctly given its model and false about the world.
 *
 * The way to make it stop was to write four no-op closing keywords into the
 * PR body, and then — purer and worse — into `session.summary`, a position
 * GitHub never parses. Four records in a row did it. That is satisfying the
 * proxy instead of the property, and the proxy it satisfies is **writing
 * closing keywords into narrative prose**, which is the exact defect #590 was
 * filed over. The check was manufacturing its own failure mode.
 *
 * So the declared side asks GitHub. A record declaring an id that is already
 * CLOSED passes with no keyword anywhere, and the incentive disappears.
 *
 * ## An unreachable GitHub is UNMEASURED, and UNMEASURED is not clean
 *
 * The declared side needs a reading this file cannot take locally, so it has
 * a third state. `0`, `{}`, `null` and `SKIP` are indistinguishable from
 * success; UNMEASURED is not. A declared id with no reading behind it refuses
 * and says so by name — see `.claude/rules/config-access.md`.
 *
 * Usage:
 *   bun scripts/check-state-record-closes.ts --state project-state.json \
 *       [--title "<pr title>"] [--body-file <f>] [--message-file <f>] \
 *       [--repo owner/name] [--issue-states github|<file.json>]
 *
 * `--issue-states github` asks the GitHub REST API (needs `--repo`, and
 * `GITHUB_TOKEN`/`GH_TOKEN` for a private repository). `--issue-states <file>`
 * reads a JSON object mapping issue number to `OPEN` or `CLOSED`, which is how
 * the suite drives the declared side without a network. With neither, there is
 * no reading, and every declared id is UNMEASURED.
 *
 * Exits 0 and prints its own coverage when both questions are clean; exits
 * STATE_CLOSES_REFUSE_EXIT and names what it found when they are not.
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
    const num = Number(g.num ?? g.urlNum);
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

/**
 * What GitHub says about one declared id.
 *
 * `UNMEASURED` is a state, not a missing value. An id nobody could ask about
 * is not an id that is closed, and it is not an id that is open either.
 */
export type IssueState = "OPEN" | "CLOSED" | "UNMEASURED";

/** One reading of GitHub, however it was taken. */
export interface IssueStateReading {
  /**
   * Issue number to state. An id absent from the map is UNMEASURED — the
   * reading does not get to be silent about an id it never reached.
   */
  states: Record<number, IssueState>;
  /** Why a given id is UNMEASURED, when the reader knows. */
  reasons?: Record<number, string>;
  /** How the reading was taken, for the coverage line. */
  source?: string;
}

/** One session record, reduced to the things the two questions read. */
export interface StateRecordCloses {
  /**
   * The texts GitHub will parse. Every one of the PR title, the PR body and
   * the commit message is read, because a keyword in any of them closes.
   *
   * Read by the keyword -> undeclared question and by nothing else.
   */
  texts: { label: string; text: string }[];
  /** The record's own `Issues closed:` list. Read by both questions. */
  declared: number[];
  /** `owner/name`, or `null` when it is not known. */
  repo?: string | null;
  /**
   * GitHub's state for each declared id, or `null` when no reading was taken.
   *
   * Read by the declared -> not closed question and by nothing else, which is
   * what makes the two questions separable: a record with no keyword anywhere
   * is reachable only by this one, and a record declaring nothing is
   * reachable only by the other.
   */
  issueStates?: IssueStateReading | null;
}

const list = (ns: number[]) => (ns.length ? ns.join(", ") : "(none)");

/** The reading, rendered so a refusal says what was known and what was not. */
function statesLine(declared: number[], reading: IssueStateReading | null): string {
  const where = reading?.source ? ` (read from ${reading.source})` : "";
  if (reading === null) return `GitHub states${where}: (no reading was taken)`;
  const pairs = declared.map(n => `#${n}=${reading.states[n] ?? "UNMEASURED"}`);
  return `GitHub states${where}: ${pairs.length ? pairs.join(", ") : "(nothing declared)"}`;
}

/**
 * Every declared id that is not CLOSED on GitHub, in one list.
 *
 * ONE binding, deliberately: this is the whole declared-side decider, so
 * `test/closing-keywords.test.ts`'s mutation has exactly one thing to
 * short-circuit and the count it measures is the count of cases that depend
 * on it. A second place that re-asked the same question would survive the
 * mutation and hold those cases up — the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 *
 * It reads NO text. That is the point of #605: this question cannot be
 * answered by anything an author writes, so it cannot be satisfied by a
 * gesture, which is what the keyword version was.
 */
export function declaredClosureViolations(
  declared: number[],
  reading: IssueStateReading | null,
): string[] {
  const ids = [...new Set(declared)].sort((a, b) => a - b);
  if (ids.length === 0) return [];
  const context = statesLine(ids, reading);
  const out: string[] = [];
  for (const n of ids) {
    const state: IssueState = reading === null
      ? "UNMEASURED"
      : reading.states[n] ?? "UNMEASURED";
    if (state === "CLOSED") continue;
    if (state === "OPEN") {
      out.push(
        `the record declares #${n} closed, but #${n} is OPEN on GitHub, so the record reads ` +
          `done while the issue is not. ${context}`,
      );
      continue;
    }
    const why = reading?.reasons?.[n]
      ?? (reading === null
        ? "no reading was taken — pass --issue-states github or --issue-states <file>"
        : "the reading did not reach it");
    out.push(
      `the record declares #${n} closed, and GitHub's state for #${n} is UNMEASURED ` +
        `(${why}). An unreachable GitHub is not a closed issue and not a clean record. ${context}`,
    );
  }
  return out;
}

/**
 * Both questions, asked once each, in one list.
 *
 * The CLI below re-checks nothing — two guards answering the same question
 * about the same input are behaviourally one guard, and a mutation of either
 * leaves the other holding the case up. The two questions here are not that:
 * they read disjoint inputs (`texts` and `issueStates`) and each has an input
 * the other cannot reach, which is the second remedy
 * `.claude/rules/checks-must-be-able-to-fail.md` prescribes for a pair.
 */
export function stateRecordCloseViolations(record: StateRecordCloses): string[] {
  return [
    ...keywordCloseViolations(record),
    // The declared side. It reads no text, and the keyword side reads no
    // GitHub state, so neither can hold the other's cases up.
    ...declaredClosureViolations(record.declared, record.issueStates ?? null),
  ];
}

/**
 * The keyword -> undeclared question, unchanged since #590.
 *
 * The other half of the pair, and the one exported binding for it. Its input
 * is `texts`; it never looks at `issueStates`, which is what makes a record
 * declaring nothing an input only this decider can reach.
 */
export function keywordCloseViolations(record: StateRecordCloses): string[] {
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

  return out;
}

/** What the run read, so a PASS is distinguishable from a PASS over nothing. */
export function coverageLine(record: StateRecordCloses): string {
  const present = record.texts.filter(t => t.text.trim().length > 0);
  const refs = present.flatMap(t => closingReferences(t.text, { label: t.label, repo: record.repo ?? null }));
  const mine = refs.filter(r => r.target === "this-repo");
  const declared = [...new Set(record.declared)].sort((a, b) => a - b);
  const reading = record.issueStates ?? null;
  // A PASS over a record that declared nothing and a PASS over a record whose
  // five declared ids were each read from GitHub are the same verdict, and no
  // reader can tell them apart from a verdict alone.
  const resolved = reading === null
    ? 0
    : declared.filter(n => (reading.states[n] ?? "UNMEASURED") !== "UNMEASURED").length;
  return (
    `${present.length} of ${record.texts.length} texts read ` +
    `(${present.map(t => t.label).join(", ") || "none"}), ` +
    `${refs.length} closing references found, ${mine.length} in this repository, ` +
    `${declared.length} declared, ` +
    `${resolved} of ${declared.length} declared ids read from GitHub` +
    `${reading?.source ? ` via ${reading.source}` : ""}`
  );
}

/**
 * Ask GitHub the state of each id.
 *
 * `fetchImpl` is the one injection seam, so the suite can drive every branch
 * — open, closed, 404, a non-JSON body, a thrown request — without a network
 * and without mutating the environment. An id the call could not resolve is
 * simply absent from `states`, which `declaredClosureViolations` reads as
 * UNMEASURED; it is never defaulted to either real state.
 */
export async function fetchIssueStates(
  repo: string | null,
  ids: number[],
  opts: { token?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<IssueStateReading> {
  const states: Record<number, IssueState> = {};
  const reasons: Record<number, string> = {};
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  if (!repo) {
    for (const n of unique) reasons[n] = "no --repo was supplied, so there is nothing to ask";
    return { states, reasons, source: "github" };
  }
  const call = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  for (const n of unique) {
    try {
      const res = await call(`https://api.github.com/repos/${repo}/issues/${n}`, { headers });
      if (!res.ok) {
        reasons[n] = `GitHub answered HTTP ${res.status}`;
        continue;
      }
      const body = (await res.json()) as { state?: unknown };
      const raw = typeof body.state === "string" ? body.state.toLowerCase() : "";
      if (raw === "closed") states[n] = "CLOSED";
      else if (raw === "open") states[n] = "OPEN";
      else reasons[n] = `GitHub returned no readable state (${JSON.stringify(body.state)})`;
    } catch (e) {
      reasons[n] = `the request failed — ${(e as Error).message}`;
    }
  }
  return { states, reasons, source: `github:${repo}` };
}

/**
 * A reading from a JSON file: `{"662": "CLOSED", "640": "OPEN"}`.
 *
 * An unreadable value THROWS rather than being dropped, for the reason
 * `parseDeclaredCloses` throws: a typo must not be the cheapest way past the
 * comparison. An id simply absent from the file is UNMEASURED, which is a
 * different thing and is handled by the decider, not here.
 */
export function parseIssueStatesFile(raw: string, source: string): IssueStateReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new StateCloseRefused(`${source} could not be read as JSON — ${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StateCloseRefused(`${source} is not a JSON object of issue number to state`);
  }
  const states: Record<number, IssueState> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const n = Number(String(key).replace(/^#/, "").trim());
    if (!Number.isInteger(n) || n <= 0) {
      throw new StateCloseRefused(`${source} holds the key ${JSON.stringify(key)}, which is not an issue number`);
    }
    const state = String(value).toUpperCase();
    if (state !== "OPEN" && state !== "CLOSED" && state !== "UNMEASURED") {
      throw new StateCloseRefused(
        `${source} says #${n} is ${JSON.stringify(value)} — only OPEN, CLOSED or UNMEASURED can be read`,
      );
    }
    states[n] = state as IssueState;
  }
  return { states, source };
}

const OPTIONS = new Set(["state", "title", "body-file", "message-file", "repo", "issue-states"]);

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

/**
 * Resolve the declared-side reading from whatever the caller asked for.
 *
 * `null` is returned only when the caller asked for nothing, and `null` is
 * the state that makes every declared id UNMEASURED. It is never a quiet
 * stand-in for "probably all closed".
 */
export async function readingFor(
  args: Record<string, string>,
  declared: number[],
  env: Record<string, string | undefined> = process.env,
): Promise<IssueStateReading | null> {
  const asked = args["issue-states"];
  if (!asked) return null;
  if (asked === "github") {
    return fetchIssueStates(args.repo ?? null, declared, {
      token: env.GITHUB_TOKEN ?? env.GH_TOKEN ?? null,
    });
  }
  let raw: string;
  try {
    raw = readFileSync(asked, "utf-8");
  } catch (e) {
    throw new StateCloseRefused(`--issue-states ${asked} could not be read — ${(e as Error).message}`);
  }
  return parseIssueStatesFile(raw, asked);
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
    const base = recordFromState(parsed, args);
    const record: StateRecordCloses = {
      ...base,
      issueStates: await readingFor(args, base.declared),
    };
    const violations = stateRecordCloseViolations(record);
    if (violations.length > 0) {
      console.error(`state-record-closes: ${coverageLine(record)}`);
      console.error(`state-record-closes: this record does not hold up:`);
      for (const v of violations) console.error(`  - ${v}`);
      process.exit(STATE_CLOSES_REFUSE_EXIT);
    }
    console.log(`state-record-closes: OK — ${coverageLine(record)}`);
  } catch (e) {
    console.error(`state-record-closes: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(STATE_CLOSES_REFUSE_EXIT);
  }
}
