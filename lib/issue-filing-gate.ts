/**
 * Adjudicate a `gh issue create` BEFORE it becomes an issue (#1261).
 *
 * ## The gap this closes
 *
 * `lib/finding-arbiter.ts`, `lib/finding-jury.ts` and
 * `scripts/arbitrate-finding.ts` decide whether a finding is worth filing.
 * All three are built and tested. Measured on `origin/main` at `3969cdae`:
 * `hooks/VerifyPhaseLock.hook.ts` contained **zero** references to either
 * `arbiter` or `arbitrate`, and the only mention of the CLI anywhere in the
 * tree is `package.json`'s `files[]` — the line that *publishes* it. So the
 * adjudicator existed and nothing on the filing path called it, which is
 * #1241's defect ("a library function with no production caller is not
 * shipped, however well tested") standing in front of the mechanism that is
 * supposed to control the intake rate of the whole backlog.
 *
 * What the chokepoint gated on instead was whether the agent had typed
 * `--label follow-up`. That is a test that somebody typed a string, not a
 * test that a finding earned a filing, and every agent who wants to file
 * learns to type it.
 *
 * ## Only two stages are decidable here, and that is on purpose
 *
 * `arbitrate` runs five stages. Three of them cannot run at a PreToolUse
 * hook: there is no verifier group to convene, no PR whose changed files
 * would make `Pre-existing` decidable, and no branch to scope against.
 * `arbitrate` says so itself — `votes === undefined` is `UNMEASURED`, so
 * calling it from here would refuse every filing for a reason that is about
 * the hook and not about the finding.
 *
 * So this runs the two stages that ARE decidable from a command line and an
 * issue list, through the arbiter's own bindings rather than new ones:
 *
 * | stage | question | binding | on failure |
 * |---|---|---|---|
 * | category | is it the kind we post at all? | `classifyCategory` + `DROPPED_CATEGORIES` | `DROPPED_CATEGORY` |
 * | dedupe | is this new? | `duplicateCollisions` | `DUPLICATE` |
 *
 * Category first, because it is free and the dedupe costs a `gh issue list`.
 * That is `arbitrate`'s own cost-order doctrine, applied to a different pair
 * of instruments. It is also the pair #1261 asks for in those words — *the
 * blog's mechanism is about duplicates and already-known, which is
 * measurable* — and the reason there is deliberately **no severity gate and
 * no worthiness score** here.
 *
 * ## UNMEASURED: where the issue and the lane brief disagreed, and why
 *
 * Stated because the two instructions this was built from point in opposite
 * directions and a reader will otherwise assume one of them was missed.
 *
 * - #1261's body: *"Anything unreadable → allow and annotate, do not refuse:
 *   a broken adjudicator must not become a gag on the tracker."*
 * - The lane brief: *"An arbiter that cannot run is UNMEASURED, not a pass.
 *   Do not fall through to allowing the filing silently. Say which state you
 *   are in."*
 *
 * They are reconcilable and the resolution is the word *silently*. The
 * **decider** is fail-closed: `adjudicateFiling` never reports `ALLOW` for a
 * reading it did not take — `UNMEASURED` is its own outcome value and is
 * never collapsed into a pass. That is the shape of `resolveThroughLinks` in
 * `lib/bash-write-guard.ts`, whose `catch` returns a distinct "cannot be
 * resolved" rather than a missing one. The **policy** over that outcome is
 * allow, announce it on `systemMessage`, and write the row to the ledger
 * marked `UNMEASURED` so it is countable afterwards.
 *
 * The issue is right about the direction and the argument is worth keeping:
 * this runs on a PreToolUse hook with no retry, so a fail-closed `gh issue
 * list` timeout gags the tracker on a network hiccup, which is strictly worse
 * than the status quo it replaces. The brief is right that a silent
 * fall-through is how a guard rots. Doing both costs one extra outcome value.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * - **Anything that is not Bash.** `curl` against the REST API, the GitHub
 *   MCP tools and a filing from another machine never reach a PreToolUse hook
 *   on Bash. `lib/issue-create-override.ts` lists the rest of that boundary
 *   and it is unchanged here; this file adds a second question at the same
 *   chokepoint, not a wider one.
 * - **A body passed as `--body-file` that cannot be READ** — absent,
 *   oversized, or stdin. The file itself is now opened and adjudicated
 *   (#1300); only a genuine failure to read it is `UNMEASURED`.
 *
 *   This entry used to say that *every* `--body-file` was UNMEASURED, which
 *   was true, documented, and much larger than it sounds: across the last 300
 *   issues on this tracker, 300 have bodies over five lines and 283 exceed
 *   2,000 characters, so the exempted class was in practice the whole
 *   population — and the gate adjudicated the short filings while waving
 *   through the long ones. Worth keeping as a worked instance of the second
 *   shape in `.claude/rules/checks-must-be-able-to-fail.md`: the limitation
 *   was stated plainly and still hid its own size, because nothing had
 *   measured how much of the input it covered. **A declared limitation is not
 *   a priced one.**
 * - **Whether a refusal was right.** The ledger records what was adjudicated,
 *   not what the outcome should have been. It supplies the left-hand side of
 *   that join and nothing more, exactly as `CandidateRecord` says of itself.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

import { githubSlugFromRemoteUrl, resolveRepoSlug } from "./branch-cleanup";
import {
  createGitHubClient,
  listOpenIssues,
  parseOwnerRepo,
  TRUSTED_ASSOCIATIONS,
  type OpenIssuePage,
} from "./github";
import {
  duplicateCollisions,
  symptomHash,
  symptomKeys,
  UNFILED_ID,
  type ArbiterRefusal,
  type Finding,
  type WithheldBy,
} from "./finding-arbiter";
import {
  classifyCategory,
  DROPPED_CATEGORIES,
  type Disposition,
  type FindingCategory,
} from "./finding-jury";
import { clauses, createsIssue, flagValues, labelValues } from "./issue-create-override";

/**
 * The label that waives this gate.
 *
 * Separate from `OVERRIDE_LABELS`, which waives the VERIFY-phase lock. The
 * two gates answer different questions about the same command — *should you
 * be filing right now* and *is this finding worth filing* — and one label
 * waiving both would make it impossible to count how often each was
 * overridden, which is the measurement #1261 exists to start.
 */
export const FILING_OVERRIDE_LABEL = "arbiter-override";

/**
 * How many claims `SUCCESS.md` states under "Done, for the harness".
 *
 * A constant and not a read, because this decision runs inside a hook from an
 * arbitrary working directory and a gate that needs I/O to decide is a gate
 * that fails open when the I/O does. `test/issue-filing-gate.test.ts` binds it
 * to the file — add a claim to `SUCCESS.md` and the suite goes red until this
 * number follows.
 */
export const SUCCESS_CLAIM_COUNT = 6;

/**
 * Which `SUCCESS.md` claim a filing says it moves, or `null` for none.
 *
 * `CLAUDE.md` has required this since the file was written — *"before filing
 * an issue … say which claim it moves. Something that moves none of them is
 * cleanup and should say so rather than borrowing urgency."* It was prose, so
 * nothing executed it, and the tracker grew faster than it drained: measured
 * across 2026-10-23, open issues went 53 → 52 → 55 while the close rate fell
 * from 11/h to 7/h. A backlog that is an output of the review loop cannot be
 * drained by closing faster.
 *
 * The number is BOUNDED rather than merely shaped. `Claim 99` would otherwise
 * satisfy a gate whose whole content is "name one", which is the hole any
 * format-only check has — see `.claude/rules/checks-must-be-able-to-fail.md`
 * on assertions that hold vacuously.
 *
 * Deliberately NOT accepted: a bare `#4`, which is an issue number far more
 * often than a claim, and `SC-4`, which is a success criterion and a different
 * register entirely. The word has to be there.
 */
export function namedClaim(text: string): number | null {
  for (const m of text.matchAll(/\bclaims?\s*#?\s*(\d+)/gi)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= SUCCESS_CLAIM_COUNT) return n;
  }
  return null;
}

/** How many open issues the dedupe compares against. */
export const OPEN_ISSUE_LIMIT = 100;

/**
 * The largest `--body-file` this will read (#1300).
 *
 * A bound and not a guess: the longest issue body on this tracker across its
 * last 300 is a few thousand characters, so 256 KiB is two orders of
 * magnitude of headroom and still refuses to pull an arbitrary file into the
 * hook. Over it is UNMEASURED, which allows — the cap can cost a dedupe, it
 * can never cost a filing.
 */
export const MAX_BODY_FILE_BYTES = 256 * 1024;

/**
 * How long the tracker read gets before the reading is UNMEASURED.
 *
 * Restored after the `gh` → Octokit move deleted it: the CLI call carried a
 * `spawnSync` timeout and Octokit has none by default, so a hung API call
 * hung the agent's Bash tool with no ceiling. A hook has no retry and no
 * patience to spend.
 */
export const OPEN_ISSUE_TIMEOUT_MS = 20_000;

/**
 * The most symptom keys one open issue may contribute to the corpus.
 *
 * A single issue that names a hundred symbols, files and readings matches
 * almost anything, so it suppresses almost anything. On a public repo that is
 * a one-issue denial of service against our own quality mechanism, and it
 * needs no write access to this repository at all.
 *
 * Forty is above every real issue on this tracker — the largest measured,
 * #1261 itself, is well under it — and an issue over the cap is dropped from
 * the comparison set rather than truncated. Truncating would silently keep
 * whichever keys sorted first, which is a reading nobody chose.
 */
export const MAX_KEYS_PER_EXISTING_ISSUE = 40;

/** The most colliding keys a refusal message will quote back. */
const MAX_QUOTED_KEYS = 6;

/** Resolve, or reject, after `ms`. One ceiling for any tracker read. */
export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * One `gh issue create` clause, resolved the way `gh` itself would resolve it.
 *
 * **Every field here is what the consumer will act on, not what the command
 * mentions.** That is the whole contract of this type, and it exists because
 * the first version did not have it: the gate adjudicated `flagValues(...)`
 * joined together while `gh` uses pflag, which is LAST-WINS — so
 * `--title <benign> --title <real finding>` was adjudicated on both and filed
 * as the second. Five rounds of review produced four separate reports of that
 * one shape (first-vs-last title, the body read, the `--repo` target, the
 * page cap), which is the signature of a class rather than four defects.
 * `resolveFiling` is the single binding, so a fifth cannot be written.
 */
export interface FilingAttempt {
  title: string;
  body: string;
  labels: string[];
  /**
   * The path given to `--body-file` / `-F`, or `null` when the body is
   * inline. `"-"` is stdin and is not a path.
   *
   * The PATH and not a boolean (#1300): a flag saying only *that* the body is
   * elsewhere is enough to declare the filing unreadable and not enough to
   * read it, which is how the dedupe came to skip the filings most worth
   * deduplicating.
   */
  bodyFile: string | null;
  /**
   * The tracker this filing targets, from `--repo`/`-R`, or `null` for the
   * working directory's own. Read because deduplicating a filing aimed at
   * one repository against a different repository's open issues is not a
   * weaker reading, it is the wrong one.
   */
  repo: string | null;
  /**
   * A title, body or body-file flag appeared more than once.
   *
   * Recorded rather than refused. Last-wins already resolves it to what `gh`
   * will post, so there is no differential left to guard against — but the
   * shape is not one anybody types by accident, and a column that can be
   * counted later is worth more than a refusal nobody can audit.
   */
  repeatedValueFlag: boolean;
}

/**
 * ALLOW and REFUSE are decisions. UNMEASURED is neither, and it is a value of
 * its own so that no caller can mistake it for the first one.
 */
export type FilingOutcome = "ALLOW" | "REFUSE" | "UNMEASURED";

export interface FilingAdjudication {
  outcome: FilingOutcome;
  refusal: ArbiterRefusal | null;
  /** Why, in words a reader can act on without re-running anything. */
  reason: string;
  category: FindingCategory;
  duplicateOf: string[];
  collidingKeys: string[];
  symptomHash: string;
}

/**
 * One adjudication, in the field names `CandidateRecord` already uses.
 *
 * Deliberately a superset of that interface rather than a new vocabulary:
 * `arbitrateBatch` writes `CandidateRecord` rows for findings it considered
 * inside a review round, this writes rows for findings somebody tried to
 * file, and the whole value of either is the population they form together.
 * A second set of names for `category` / `refusal` / `withheldBy` would make
 * that union a join nobody can write.
 *
 * `severity` and `jury` are always `null` here and are present anyway, so the
 * two row shapes parse under one reader. A chokepoint has no verifier group,
 * and an absent vote is not a severity of `Important`.
 */
export interface FilingLedgerRow {
  at: string;
  /**
   * This row, told apart from every other row on a shared ledger (#1318).
   *
   * **The same field, the same composition and the same `null` as
   * `CandidateRecord.key`** — `${batch}/${index}` — because the value of the
   * two row shapes is the population they form together, and two schemes
   * answering "which row is this" is one decider with a spare
   * (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
   * Neither of the fields that look as though they could do this job can:
   * `id` is `UNFILED_ID` for every row this writer emits, and `symptomHash`
   * is a similarity identity, not a row identity — 6 of the 8 rows on the
   * live ledger share one value.
   *
   * `null` when the session identity is absent, and that is a reading rather
   * than a gap: `summariseFindingOutcomes` already refuses a corpus of
   * repeated ids and names this field in the refusal. A plausible-looking key
   * would be the Silent Default Substitution `.claude/rules/config-access.md`
   * forbids, and the one failure mode that silently shrinks a corpus.
   */
  key: string | null;
  id: string;
  title: string;
  symptomHash: string;
  category: FindingCategory;
  severity: null;
  disposition: Disposition;
  refusal: ArbiterRefusal | null;
  /** Did it reach the tracker? */
  emitted: boolean;
  withheldBy: WithheldBy | null;
  jury: null;
  duplicateOf: string[];
  /** The refusal was overridden with `--label arbiter-override`. */
  overridden: boolean;
}

/**
 * The three flags this gate reads, through the same arity walk the VERIFY
 * lock uses. None is comma-separated: `gh` splits a `--label` list on commas
 * and a title containing one is still a title.
 */
const TITLE_FLAG = { long: "--title", short: "-t" };
const BODY_FLAG = { long: "--body", short: "-b" };
const BODY_FILE_FLAG = { long: "--body-file", short: "-F" };
const REPO_FLAG = { long: "--repo", short: "-R" };

/**
 * The value `gh` will act on when a flag is given more than once.
 *
 * **pflag is last-wins, and this one line is the whole parser-differential
 * class.** The first version joined the values, so
 * `--title <benign> --title <real finding>` was adjudicated on the pair and
 * filed as the second — a complete bypass for anyone who knew it, and
 * reachable by accident. Joining is the intuitive reading and it is wrong
 * about every repeated flag; `at(-1)` is what the consumer does.
 */
const asGhWould = (values: string[]): string => values.at(-1) ?? "";

/**
 * The repository `gh` will file against, as `owner/repo` — or `null` because
 * this gate cannot read that tracker (#1318 PR, the `--repo` differential).
 *
 * **`asGhWould` above is last-wins; this is the other half of the same
 * class.** `gh` resolves `--repo` through `ghrepo.FromFullName`, which accepts
 * a bare `OWNER/REPO`, a `HOST/OWNER/REPO`, a full `https://` URL and an
 * scp-style `git@github.com:owner/repo.git`. `parseOwnerRepo` accepts only
 * the first of those and **throws** on the rest, inside the `catch` in
 * `openFindings` — so for three spellings `gh` files perfectly well against,
 * the corpus read came back `null`, the dedupe never ran, and the filing was
 * ALLOWED as UNMEASURED. Measured against this tracker: `gh issue list --repo`
 * returned the same first issue for `hornjason/pai-harness`,
 * `https://github.com/hornjason/pai-harness` and `github.com/hornjason/pai-harness`,
 * while `parseOwnerRepo` threw `Invalid repo format` for the last two.
 *
 * `githubSlugFromRemoteUrl` already parses every host-bearing form — it is
 * what `resolveRepoSlug` runs the `origin` remote through — so this is a
 * composition and not a second parser. **`parseOwnerRepo` remains the only
 * validator**: whatever this returns, it returned because that function
 * accepted it, so no second opinion about what a slug is can drift from the
 * one the API client holds (the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`).
 *
 * The `catch` is fail-CLOSED and that is the difference from the one it
 * replaces: `null` here routes to a refusal, not to an allow.
 *
 * **A non-github.com host is `null` on purpose.** `gh` accepts
 * `HOST/OWNER/REPO` for an enterprise instance; `createGitHubClient` talks to
 * github.com and nothing else. A tracker this process genuinely cannot read
 * must not resolve to a slug that names a different one.
 */
export function ghRepoTarget(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const candidate = githubSlugFromRemoteUrl(trimmed) ?? trimmed.replace(/\.git$/i, "");
  try {
    const { owner, repo } = parseOwnerRepo(candidate);
    return `${owner}/${repo}`;
  } catch {
    return null;
  }
}

/**
 * One clause, resolved to what `gh` would resolve it to.
 *
 * The single binding for "what will actually be filed". Four of the sixteen
 * review findings on this subsystem were one instance each of the gate
 * reading a different value than the consumer acts on; they are answered
 * here, together, so a fifth cannot be written against a second parser.
 *
 * ## What this deliberately does not resolve
 *
 * **A `cd` in an earlier clause.** `cd /other/repo && gh issue create …`
 * targets another tracker and this reads the session's directory. Resolving
 * it means tracking directory state across clauses, which is the shell
 * interpreter `lib/issue-create-override.ts` explicitly declines to be, and
 * the failure is in the safe direction: the dedupe runs against the wrong
 * corpus, finds nothing, and the filing is allowed. `--repo` IS read,
 * because it is in the clause and costs one more query.
 */
export function resolveFiling(tokens: string[]): FilingAttempt {
  const titles = flagValues(tokens, TITLE_FLAG);
  const bodies = flagValues(tokens, BODY_FLAG);
  const bodyFiles = flagValues(tokens, BODY_FILE_FLAG);
  const repos = flagValues(tokens, REPO_FLAG);
  return {
    title: asGhWould(titles),
    body: asGhWould(bodies),
    labels: labelValues(tokens),
    // The PATH, last-wins, or `null` when the body is inline (#1300). The
    // same `asGhWould` reading as the title and the body — a repeated
    // `--body-file` overrides rather than accumulating.
    bodyFile: bodyFiles.length > 0 ? asGhWould(bodyFiles) : null,
    repo: repos.length > 0 ? asGhWould(repos) : null,
    repeatedValueFlag: titles.length > 1 || bodies.length > 1 || bodyFiles.length > 1,
  };
}

/**
 * Every `gh issue create` in this command, one entry per clause.
 *
 * Per clause and not per command, for the reason `verifyPhaseRefusal` is:
 * `gh issue comment … && gh issue create …` is a create, and a reading over
 * the whole string lets the first half excuse the second.
 */
export function filingAttempts(cmd: string): FilingAttempt[] {
  return clauses(cmd).filter(createsIssue).map(resolveFiling);
}

/**
 * A `--body-file`, or `null` when it could not be read (#1300).
 *
 * `null` for every failure, and the failures are not told apart on purpose:
 * absent, unreadable, a directory, oversized and stdin all mean the same
 * thing to the caller — nobody read the symptom — and all of them ALLOW. The
 * one distinction that matters here is read / not-read, and an empty file is
 * READ: it returns `""`, which yields no symptom keys and lands on the
 * existing "names no symbol" arm rather than on this one.
 *
 * `"-"` is stdin. `gh` accepts it and there is nothing on disk to open, so it
 * stays unreadable exactly as before.
 *
 * The path comes from a command the agent is about to run anyway, so reading
 * it grants this hook no reach it did not already have.
 */
export function readBodyFile(path: string, limit: number = MAX_BODY_FILE_BYTES): string | null {
  if (path === "-" || path.trim() === "") return null;
  try {
    if (statSync(path).size > limit) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * The single place that decides whether a filing may proceed.
 *
 * `readExisting` is a thunk and not a value so the `gh issue list` is never
 * paid for a finding the category stage already drops. It returns a
 * `CorpusReading`, whose `UNMEASURED` arm is "could not be read" and carries
 * its own `why` — a different fact from an empty tracker, which is the
 * distinction `.claude/rules/config-access.md` makes about a corrupt config,
 * applied to the one input this gate cannot produce itself.
 */
export async function adjudicateFiling(
  attempt: FilingAttempt,
  readExisting: () => Promise<CorpusReading>,
  readBody: (path: string) => string | null = readBodyFile,
): Promise<FilingAdjudication> {
  // ── where is the body? ──
  //
  // Resolved before anything reads it, because every stage below wants the
  // real one. `null` means "there is a file and it could not be read", which
  // is UNMEASURED further down — distinct from an inline body, and never
  // collapsed into an empty one.
  //
  // This read happens before the category stage, which inverts the
  // cost-ordering doctrine one paragraph up. Deliberate, and the costs are
  // not comparable: this is one bounded local `readFileSync`, the thing that
  // doctrine protects is a network round trip to the GitHub API. Paying it
  // first buys the category stage the body it classifies on.
  const body = attempt.bodyFile === null ? attempt.body : readBody(attempt.bodyFile);
  const finding: Finding = { id: UNFILED_ID, title: attempt.title, body: body ?? attempt.body };
  const category = classifyCategory(finding);
  const base = {
    category,
    symptomHash: symptomHash(finding),
    duplicateOf: [] as string[],
    collidingKeys: [] as string[],
  };

  // ── is it the kind we post at all? ──
  if (DROPPED_CATEGORIES.has(category)) {
    return {
      ...base,
      outcome: "REFUSE",
      refusal: "DROPPED_CATEGORY",
      reason:
        `the title reads as a ${category} finding, and ${category} findings are ` +
        `dropped outright: they cost a review round and change no behaviour`,
    };
  }

  // ── can the symptom be read out of this command at all? ──
  //
  // Two UNMEASURED arms, and they are separate because they are separate
  // facts. The first cut asked `title.trim() === "" || keys.length === 0`,
  // which the AI review on #1282 caught: a filing with a blank `--title` and
  // a full `--body` HAS a readable symptom, so that disjunct skipped the
  // dedupe on an input it could have adjudicated — and then printed "names no
  // symbol, no file and no reading" about a body naming all three. A reason
  // that is false for the input it was emitted on is worse than no reason.
  //
  // The title is read by `classifyCategory` above and nowhere here, so a
  // blank one costs the category stage its input and costs the dedupe
  // nothing: `symptomKeys` contributes title symbols and paths but no
  // quantities, so a title is never what makes a pair a duplicate anyway.
  //
  // The body-file arm NARROWED rather than disappeared (#1300). It used to
  // fire on every `--body-file`, which measured against this tracker is
  // essentially every real filing — a detector narrower than what it
  // detects, and narrowed in the worst direction, since the findings that
  // need a file are the long detailed ones. It now fires only when the file
  // genuinely could not be read.
  if (body === null) {
    return {
      ...base,
      outcome: "UNMEASURED",
      refusal: "UNMEASURED",
      reason:
        `the body file \`${attempt.bodyFile}\` could not be read (absent, unreadable, ` +
        `stdin, or over ${MAX_BODY_FILE_BYTES} bytes), so there was nothing to deduplicate on`,
    };
  }
  if (symptomKeys(finding).length === 0) {
    return {
      ...base,
      outcome: "UNMEASURED",
      refusal: "UNMEASURED",
      reason: "the filing names no symbol, no file and no reading, so there is nothing to deduplicate it on",
    };
  }

  // ── which tracker is this going to? ──
  //
  // **The one UNMEASURED in this file that REFUSES, and the reason it is not
  // an exception to the policy above.** Every other unreadable input here is
  // a fact about the environment — no token, a 403, a rate limit, an
  // unreachable API — which the agent cannot fix and must not be gagged by.
  // This one is a fact about the COMMAND: the agent wrote a `--repo` value,
  // it is in the clause, and re-spelling it as `owner/repo` is a one-token
  // edit. A refusal somebody can act on in the same turn is not a gag.
  //
  // `outcome` and `refusal` are separate fields precisely so the policy can
  // differ from the reading. Every other site sets them in lockstep, which is
  // what makes the lockstep look like an invariant; it never was one.
  //
  // Fail-closed here because the alternative is the fail-open that made the
  // differential exploitable in the first place: `gh` accepts more spellings
  // of `--repo` than this process can read, and a spelling we cannot read
  // must not be the cheapest way past the dedupe.
  if (attempt.repo !== null && ghRepoTarget(attempt.repo) === null) {
    return {
      ...base,
      outcome: "REFUSE",
      refusal: "UNMEASURED",
      reason:
        `\`--repo ${attempt.repo}\` does not resolve to a github.com \`owner/repo\`, so the ` +
        `open issues of the tracker this would file against were never read. Re-run with ` +
        `\`--repo owner/repo\`; an enterprise host is not readable from here at all`,
    };
  }

  // ── is this new? ──
  const existing = await readExisting();
  if (existing.reading === "UNMEASURED") {
    // The reason is the READING's own, never composed here. A sentence
    // written at this distance from the failure can be false for the input
    // it is emitted on, which this file already paid for once in the
    // `--body-file` arm above.
    return { ...base, outcome: "UNMEASURED", refusal: "UNMEASURED", reason: existing.why };
  }
  const collisions = duplicateCollisions(finding, existing.findings);
  if (collisions.length > 0) {
    return {
      ...base,
      outcome: "REFUSE",
      refusal: "DUPLICATE",
      duplicateOf: collisions.map(c => c.id),
      collidingKeys: collisions[0].keys,
      reason:
        `the symptom is already reported as ${collisions.map(c => `#${c.id}`).join(", ")} — ` +
        `shared ${collisions[0].keys.length} key(s): ${collisions[0].keys.slice(0, 6).join(", ")}`,
    };
  }

  // ── it is novel and postable. does it say what it MOVES? ──
  //
  // **Last, and the ordering is the design.** A regex over a string already in
  // hand is the cheapest test in this function, so the cost doctrine every
  // other stage follows would put it first — and first is wrong here, twice
  // over. A duplicate must be refused as DUPLICATE, because "already filed as
  // #1173" is actionable and "name a claim" is not; and an UNMEASURED tracker
  // must stay UNMEASURED, because a policy refusal that outranks a reading
  // failure is a reading failure nobody ever sees. This stage only ever
  // converts an ALLOW, so it can mask nothing.
  //
  // Measured when it was briefly placed first: 34 of 78 cases in this file's
  // own suite went red, every one a dedupe or UNMEASURED case short-circuited
  // before it could run. That is the mask, observed rather than reasoned
  // about.
  //
  // This REFUSES rather than noting, and the difference is the whole point.
  // `CLAUDE.md` has carried the rule as prose for the life of this repository
  // — *"say which claim it moves"* — and nothing executed it, so the tracker
  // grew faster than it drained: open issues went 53 → 52 → 55 across
  // 2026-10-23 while the close rate fell from 11/h to 7/h. A rule nothing
  // executes is not a rule; `.claude/rules/config-access.md` says that about
  // ADRs and it was true of this line too.
  //
  // The escape hatch is the label that already exists. Cleanup is still
  // postable — say so with `--label arbiter-override`, and it is counted. An
  // override nobody can count is the thing this gate is not.
  if (namedClaim(`${attempt.title}\n${body}`) === null) {
    return {
      ...base,
      outcome: "REFUSE",
      refusal: "NO_CLAIM",
      reason:
        `the filing is novel, and names no SUCCESS.md claim — nothing says what it moves. ` +
        `Name one as "Claim <1-${SUCCESS_CLAIM_COUNT}>" in the title or body, or post it as ` +
        `cleanup with \`--label ${FILING_OVERRIDE_LABEL}\``,
    };
  }

  return {
    ...base,
    outcome: "ALLOW",
    refusal: null,
    reason:
      `no open issue shares this symptom, ${category} is not a dropped category, ` +
      `and it names SUCCESS.md claim ${namedClaim(`${attempt.title}\n${body}`)}`,
  };
}

/**
 * Why one existing issue was kept out of the comparison set.
 *
 * **Five reasons across two modules, and that is the point of #1374.** The
 * first two are this file's own filters. The last three happen in
 * `lib/github.ts`, before this file sees a row at all, and they used to
 * happen silently — the count this file took was already post-filter, so a
 * page holding 100 pull requests and no issues reached `corpusReading` as
 * `considered === 0` and was reported as a clean tracker. A drop nobody
 * records is a drop nobody can reason about, wherever it happens.
 */
export interface CorpusDrop {
  /**
   * The issue number as a string, or `null` for a drop that is not about one
   * issue — a malformed row that carried no number, or the page cap, which
   * is a fact about the request rather than about any row in the answer.
   */
  id: string | null;
  reason:
    | "untrusted-author"
    | "over-key-cap"
    | "pull-request"
    | "malformed-row"
    | "page-cap";
  /** The producing filter's own sentence, so the report is not re-derived. */
  detail: string;
}

/**
 * What a corpus read yielded, and what it had to drop to get there.
 *
 * **One discriminator.** `reading` is the whole answer — there is no `null`
 * beside it meaning the same thing, because two spellings of UNMEASURED are
 * two deciders for one question and the second one always agrees with the
 * first (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
 * Every path that could not take a reading returns `UNMEASURED` **with its
 * own `why`**, because a reason composed downstream is a reason that can be
 * false for the input it was emitted on, which this file already paid for
 * once in the `--body-file` arm above.
 *
 * `dropped` is carried on BOTH arms. A read that succeeded after dropping
 * three issues is a different fact from one that dropped none, and the caller
 * cannot ask afterwards.
 */
export type CorpusReading =
  | { reading: "MEASURED"; findings: readonly Finding[]; dropped: readonly CorpusDrop[] }
  | { reading: "UNMEASURED"; why: string; dropped: readonly CorpusDrop[] };

/** A reading that was taken. */
export function measuredCorpus(
  findings: readonly Finding[],
  dropped: readonly CorpusDrop[] = [],
): CorpusReading {
  return { reading: "MEASURED", findings, dropped };
}

/** A reading that was not taken, and why. */
export function unmeasuredCorpus(why: string, dropped: readonly CorpusDrop[] = []): CorpusReading {
  return { reading: "UNMEASURED", why, dropped };
}

/**
 * The open issues, as findings, or an UNMEASURED reading naming why not.
 *
 * An empty tracker means nothing is a duplicate; an unreadable one means
 * nobody asked. Every failure path here is `UNMEASURED` rather than an empty
 * list, so a `gh` that is missing, unauthenticated, rate-limited, slow or
 * returning something unexpected cannot be mistaken for a clean tracker.
 *
 * **Through Octokit and never the GitHub CLI.** `lib/`, `hooks/` and `gates/`
 * may not reach `gh` as a subprocess — GITHUB-API-MIGRATION-SPEC.md's SC-893,
 * enforced by a ratchet in `test/ticked-sc-cover.test.ts` whose known-offender
 * list #395 emptied and which refuses in both directions. The first cut of
 * this file shelled out and CI caught it. The architectural reason is the one
 * `getIssueLabels` records: a hook runs in whatever environment the session
 * has, and a subprocess needs the CLI installed and authenticated there.
 *
 * **The cost, stated because it decides what this gate does on a dev box:**
 * `createGitHubClient` needs `GITHUB_TOKEN` or `GH_TOKEN`, and a developer's
 * GitHub credential usually lives in the CLI's keyring and not in the
 * environment. With no token the dedupe is UNMEASURED,
 * and only the category stage runs. That is visible rather than silent — the
 * ledger row says `UNMEASURED` and the agent is told — and it is the honest
 * reading: nobody asked the tracker. Export a token, or supply the set below.
 *
 * `RUNGATE_OPEN_FINDINGS` names a JSON file to read instead of calling the
 * API. It is a production seam and not a test hook — a consumer on a
 * non-GitHub tracker, an agent working offline, or a session with no token
 * has no other way to supply the comparison set. Pointing it at an empty
 * array switches the dedupe off, and that is the direction this gate is
 * allowed to be wrong in: the result is a duplicate reaching the tracker,
 * never a real finding silenced.
 */
/**
 * Which tracker the dedupe asks about. One binding, so there is one answer.
 *
 * **An explicit `--repo` that does not resolve is `null`, never the working
 * directory's slug.** Falling back is the tempting repair and it is the worse
 * one: this gate would then adjudicate a filing bound for one tracker against
 * another tracker's issues, which is not a weaker reading — it is the wrong
 * one, and it is wrong in both directions at once (a real duplicate on the
 * target is invisible, an unrelated issue here can refuse it). The same
 * argument `filingGate` makes for caching per target rather than per command.
 *
 * `null` from here is UNMEASURED to `openFindings`, and the POLICY over an
 * unparseable explicit target is decided in `adjudicateFiling`, from
 * `attempt.repo`, before this is ever called. Both read `ghRepoTarget`; one
 * decides what to query, the other decides what to do about not being able
 * to — two questions, one predicate.
 */
export function corpusSlug(projectRoot: string, repo: string | null): string | null {
  if (repo !== null) return ghRepoTarget(repo);
  return resolveRepoSlug({ projectRoot }).slug;
}

export async function openFindings(
  projectRoot: string,
  repo: string | null = null,
): Promise<CorpusReading> {
  const override = process.env.RUNGATE_OPEN_FINDINGS;
  if (override !== undefined && override !== "") {
    try {
      return asFindings(JSON.parse(readFileSync(override, "utf-8")));
    } catch {
      return unmeasuredCorpus(
        `the supplied comparison set \`${override}\` could not be read or parsed, so whether ` +
          "this symptom is already filed was never asked",
      );
    }
  }
  try {
    const slug = corpusSlug(projectRoot, repo);
    if (slug === null) {
      return unmeasuredCorpus(
        repo === null
          ? "no repository slug could be resolved, so there was no tracker to compare against"
          : `\`--repo ${repo}\` does not resolve to a github.com \`owner/repo\`, so there ` +
            "was no tracker to compare against",
      );
    }
    const page = await withTimeout(
      listOpenIssues(createGitHubClient(), slug, OPEN_ISSUE_LIMIT),
      OPEN_ISSUE_TIMEOUT_MS,
    );
    return trustedCorpus(page);
  } catch {
    // Every failure lands here as UNMEASURED, which is "nobody asked" and not
    // "nothing matched" — a missing token, a 403, a rate limit and an
    // unreachable API are all states this must not report as a clean tracker.
    return unmeasuredCorpus(
      "the open-issue set could not be read, so whether this symptom is already filed was never asked",
    );
  }
}

/**
 * The open issues that may be used to suppress a filing.
 *
 * Two filters, and both exist because **this repository is public, so the
 * corpus is attacker-controlled input**. An open issue here is not evidence
 * that something was already reported; it is text somebody on the internet
 * wrote, and this gate turns it into a refusal.
 *
 * - **Author trust.** Only `OWNER`/`MEMBER`/`COLLABORATOR`; see
 *   `TRUSTED_ASSOCIATIONS`.
 * - **A key cap per issue.** One issue stuffed with symptom keys matches
 *   everything, so it is dropped rather than allowed to.
 *
 * Both fail in the direction of a duplicate reaching the tracker, never a
 * real finding silenced. That asymmetry is the whole design and it is why
 * neither of these is a refusal.
 */
/**
 * Whether one existing issue may join the comparison set.
 *
 * One binding, because both corpus readers below apply it and the mutation
 * battery could not mutate either on its own while the predicate was spelled
 * twice — an anchor matching two sites is a mutation nobody chose, and a
 * battery that reports `ANCHOR x2` is telling you about its own range rather
 * than about the guard (`.claude/rules/checks-must-be-able-to-fail.md`, the
 * seventh shape). Dropped whole rather than truncated: truncating keeps
 * whichever keys sorted first, which is a reading nobody picked.
 */
function withinKeyCap(finding: Finding): boolean {
  return symptomKeys(finding).length <= MAX_KEYS_PER_EXISTING_ISSUE;
}

/**
 * A corpus that filtered to nothing is UNMEASURED, not a clean tracker.
 *
 * **One binding, because both readers below reach it and because this is the
 * fail-open the filters create.** Each filter is individually argued to fail
 * in the safe direction — a duplicate reaches the tracker, never a real
 * finding silenced — and that argument is about ONE issue being dropped. It
 * does not survive composition: a non-empty issue list that filters down to
 * an empty one is byte-indistinguishable from a tracker with nothing on it,
 * and the gate then ALLOWs on the strength of a comparison it never made.
 * That is not the safe direction; it is no direction at all, and a filter
 * with a bug in it would read exactly the same.
 *
 * `dropped` travels either way, so a read that succeeded after dropping three
 * issues can be told from one that dropped none.
 */
function corpusReading(
  considered: number,
  findings: readonly Finding[],
  dropped: readonly CorpusDrop[],
  source: string,
): CorpusReading {
  if (considered === 0 || findings.length > 0) return measuredCorpus(findings, dropped);
  return unmeasuredCorpus(
    `the ${source} held ${considered} issue(s) and every one of them was filtered out of the ` +
      "comparison set, so whether this symptom is already filed was never asked — an empty " +
      `corpus that was emptied BY US is not a clean tracker. Dropped: ${describeDrops(dropped)}`,
    dropped,
  );
}

/** The drops as one sentence, each with the filter's own reason. */
export function describeDrops(dropped: readonly CorpusDrop[]): string {
  if (dropped.length === 0) return "nothing — the list was non-empty and the filters took none of it, which should be impossible here";
  return dropped
    .map(d => (d.id === null ? `(${d.reason}: ${d.detail})` : `#${d.id} (${d.reason}: ${d.detail})`))
    .join("; ");
}

/**
 * The open-issue page as a comparison set, or the reading that says why not.
 *
 * **It takes the PAGE and not the issues** (#1374). The count that decides
 * MEASURED from UNMEASURED has to be the population the tracker returned, and
 * the only place that number exists is beside the rows `lib/github.ts`
 * dropped. Taking `issues.length` here — which is what this did — asks "did
 * OUR filters empty it?" of a list somebody else had already emptied.
 */
export function trustedCorpus(page: OpenIssuePage): CorpusReading {
  const { issues } = page;
  const out: Finding[] = [];
  const dropped: CorpusDrop[] = [];
  for (const row of page.droppedRows) {
    dropped.push({
      id: row.number === null ? null : String(row.number),
      reason: row.reason,
      detail:
        row.reason === "pull-request"
          ? "the REST issues endpoint returns pull requests as issues, and a PR body quotes the symptom of the issue it fixes"
          : "the row carried no usable number or title, so there was nothing to compare against",
    });
  }
  if (page.truncated) {
    // Not an UNMEASURED on its own: a full page IS a reading, of a narrower
    // question than the one asked. It travels as a drop so the agent is told
    // the comparison could not see the whole tracker, which is the fact a
    // bare "no duplicate found" hides.
    dropped.push({
      id: null,
      reason: "page-cap",
      detail:
        `the tracker returned a full page of ${page.perPage} and this gate does not paginate, ` +
        "so any issue past that position was never compared against",
    });
  }
  for (const issue of issues) {
    const id = String(issue.number);
    if (!TRUSTED_ASSOCIATIONS.has(issue.authorAssociation)) {
      dropped.push({
        id,
        reason: "untrusted-author",
        detail:
          `author association ${issue.authorAssociation === "" ? "(absent)" : issue.authorAssociation}` +
          ` is not one of ${[...TRUSTED_ASSOCIATIONS].join("/")}`,
      });
      continue;
    }
    const finding: Finding = { id, title: issue.title, body: issue.body };
    if (!withinKeyCap(finding)) {
      dropped.push({
        id,
        reason: "over-key-cap",
        detail: `names ${symptomKeys(finding).length} symptom keys, over the cap of ${MAX_KEYS_PER_EXISTING_ISSUE}`,
      });
      continue;
    }
    out.push(finding);
  }
  // `page.considered`, never `issues.length`. That one substitution is #1374.
  return corpusReading(page.considered, out, dropped, "tracker");
}

/** Supplied rows as `Finding`s, or UNMEASURED if the shape is not what we asked for. */
function asFindings(parsed: unknown): CorpusReading {
  const malformed = (what: string) =>
    unmeasuredCorpus(
      `the supplied comparison set is ${what}, so whether this symptom is already filed was never asked`,
    );
  if (!Array.isArray(parsed)) return malformed("not an array");
  const out: Finding[] = [];
  const dropped: CorpusDrop[] = [];
  for (const row of parsed) {
    if (row === null || typeof row !== "object") return malformed("not a list of objects");
    const r = row as Record<string, unknown>;
    const id = r.number ?? r.id;
    if (typeof id !== "number" && typeof id !== "string") return malformed("missing a row id");
    if (typeof r.title !== "string") return malformed("missing a row title");
    const finding: Finding = {
      id: String(id),
      title: r.title,
      body: typeof r.body === "string" ? r.body : "",
    };
    // The key cap applies here too, through the SAME predicate. This file is
    // operator-supplied rather than attacker-supplied, so the AUTHOR filter
    // does not, but one row naming everything suppresses everything whoever
    // wrote it.
    if (!withinKeyCap(finding)) {
      dropped.push({
        id: finding.id,
        reason: "over-key-cap",
        detail: `names ${symptomKeys(finding).length} symptom keys, over the cap of ${MAX_KEYS_PER_EXISTING_ISSUE}`,
      });
      continue;
    }
    out.push(finding);
  }
  return corpusReading(parsed.length, out, dropped, "supplied comparison set");
}

/**
 * The environment variable the session identity comes from.
 *
 * One exported constant because it is named in the UNMEASURED note an agent
 * reads, and a variable named in prose and read in code from two places is
 * two spellings of one fact.
 */
export const LEDGER_SESSION_ENV = "CLAUDE_CODE_SESSION_ID";

/**
 * The batch every row of one command shares, or `null` when there is no
 * session identity to build one from (#1318).
 *
 * **`${at}/${index}` is the cheapest wrong fix and it does not hold.**
 * `ledgerPath()` defaults to `~/.rungate/finding-ledger.jsonl` — one file for
 * every agent on the machine, not one per worktree — and `at` is a single
 * `new Date().toISOString()` hoisted outside the row loop. So `${at}/${index}`
 * is unique *within* one command and only probabilistically across concurrent
 * writers, and the live ledger already carries two rows identical in every
 * field including `at`. #1263 asks for unique **by construction**, and a
 * coin-toss you only have to lose once silently reintroduces the defect.
 *
 * Three components, and each closes a case the others leave open:
 *
 * - **the session**, first 8 chars of `CLAUDE_CODE_SESSION_ID` — the same cut
 *   `hooks/TeamInit.hook.ts` takes, so a ledger row joins to that session's
 *   `teams/session-<8>` directory rather than needing a second identity;
 * - **the pid**, because one session runs parallel subagents and each Bash
 *   call spawns its own hook PROCESS. Two of them can append in the same
 *   millisecond with the same session and the same clause index, which is
 *   every other component held fixed. A pid is unique among live processes,
 *   and a process that is appending is live;
 * - **`at` and the clause index**, which separate one process's own rows.
 *
 * `null`, loudly, when the variable is absent — never a fallback that merely
 * looks unique. `.claude/rules/config-access.md`, *Silent Default
 * Substitution*: `0`, `{}` and a plausible key are indistinguishable from
 * success; UNMEASURED is not.
 */
export function filingBatch(at: string, pid: number = process.pid): string | null {
  const session = (process.env[LEDGER_SESSION_ENV] ?? "").trim();
  if (session === "") return null;
  return `${session.slice(0, 8)}.${pid}/${at}`;
}

/** Where the adjudications land. One line of JSON per decision. */
export function ledgerPath(): string {
  const explicit = process.env.RUNGATE_FINDING_LEDGER;
  if (explicit !== undefined && explicit !== "") return explicit;
  const work = process.env.RUNGATE_WORK_DIR || process.env.PAI_WORK_DIR || join(homedir(), ".rungate");
  return join(work, "finding-ledger.jsonl");
}

/**
 * Append one row. Returns whether it landed.
 *
 * **A ledger that cannot be written must not refuse a filing.** The record
 * exists to measure the gate, and a measurement apparatus that blocks the
 * thing it measures is worse than no measurement — so this reports its own
 * failure to the caller rather than throwing into the hook, and the caller
 * says so on `systemMessage`. That is the same split as the UNMEASURED policy
 * in this file's header: the writer is honest about failing, the policy over
 * that failure is to proceed loudly.
 */
export function recordAdjudication(row: FilingLedgerRow, path: string = ledgerPath()): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(row)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}

export interface FilingGateReading {
  /** The block reason, or `null` to allow. */
  refusal: string | null;
  /** Something the agent should see even though nothing was blocked. */
  note: string | null;
  /** One row per `gh issue create` clause, in clause order. */
  rows: FilingLedgerRow[];
}

/** Nothing here created an issue, so there is nothing to adjudicate. */
const NO_FILING: FilingGateReading = { refusal: null, note: null, rows: [] };

/**
 * Adjudicate every filing in one Bash command.
 *
 * One exported entry so `hooks/VerifyPhaseLock.hook.ts` stays a trigger and
 * the decision stays in `lib/` (#365, HOOK-ARCHITECTURE-SPEC).
 */
export async function filingGate(
  cmd: string,
  options: {
    projectRoot: string;
    now?: string;
    readExisting?: (projectRoot: string, repo: string | null) => Promise<CorpusReading>;
  },
): Promise<FilingGateReading> {
  const attempts = filingAttempts(cmd);
  if (attempts.length === 0) return NO_FILING;

  const at = options.now ?? new Date().toISOString();
  const read = options.readExisting ?? openFindings;
  // Read once per TARGET TRACKER, not once per command and not once per
  // clause. Once per clause would adjudicate two creates against two
  // different snapshots; once per command would adjudicate a `--repo other/x`
  // filing against THIS repository's issues, which is not a weaker reading,
  // it is the wrong one. The PROMISE is cached rather than its value, so two
  // clauses on one tracker cannot both start a request before either resolves.
  const cached = new Map<string, Promise<CorpusReading>>();
  const readFor = (repo: string | null) => {
    const key = repo ?? "";
    const hit = cached.get(key);
    if (hit !== undefined) return hit;
    const started = read(options.projectRoot, repo);
    cached.set(key, started);
    return started;
  };

  const rows: FilingLedgerRow[] = [];
  const refusals: string[] = [];
  const notes: string[] = [];

  // One batch per command, so every row of one adjudication shares it and the
  // clause index separates them — `CandidateRecord.key`'s scheme exactly.
  const batch = filingBatch(at);
  if (batch === null) notes.push(unkeyedLedgerNote());

  for (const [index, attempt] of attempts.entries()) {
    const verdict = await adjudicateFiling(attempt, () => readFor(attempt.repo));
    const overridden = verdict.outcome === "REFUSE" && attempt.labels.includes(FILING_OVERRIDE_LABEL);
    const emitted = verdict.outcome !== "REFUSE" || overridden;

    rows.push({
      at,
      key: batch === null ? null : `${batch}/${index}`,
      id: UNFILED_ID,
      title: attempt.title,
      symptomHash: verdict.symptomHash,
      category: verdict.category,
      severity: null,
      disposition: emitted ? "ISSUE" : "DROP",
      refusal: verdict.refusal,
      emitted,
      withheldBy: emitted ? null : verdict.refusal,
      jury: null,
      duplicateOf: verdict.duplicateOf,
      overridden,
    });

    if (verdict.outcome === "REFUSE" && !overridden) refusals.push(refusalMessage(verdict));
    if (verdict.outcome === "UNMEASURED") notes.push(unmeasuredNote(verdict));
    if (overridden) notes.push(overrideNote(verdict));
  }

  // ── A refusal blocks the COMMAND, and every clean clause is NAMED in the
  //    refusal so none of them is lost ───────────────────────────────────
  //
  // This read `rows.length > 0 && rows.every(r => !r.emitted)` — block only
  // when NOTHING in the command was clean. The concern behind it was real: a
  // hook's one lever is the whole Bash command, so blocking a mixed command
  // takes novel findings down with a duplicate, and withholding a real
  // finding with no artefact anywhere is the direction nothing here may fail
  // in.
  //
  // What it did not price is the bypass. One duplicate batched with one novel
  // finding was ALLOWED and the refusal downgraded to a note, so the cheapest
  // way past the arbiter became putting a refused filing in the same `&&`
  // chain as a clean one. A gate with a one-clause bypass is worse than no
  // gate, because it reads as working.
  //
  // And `emitted` is `outcome !== "REFUSE" || overridden`, so it is true for
  // an **UNMEASURED** row too: one unreadable `--body-file` beside any number
  // of duplicates allowed the whole command. A broken adjudicator was a
  // bypass as well as a note, which is the one thing the UNMEASURED policy in
  // this file's header exists to prevent.
  //
  // Blocking is affordable because nothing is lost by it. The refusal
  // ENUMERATES the clauses that were clean, so the agent withdraws the
  // refused one and re-runs the rest in one step, and the ledger has carried
  // every row — clean and refused — since the rows above were written. A
  // finding deferred by one command is not a finding silenced; a finding
  // filed alongside a duplicate was never adjudicated at all.
  //
  // An OVERRIDDEN refusal is deliberately not in `refusals`, so it does not
  // block: an override is a decision somebody made and recorded.
  const blocking = refusals.length > 0;
  const clean = rows.filter(r => r.emitted);
  if (blocking && clean.length > 0) refusals.push(cleanClauseNote(clean, rows.length));

  // Whatever the verdict, say what the comparison set lost on the way in.
  // A dedupe run over a corpus three issues short is a weaker reading than
  // one run over the whole tracker, and no reader can tell them apart from
  // the outcome — the drop is only visible here, once per target tracker.
  for (const pending of cached.values()) {
    const reading = await pending;
    if (reading.dropped.length > 0) notes.push(corpusDropNote(reading.dropped));
  }

  return {
    refusal: blocking ? refusals.join("\n\n") : null,
    note: notes.length > 0 ? notes.join("\n\n") : null,
    rows,
  };
}

/**
 * The refusal an agent reads.
 *
 * It names the category, the signal that matched, and the override — because
 * a refusal nobody can act on becomes a refusal everybody routes around, and
 * the three VERIFY-lock bypasses in `lib/issue-create-override.ts` are what
 * that looks like when it happens.
 */
export function refusalMessage(v: FilingAdjudication): string {
  return [
    "[FindingArbiter] This filing was adjudicated and refused before it reached the tracker.",
    "",
    `  refusal:  ${v.refusal}`,
    `  category: ${v.category}`,
    `  why:      ${v.reason}`,
    "",
    "Resolve it where the finding is, in this order: fix it in the PR you are",
    "already in; or answer it in a PR comment with a reason. A reason closes a",
    "finding and silence does not. Filing is the exception, not the default.",
    "",
    `If this one genuinely is the exception, re-run with --label ${FILING_OVERRIDE_LABEL}.`,
    `The override is recorded in ${ledgerPath()} beside the refusal it waived, so`,
    "an override that was right is evidence and one that was wrong is countable.",
  ].join("\n");
}

/**
 * The clauses that were clean, named inside the refusal that blocks them.
 *
 * This is the half that makes blocking a mixed command affordable. A hook can
 * only block the whole Bash command, so a refusal that said nothing about the
 * clean clauses would cost the agent the work of reconstructing them — which
 * is the argument the `every`-based predicate was built on. Naming them turns
 * "the command was blocked" into "withdraw one, re-run these", and the titles
 * are quoted verbatim so the re-run is a copy rather than a recollection.
 */
export function cleanClauseNote(clean: readonly FilingLedgerRow[], total: number): string {
  return [
    `[FindingArbiter] ${clean.length} of ${total} filings in this command WERE clean and are`,
    "not the reason it was blocked. A hook's one lever is the whole Bash command, so they are",
    `named here rather than lost, and all ${total} rows are recorded in ${ledgerPath()}.`,
    "Withdraw the refused one(s) and re-run these:",
    "",
    ...clean.map(r => `  - ${r.title}`),
  ].join("\n");
}

/**
 * What the comparison set lost on the way in, said out loud.
 *
 * A dedupe run over a corpus three issues short is a weaker reading than one
 * run over the whole tracker, and the two produce the same ALLOW. The drops
 * are the only thing that can tell them apart, and they are invisible by the
 * time a verdict exists.
 */
export function corpusDropNote(dropped: readonly CorpusDrop[]): string {
  return (
    `[FindingArbiter] ${dropped.length} open issue(s) were filtered out of the comparison set ` +
    `before this filing was adjudicated, so the dedupe read a smaller tracker than the one ` +
    `that exists: ${describeDrops(dropped)}.`
  );
}

/** Said out loud, because an UNMEASURED that nobody sees is a silent pass. */
export function unmeasuredNote(v: FilingAdjudication): string {
  return (
    `[FindingArbiter] UNMEASURED — this filing was NOT adjudicated: ${v.reason}. ` +
    "It is allowed through, because a broken adjudicator must not become a gag on " +
    `the tracker, and the row is recorded in ${ledgerPath()} as UNMEASURED rather ` +
    "than as a finding that passed. Those are different states."
  );
}

/**
 * Said out loud for the same reason `unmeasuredNote` is: a row that cannot be
 * joined to anything is not a row that recorded something.
 *
 * The filing still proceeds — the ledger measures this gate and a measurement
 * apparatus must not block the thing it measures, which is the policy
 * `recordAdjudication` states for a ledger that cannot be written at all.
 * What must not happen is the quiet version: a key that looks fine.
 */
export function unkeyedLedgerNote(): string {
  return (
    `[FindingArbiter] UNMEASURED row identity — \`${LEDGER_SESSION_ENV}\` is not set, so the ` +
    `rows this command appends to ${ledgerPath()} carry \`key: null\` and cannot be told apart ` +
    "from any other unkeyed row on that shared ledger. The filing is allowed and recorded; " +
    "what is lost is the join to its outcome, and it is lost permanently, because the " +
    "identity exists only at the moment of writing. No key was invented to cover the gap: " +
    "a plausible one reads as a measurement that was taken."
  );
}

/** An override is a decision somebody made, so it leaves a trace. */
export function overrideNote(v: FilingAdjudication): string {
  return (
    `[FindingArbiter] Allowed by --label ${FILING_OVERRIDE_LABEL}, over a ${v.refusal} ` +
    `refusal: ${v.reason}. Recorded in ${ledgerPath()}.`
  );
}
