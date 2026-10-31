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

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

import { githubSlugFromRemoteUrl, resolveRepoSlug } from "./branch-cleanup";
import {
  createGitHubClient,
  listOpenIssues,
  listPRs,
  parseOwnerRepo,
  TRUSTED_ASSOCIATIONS,
  type OpenIssuePage,
} from "./github";
import { branchOf, toplevel } from "./launch-base";
import { readWorktreeRemote, repoSlug, type RemoteReading } from "./worktree-repo";
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
  type JuryReading,
  type Severity,
} from "./finding-jury";
import { clauses, createsIssue, flagValues, labelValues } from "./issue-create-override";
import { gitSource, plannedFiling, type PlanSource } from "./filing-plan";

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
 * The refusals no label waives, each with the sentence saying why.
 *
 * **One object, because the membership and the explanation are one fact.**
 * They were two: a predicate listing the refusals and a message composing
 * the sentence, which is the two-deciders shape
 * `.claude/rules/checks-must-be-able-to-fail.md` names — and the drift was
 * already live, because the shared sentence said *"an accounting of what
 * this run has already filed"* over every member, which is true of the cap
 * and false of a missing declaration. A reader told the wrong reason stops
 * believing the refusal.
 *
 * The common property is not severity and not policy preference: **the label
 * answers a claim ABOUT a finding, and none of these makes one.** A count
 * does not, a missing count does not, and an absent declaration does not —
 * it reports a fact about the COMMAND, which the agent fixes by writing one
 * line rather than by arguing.
 *
 * `COMMENT_INSTEAD` joined on 2026-10-25, and it is the one that was costing
 * something. It is the comment DEFAULT, and the default was waivable by a
 * label the refusal itself told the agent to use — *"If this one genuinely
 * is the exception, re-run with --label arbiter-override"* — four lines
 * under the text explaining that the list of exceptions is closed. So the
 * closed list had a fourth member, spelled in the refusal that enforced it,
 * and `arbiter-override` was already on 7 of the 140 issues filed in the two
 * days before the gate shipped: the token was in circulation before there
 * was anything to override.
 *
 * Nothing legitimate is lost. The three declarations remain, cost one line,
 * and a filing carrying one still goes through — `FG-176` is that control.
 * What is removed is the route that beats the gate by making the filing
 * WORSE: delete the declaration, add the label.
 */
export const UNWAIVABLE_REFUSALS: Partial<Record<ArbiterRefusal, string>> = {
  OVER_CAP:
    "It answers a claim about a finding, and this refusal makes none — it is an " +
    "accounting of what this run has already filed.",
  UNMEASURED_CAP:
    "It answers a claim about a finding, and this refusal makes none — the run's " +
    "allowance could not be counted, which no argument about the finding changes.",
  COMMENT_INSTEAD:
    "It answers a claim about a finding, and this refusal makes none — it reports " +
    "that no declaration was given. Write one of the three, or post the comment.",
};

/**
 * Does `FILING_OVERRIDE_LABEL` waive this refusal?
 *
 * **ONE binding, and it exists because there were briefly two.** `filingGate`
 * decided it when it chose whether the label overrides, and `refusalMessage`
 * decided it again when it chose whether to offer the label — two deciders
 * over one question, behaviourally one decider with a spare. They disagreed
 * the moment the cap landed: the gate made `OVER_CAP` unwaivable and the
 * message went on closing with *"re-run with --label arbiter-override"*, so
 * the one refusal no label could open was also the one advertising the
 * bypass. Found by the AI review of PR #1597.
 *
 * Derived from `UNWAIVABLE_REFUSALS` rather than restating its membership,
 * so a refusal added there cannot be waivable here.
 */
export function waivableRefusal(refusal: ArbiterRefusal | null): boolean {
  return refusal === null || !(refusal in UNWAIVABLE_REFUSALS);
}

/**
 * How many claims `SUCCESS.md` states under "Done, for the harness".
 *
 * A constant and not a read, because this decision runs inside a hook from an
 * arbitrary working directory and a gate that needs I/O to decide is a gate
 * that fails open when the I/O does. `test/issue-filing-gate.test.ts` binds it
 * to the file — add a claim to `SUCCESS.md` and the suite goes red until this
 * number follows.
 */
export const SUCCESS_CLAIM_COUNT = 7;

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

/**
 * How many issues one run may file. **The gate (#1595, scope item 4).**
 *
 * ## Why a count, and not the declaration below it
 *
 * The declared-reason check in this file is a per-finding judgement, and the
 * research #1595 was built on predicted exactly how that ends: *"a bar an
 * agent applies by asking 'does this block a goal criterion?' re-decides 100
 * times a day and will drift."* Measured on 2026-10-24, against the three
 * issues filed that day by the author of the bar: **all three cleared it**,
 * each on an individually sound argument, through the clause *it makes a
 * green check lie* — which in a repository whose subject is checks that lie
 * admits any true finding. Three for three is not a result a bar produces.
 *
 * A count has no clause to argue into. It is the only item on #1595's list
 * that needs no reasoning to apply, and that is the whole of why it is the
 * gate while the declaration is the record.
 *
 * ## The number, from two independent readings that converge
 *
 * - **Cloudflare, 131,246 reviews (Mar–Apr 2026): 1.2 findings per review,
 *   deliberately low.** The only published per-unit number anywhere, and
 *   `runIdFor` makes our unit the same unit — one checkout is one piece of
 *   work. Floored to the integer below it, because what Cloudflare counts
 *   is an inline COMMENT and what this counts is a tracker issue, which
 *   costs an agent a whole context to close.
 * - **This machine, 2026-10-24: 64 issues created in 24 hours across 284
 *   registered worktrees — 0.23 filings per run per day.** A cap of 1 sits
 *   4.4x above the mean, so it cannot bind on the ordinary run; it binds
 *   only where a run files a SECOND, which is where the 1→N pathology that
 *   #1595 measured actually lives.
 *
 * Tricorder's fourth criterion — a warning should occur *"with a small but
 * noticeable frequency"* — is the same direction from a third source and is
 * not a number, so it is not used as one.
 *
 * **Not configurable, on purpose.** A cap read from config is a cap an agent
 * raises, and #1595 says in as many words that a cap nobody can defend is a
 * cap someone raises. Changing it is an edit here, against the two readings
 * above, which a reviewer can disagree with.
 */
export const FILINGS_PER_RUN = 1;

/**
 * How far back the cap counts.
 *
 * 24 hours, and the window is read off the instrument that measured the
 * pathology rather than chosen: every number in #1595 is a per-day one —
 * *"70–85% of everything closed each day"*, *"57 filed / 53 closed"* — and
 * `~/.rungate/swarm-throughput.sh` names its column `churn24`. A run that
 * has spent its allowance gets it back a day later, which is also what stops
 * a long-lived checkout being permanently barred.
 */
export const RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The one run every non-checkout directory shares.
 *
 * A sentinel rather than a path, so it cannot collide with a real toplevel
 * and so a reader of the ledger can see at a glance which rows were filed
 * from nowhere in particular. See `runIdFor` for why they share.
 */
export const NON_CHECKOUT_RUN = "NON_CHECKOUT";

/**
 * Which run a directory belongs to, or why that could not be read.
 *
 * **Three readings, because collapsing the third into the second is a
 * fact-collapse in the cap's denominator.** `run` is a checkout's toplevel,
 * or `NON_CHECKOUT_RUN` for the shared bucket — both of them ANSWERS. `null`
 * is not an answer: the remote could not be read at all, and a gate that
 * spelled that the same as "no origin" would move a real checkout into the
 * shared allowance whenever git timed out.
 */
export interface RunReading {
  /** The run, or `null` when the reading failed. */
  run: string | null;
  /** Why it failed. Present only when `run` is null. */
  why?: string;
}

/**
 * Which RUN a filing belongs to — the checkout it was filed from.
 *
 * **Not the session, and the measurement is why.** `filingBatch` mints
 * `${session}.${pid}`, and on the live ledger that resolves to **two**
 * session values across 186 emitted rows while the pid changes on every
 * hook invocation: one Claude Code session hosts every subagent, and each
 * Bash call is its own process. So the key identifies a COMMAND and a
 * SESSION and nothing in between, and a cap keyed on either is a cap
 * shared by two hundred agents or a cap that resets every command.
 *
 * The checkout is the unit that is neither. It is one agent's piece of work
 * from start to finish, it is the same unit Cloudflare's 1.2-per-review is
 * measured over, and it is already in this gate's hand as `projectRoot`.
 *
 * Through `toplevel` from `lib/launch-base.ts`, so `/wt/x` and `/wt/x/lib`
 * are one run and there is one binding for "which checkout is this".
 *
 * **A checkout counts as its own run only if it has an origin remote.**
 * `toplevel` alone was not enough and the second review round said so: a
 * bare `git -C <dir> rev-parse --show-toplevel` answers for a directory
 * somebody `git init`ed a second ago, so `git init /tmp/x && cd /tmp/x`
 * minted a fresh allowance for one command. Measured: two sibling `git
 * init`s return two distinct toplevels and **no origin**. The remote is
 * read through `readWorktreeRemote`/`repoSlug`, the same pair
 * `lib/launch-base.ts` reads, so there is one opinion about what a
 * repository is.
 *
 * ## The bound. This is a DEFAULT, not a boundary — four routes stand open
 *
 * Stated so a reader knows the shape of what is not covered, rather than
 * rediscovering it one route at a time. Three fixes narrowed this predicate
 * — `resolve()` → `toplevel()` → `toplevel()` + a real origin — and each
 * left a cheaper route, because **the thing being defended against is not
 * reachable from here at all.** A filer owns its own directory; no identity
 * derived from that directory can resist one.
 *
 * | route | cost | still open |
 * |---|---|---|
 * | `git worktree add /tmp/y` | 1 command, carries the parent's origin | **yes** |
 * | `git init` + `git remote add origin <real url>` | 2 commands | **yes** |
 * | `git remote remove origin` | 1 command, re-keys an EXISTING checkout out of its own run and into the bucket | **yes** |
 * | a sub-group checkout (`host:group/sub/name`) | not a bypass — `normaliseSlug` wants exactly two segments, so a legitimate unit is bucketed with the nowheres | **false negative** |
 *
 * `git worktree add` is the one that should NOT be read as a hole: one
 * agent, one worktree, one piece of work is exactly the unit the cap is
 * meant to meter, so a new worktree getting a new allowance is the unit
 * working. What separates it from `git init /tmp/x` is not cost — it is
 * that one is a unit of work and the other is a directory made to obtain a
 * number. The residual exposure is an agent that creates a real worktree in
 * order to launder a filing, and nothing in this function can see that.
 *
 * **The defence is a SECOND key with its own ceiling, keyed on the TARGET
 * repository** — the one value in this gate's hand that the filer does not
 * pick — refusing when either key is over. Not usable as the unit on its
 * own: 284 registered worktrees against a measured 64 issues a day makes
 * one allowance per repository a 98% refusal rate, which is a gag and not a
 * cap, and with no `--repo` the target derives from origin, so as an
 * admission test it is circular. Its number has to come from measurement
 * and is deliberately not invented here.
 *
 * **Every directory that is not a checkout is ONE run, `NON_CHECKOUT_RUN`.**
 * This read `resolve(projectRoot)` first, so each non-checkout directory was
 * its own run — and that made the allowance keyable by the filer: `mkdir
 * /tmp/x && cd /tmp/x && gh issue create` mints a fresh one, every time, at
 * no cost. The first docblock said so out loud and argued the exposure was
 * acceptable because nothing else here tracks a `cd` either. It is not
 * acceptable for THIS field, because this one is the cap's denominator: a
 * gate whose unit the filer chooses is not a gate. Reversed on 2026-10-24
 * after the security review of PR #1597 named it, and the earlier reasoning
 * is kept here rather than deleted because it is the argument a later agent
 * will reach for again.
 *
 * The cost is real and is the one the first spelling was avoiding: every
 * filing from outside a checkout on this machine now shares one allowance.
 * That is the fail-closed direction, and it is narrow — an agent works in a
 * worktree, which is a checkout, and `toplevel` resolves `/wt/x/lib` to
 * `/wt/x` so sub-directories were never separate runs in the first place.
 *
 * Legacy rows are unaffected: they carry `run: null`, which matches no run
 * and is counted towards nothing, so this does not fold them into the
 * bucket. `null` and `NON_CHECKOUT_RUN` are different readings and stay so.
 *
 * What this still does NOT defend against is a filing that never reaches
 * this chokepoint — `curl`, the MCP tools, another machine. This file's own
 * header lists those, and the cap governs the default.
 *
 * **One bound on the INPUT, which this function cannot fix.** `projectRoot`
 * reaches here from `process.cwd()` in `hooks/VerifyPhaseLock.hook.ts`,
 * which is the SESSION's directory and not necessarily the agent's
 * worktree — a hook has no way to learn the latter when they differ. So
 * several agents hosted by one session, working in different worktrees, can
 * share one allowance. Recorded as a stated limit rather than left implicit
 * (#1595, after the security review of PR #1597).
 *
 * `read` is injectable **only so the failed-read state can be driven**: with
 * a real git on PATH that state is a timeout or a git that vanished between
 * two commands, and neither is producible in a test. It defaults to the real
 * reader, and `worktreeDiskIdentity` takes the same parameter for the same
 * reason — a gate whose default reader is a stub is the check that never
 * looked, so the default is asserted rather than assumed.
 */
export function runIdFor(
  projectRoot: string,
  read: (worktreePath: string) => RemoteReading = readWorktreeRemote,
): RunReading {
  const top = toplevel(projectRoot);
  if (top === null) return { run: NON_CHECKOUT_RUN };
  const remote = read(top);
  // **The read failing is not the same fact as there being no origin.**
  // `readWorktreeRemote` sets `error` for a timeout, a missing git and a
  // healthy checkout with no remote alike; `missing` is the half that was
  // observed. Without this split a ten-second git timeout re-buckets a real
  // checkout into the shared allowance — one value carrying two facts, in
  // the field that decides the cap's denominator, which is the shape this
  // file already refuses for the ledger.
  if (remote.error !== null && !remote.missing) {
    return { run: null, why: remote.error };
  }
  // A checkout nobody can name is not a run. `git init` makes a toplevel in
  // one command; it does not make an origin.
  return { run: namesARepository(remote.url) ? top : NON_CHECKOUT_RUN };
}

/**
 * Is this remote a URL or scp form naming a repository?
 *
 * **Narrower than `repoSlug` on purpose, and the extra condition is the
 * point.** `repoSlug` accepts a bare `owner/name` as its last branch,
 * because that is how a run's own `repo` ARGUMENT arrives — a different
 * caller answering a different question. Reused here it makes
 * `git remote add origin a/b` mint an allowance: two words, no URL, no
 * repository, a fresh run. Found by the security review of `377e3a06`.
 *
 * So the transport form is required first and `repoSlug` still decides what
 * a slug is. That is one reader per question rather than two informally
 * aligned ones: this says *"is this a remote"*, `repoSlug` says *"which
 * repository"*, and neither restates the other.
 */
export function namesARepository(url: string | null): boolean {
  if (url === null) return false;
  const s = url.trim();
  // `scheme://…` or scp-style `user@host:path`. A bare slug matches neither,
  // and a filesystem path has no authority, so neither does it.
  const transported = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(s) || /^[^/\s]*@[^/:\s]+:\S+$/.test(s);
  return transported && repoSlug(s) !== null;
}

/**
 * The suffix that tells an intent row apart from the outcome row it reserves.
 *
 * The two rows are one decision and the join between them matters, so the
 * intent takes the outcome's key plus this rather than a key of its own.
 * `summariseFindingOutcomes` refuses a corpus of repeated ids, so they cannot
 * simply share one.
 */
export const INTENT_KEY_SUFFIX = "#intent";

/** The suffix on the row that gives an intent back. See `releaseAllowance`. */
export const RELEASE_KEY_SUFFIX = "#released";

/**
 * Every intent this run has registered inside the window, in ledger order.
 *
 * **One walk, two questions.** "How many has this run reserved" and "where in
 * the queue is mine" are the same population read two ways, and two walks
 * would be the fourth shape in `.claude/rules/checks-must-be-able-to-fail.md`
 * — a mutation of either leaves the other holding the case up.
 *
 * **Intents and not `emitted` rows, since the race fix.** An intent is
 * appended before the gate decides and an `emitted` row after, so a counter
 * reading `emitted` cannot see a filing that is in flight — which is exactly
 * the window two parallel hook processes both read in. See
 * `FilingLedgerRow.intent`.
 *
 * A refused filing still consumes nothing: an intent is only ever appended
 * for a clause the command-level decision has already cleared, so a clause
 * refused on its merits, and every clause of a blocked command, registers
 * none.
 *
 * A row whose `at` cannot be parsed is **counted**, not skipped. It is a row
 * this writer appended; the alternative is a filing that escapes the count
 * by carrying a timestamp nobody can read.
 */
export function runIntents(
  rows: readonly FilingLedgerRow[],
  run: string,
  now: number,
  window: number = RUN_WINDOW_MS,
): (string | null)[] {
  // **One pass, in file order, and a release only cancels an intent that
  // PRECEDES it.** Collecting released keys up front and filtering on the
  // set is the shorter spelling and it is wrong: `filingBatch` mints the
  // key from the session, the pid and the timestamp, so a retry inside the
  // same millisecond reuses it — and a release written for the first
  // attempt would free the second attempt's live reservation. Measured
  // while building `FG-170`, where three calls shared a pinned `now`: the
  // third filing was allowed against a spent allowance. Order is what tells
  // a cancelled reservation from a later one wearing the same name, and
  // this file is append-only, so order is the thing it always has.
  const live: (string | null)[] = [];
  for (const row of rows) {
    const gave = row.releases ?? null;
    if (gave !== null) {
      const at = live.lastIndexOf(gave);
      if (at !== -1) live.splice(at, 1);
      continue;
    }
    if (row.intent !== true) continue;
    if ((row.run ?? null) !== run) continue;
    const at = Date.parse(row.at);
    if (Number.isFinite(at) && now - at > window) continue;
    live.push(row.key);
  }
  return live;
}

/**
 * How many filings this run has already registered inside the window.
 *
 * Exported so a test reads the same answer the gate acts on.
 */
export function intentsInRun(
  rows: readonly FilingLedgerRow[],
  run: string,
  now: number,
  window: number = RUN_WINDOW_MS,
): number {
  return runIntents(rows, run, now, window).length;
}

/**
 * Where one intent sits in its run's queue, 1-based. **The race verdict.**
 *
 * `key` is the intent row's own key — the outcome row's, plus
 * `INTENT_KEY_SUFFIX`.
 *
 * **Two different things produce "not found" and they take different
 * positions.** Collapsing them to one answer is wrong in one direction or
 * the other, and the first spelling of this function collapsed them:
 *
 * - **`key === null`** — `filingBatch` returned `null` because
 *   `CLAUDE_CODE_SESSION_ID` is absent, so the row has no identity. Our
 *   intent **is** in this queue; we appended it and cannot point at it. The
 *   safe position is `queue.length`: last among what is visible, and `1`
 *   when ours is the only one. Reading `queue.length + 1` here would count
 *   us twice and refuse **every** filing from an unkeyed session, which is a
 *   gag and contradicts `unkeyedLedgerNote`'s stated policy that such a
 *   filing proceeds.
 * - **a key that is genuinely absent** — the re-read did not contain our own
 *   append. Our intent is **not** in this queue, so every row in it precedes
 *   us and the only safe position is `queue.length + 1`. Reading
 *   `queue.length` here hands us the last EXISTING slot rather than the next
 *   one, so with one other intent queued and a cap of 1 we would compute
 *   ordinal 1 and win while genuinely second. Found by the security review
 *   of `822d5d7d`.
 *
 * An empty queue with a null key is `0` — nothing has reserved anything,
 * which is the same answer an absent ledger gives, and it cannot arise from
 * our own append because that append put a row in the queue.
 *
 * **`lastIndexOf`, so two rows sharing a key take the LATER position.**
 * `filingBatch` makes the key unique across live writers by carrying the pid,
 * so a collision should not happen — but if one ever does, `indexOf` hands
 * the loser the winner's position and the loser files. Reading from the back
 * costs nothing and fails in the direction a cap must fail in.
 */
export function intentOrdinal(
  rows: readonly FilingLedgerRow[],
  key: string | null,
  run: string,
  now: number,
  window: number = RUN_WINDOW_MS,
): number {
  const queue = runIntents(rows, run, now, window);
  if (key === null) return queue.length;
  const at = queue.lastIndexOf(key);
  return at === -1 ? queue.length + 1 : at + 1;
}

/**
 * An intent row's `withheldBy`, between the append and the re-read.
 *
 * One exported constant for the same reason `COMMAND_BLOCKED` is one: a
 * single declaring position for the string the ledger carries.
 */
export const INTENT_PENDING = "INTENT_PENDING" satisfies WithheldBy;

/**
 * What the queue said about one intent.
 *
 * Every outcome that APPENDED carries the row it appended, because the caller
 * has to be able to release it. `UNRESERVED` is the one that did not.
 */
export type AllowanceReading =
  | { outcome: "WON"; intent: FilingLedgerRow }
  /** `already` is how many intents preceded this one. */
  | { outcome: "LOST"; already: number; intent: FilingLedgerRow }
  /** The intent could not be appended, so no position was taken. */
  | { outcome: "UNRESERVED" }
  /** The intent was appended and the queue could not be read back. */
  | { outcome: "UNCOUNTABLE"; intent: FilingLedgerRow };

/**
 * Take a position in this run's queue, then read it back. **The race fix.**
 *
 * ## The race
 *
 * `read the ledger → decide → write the row` has the decision in the middle,
 * and the hook does the writing after `filingGate` returns. Two hook
 * processes — one session, parallel subagents, a `gh issue create` each —
 * that both read before either wrote both counted zero filings and both
 * filed, and the ledger afterwards is indistinguishable from two filings a
 * day apart. The window is the whole of `filingGate`, which makes a network
 * call to the tracker, so it is hundreds of milliseconds wide and not a
 * theoretical one.
 *
 * ## Append-then-verify, and why there is no lock
 *
 * The intent is appended FIRST and the verdict is read off its position
 * afterwards. Appends to one file are serialised by the filesystem, so the
 * positions are a total order every process agrees on without coordinating:
 * the first `FILINGS_PER_RUN` intents in a run's window win and every later
 * one is `OVER_CAP`. Both racers see the same file; they just see themselves
 * in different places in it.
 *
 * A lock would need a second artefact, an owner, and an answer for the
 * process that dies holding it — and a hook that blocks on a stale lock file
 * is a gate that stops every filing on the machine. The ordering the ledger
 * already has is free.
 *
 * ## Both ledger failures REFUSE, and the first spelling got one of them wrong
 *
 * - **The re-read failed** (`UNCOUNTABLE`) — the file is present and
 *   unreadable. The ledger is the cap's STATE rather than its apparatus, so
 *   this refuses exactly as `UNMEASURED_CAP` does everywhere else here.
 * - **The append failed** (`UNRESERVED`) — this ALLOWED, loudly, on
 *   `recordAdjudication`'s policy that a measurement apparatus must not block
 *   the thing it measures. That policy is right for the row that RECORDS a
 *   decision and wrong for the row that MAKES one: a failure to update the
 *   cap's state is indistinguishable from an attempt to disable it, so an
 *   unwritable ledger switched the cap off. The two branches were written in
 *   one commit and took opposite positions about the same file. Both refuse
 *   now, and `unreservedCapReason` names the write so an operator knows which
 *   half to repair.
 *
 * ## The caller must RELEASE what it reserved
 *
 * The intent is on the ledger from the moment `append` returns true, whatever
 * the outcome. A command that goes on to file nothing has to give it back —
 * `releaseAllowance` — or the ordinary two-clause command at a cap of one
 * strands the run's allowance. The reading carries the row it appended so the
 * caller has something to release.
 */
export function reserveAllowance(
  row: FilingLedgerRow,
  run: string,
  io: {
    now: number;
    append: (row: FilingLedgerRow) => boolean;
    readLedger: () => FilingLedgerRow[] | null;
    window?: number;
  },
): AllowanceReading {
  const intent: FilingLedgerRow = {
    ...row,
    key: row.key === null ? null : `${row.key}${INTENT_KEY_SUFFIX}`,
    intent: true,
    // A reservation is not a receipt and makes no judgement: the outcome row
    // carries both. See `FilingLedgerRow.intent` for why `emitted` here would
    // double every filing this reserves.
    emitted: false,
    withheldBy: INTENT_PENDING,
    refusal: null,
    overridden: false,
  };
  if (!io.append(intent)) return { outcome: "UNRESERVED" };
  const after = io.readLedger();
  if (after === null) return { outcome: "UNCOUNTABLE", intent };
  const ordinal = intentOrdinal(after, intent.key, run, io.now, io.window);
  return ordinal > FILINGS_PER_RUN
    ? { outcome: "LOST", already: ordinal - 1, intent }
    : { outcome: "WON", intent };
}

/**
 * Give back a reservation, by appending rather than by rewriting.
 *
 * Nothing in this file rewrites a row: the total order that appends give is
 * the property the race fix rests on, and a file being rewritten underneath a
 * concurrent reader has no order at all. So a release is a row naming the key
 * it gives back, and `runIntents` subtracts it.
 *
 * Returns whether the release landed. A release that fails leaves the
 * reservation standing, which costs the run an allowance it did not spend —
 * loud, and the same direction as every other failure here.
 */
export function releaseAllowance(
  intent: FilingLedgerRow,
  append: (row: FilingLedgerRow) => boolean,
): boolean {
  // A null-keyed intent cannot be named, so there is nothing to release and
  // saying so is cheaper than appending a row that releases nothing.
  if (intent.key === null) return false;
  return append({
    ...intent,
    key: `${intent.key}${RELEASE_KEY_SUFFIX}`,
    intent: false,
    releases: intent.key,
    emitted: false,
    disposition: "DROP",
    withheldBy: COMMAND_BLOCKED,
  });
}

/** The refusal an agent reads when the run has spent its allowance. */
export function overCapReason(run: string, already: number, target: CommentTarget): string {
  return [
    `this run has already filed ${already} issue(s) in the last ${RUN_WINDOW_MS / 3_600_000}h, and the cap is ` +
      `${FILINGS_PER_RUN}. The overflow is a comment.`,
    "",
    `  ${commentTargetSentence(target)}`,
    "",
    `  run: ${run}`,
    "",
    "  There is no argument against this and no label that waives it. It is a count, not a",
    "  judgement about your finding, which may well be a good one — the cap exists because a",
    "  per-finding judgement drifts and a count does not. If several findings belong on the",
    "  tracker, they are one issue naming every instance, not several.",
  ].join("\n");
}

/**
 * The refusal when the allowance cannot be RESERVED (#1595).
 *
 * Separate text from `uncountableCapReason`, because an operator repairs a
 * different half: that one is a file that cannot be read, this one a file
 * that cannot be written. The refusal is the same because the consequence is
 * the same — the cap's state did not change, so the cap did not hold.
 */
export function unreservedCapReason(run: string, target: CommentTarget): string {
  return [
    `this run's allowance could not be RESERVED: the intent row could not be appended to ` +
      `${ledgerPath()}. The cap is ${FILINGS_PER_RUN} per run and it is not measurable right now.`,
    "",
    `  ${commentTargetSentence(target)}`,
    "",
    `  run: ${run}`,
    "",
    "  This refuses rather than allowing, and the symmetry is deliberate: a ledger that cannot",
    "  be WRITTEN is not a broken instrument beside the gate, it is the gate's own state failing",
    "  to change. Allowing here would mean anything able to make one file unwritable switches the",
    "  cap off. Repair or move the file — an operator's job, not a re-draft of this filing.",
  ].join("\n");
}

/**
 * The refusal when the allowance cannot be counted at all (#1595).
 *
 * Names the ledger, because this is the one refusal in the file an OPERATOR
 * has to act on rather than the agent: nothing the filer writes will change
 * it, and the remedy is to repair or move the file. Says so, so the agent
 * does not spend a turn re-drafting a body that was never the problem.
 */
export function unreadableRunReason(why: string, target: CommentTarget): string {
  return [
    `this filing's RUN could not be read, so there is no denominator to count against:`,
    `${why}. The cap is ${FILINGS_PER_RUN} per run and this directory's run is unknown.`,
    "",
    `  ${commentTargetSentence(target)}`,
    "",
    "  This is NOT the same as filing from somewhere that is not a checkout — that is an",
    "  answer, and it shares one allowance with every other such directory. A read that",
    "  failed is not an answer, and treating it as one would move a real checkout into the",
    "  shared allowance every time git timed out. Nothing about your finding is in question.",
  ].join("\n");
}

export function uncountableCapReason(run: string, target: CommentTarget): string {
  return [
    `the filing ledger at ${ledgerPath()} is present and could not be read, so this run's`,
    `allowance cannot be counted. An unreadable ledger is not an empty one — an ABSENT ledger`,
    "is a machine that has filed nothing and allows — so this refuses rather than restoring a",
    "full allowance to anything that can make one file unreadable.",
    "",
    `  ${commentTargetSentence(target)}`,
    "",
    `  run: ${run}`,
    "",
    "  Nothing about your finding is in question and re-drafting it will not help. Repair or",
    "  move the ledger, or post the comment above. No label waives this one either.",
  ].join("\n");
}

/**
 * The closed list of reasons a finding cannot be a comment (#1595).
 *
 * **THE RECORD, NOT THE GATE. `FILINGS_PER_RUN` above is the gate.** This
 * check was written as the bar and it is not one: applied on 2026-10-24 to
 * the three issues filed that day, all three cleared it on individually
 * sound arguments, because *it makes a green check lie* admits any true
 * finding in a repository about checks that lie. It stays because a
 * declaration is cheap to read, cheap to audit, and is the column that makes
 * a per-class not-useful rate computable later. It stops nothing on its own.
 *
 * **DO NOT ADD A FOURTH.** A clause added later to admit one good finding is
 * how the leak comes back, and it will look reasonable at the time.
 * `test/issue-filing-gate.test.ts` binds the size of this object for exactly
 * that reason — growing it fails the suite, which is the only form of "do
 * not" that survives the next agent who has a good reason.
 *
 * **A declaration, not a judgement.** `lib/finding-arbiter.ts`'s header has
 * said since it was written that `Disposition` defaults to `COMMENT` and that
 * `ISSUE` requires an explicit declared reason from the caller
 * (`Finding.outOfScope`). That decision never reached this file: the header
 * above lists three stages that genuinely cannot run at a PreToolUse hook —
 * no verifier group, no PR diff, no branch to scope against — and the
 * out-of-scope declaration travelled with them without being one of them. It
 * needs nothing but the command line this hook already holds.
 *
 * **Closed, and not free text.** A free-text `--reason` is the same bar as
 * `NO_CLAIM`, which three of four filings on 2026-10-23 cleared in one
 * sentence each. The research behind #1595 is that per-finding judgement
 * drifts and categorical lists do not: Cloudflare's 1.2-findings-per-review
 * comes from a *"What NOT to Flag"* exclusion list, and Google Tricorder's
 * only published threshold acts on the analyzer rather than on the finding.
 *
 * **This is NOT a severity gate and NOT a worthiness score.** Both are
 * excluded deliberately above and #1261 asked for duplicates-and-already-known
 * in those words. Nothing here reads how bad the finding is. It reads whether
 * somebody said which of three things is true of it.
 *
 * The values are the three #1595 names, verbatim. Adding a fourth is an edit
 * to this object and a row in `test/issue-filing-gate.test.ts`; widening it to
 * anything a caller can spell is the failure the whole mechanism exists to
 * prevent.
 */
export const COMMENT_EXEMPTIONS = {
  "out-of-pr-diff": "the subject is outside any open PR's diff",
  "evidence-expires": "the evidence expires — logs, or a measurement population",
  "green-check-lies": "it makes a green check lie",
} as const;

/** One of the three declarations above. There is no fourth and no `other`. */
export type CommentExemption = keyof typeof COMMENT_EXEMPTIONS;

/**
 * The words a caller writes to declare one.
 *
 * In the title or body rather than in a flag, for two reasons. It is where
 * `namedClaim` already looks, so a filing carries its declarations in one
 * place and the chokepoint needs one reading; and the declaration ends up in
 * the issue a human later opens, which is the only position from which the
 * per-class not-useful rate this records can ever be interpreted.
 *
 * Deliberately not a `--label`: a label `gh` does not already know about
 * fails the create outright, with a message about labels, which would hide
 * this gate behind an unrelated error.
 */
export const EXEMPTION_PREFIX = "Cannot be a comment:";

/**
 * Which declaration a filing makes, or `null` for none.
 *
 * **The token must be one of the three.** A prefix with an unknown word after
 * it reads as no declaration at all rather than as a declaration of something
 * else, because the hole in every format-only check is a value nobody can
 * look up — the same hole `namedClaim` closes by BOUNDING the claim number
 * instead of merely requiring a digit.
 *
 * All matches are scanned and the first recognised one wins, so a body that
 * discusses the mechanism before declaring against it still reads.
 *
 * ## The refusal text must not satisfy this
 *
 * `exemptionRefusal` lists the three tokens, and an agent that pastes a
 * refusal into the body it re-files with would otherwise clear the gate using
 * the gate's own words — an allowlist that names what it exempts becomes
 * evidence those things were named. The list is rendered so that no line of
 * it parses here, and `test/issue-filing-gate.test.ts` asserts that by feeding
 * the refusal back through this function rather than by trusting the layout.
 */
export function declaredExemption(text: string): CommentExemption | null {
  for (const m of text.matchAll(/cannot\s+be\s+a\s+comment\s*:\s*`?([a-z][a-z-]*)/gi)) {
    const token = m[1].toLowerCase();
    if (token in COMMENT_EXEMPTIONS) return token as CommentExemption;
  }
  return null;
}

/**
 * Where the comment should go instead, when this gate refuses a filing.
 *
 * **A refusal that does not name the alternative becomes a refusal everybody
 * routes around**, which is the argument `refusalMessage` already makes and
 * the three VERIFY-lock bypasses in `lib/issue-create-override.ts` are what
 * it looks like when it is ignored. #1595 asks for the target by name — *post
 * this as a comment on PR #N or issue #M* — and for the message to say which.
 *
 * One discriminator, and `NO_PR` is a reading rather than a gap: a branch
 * with no open PR is a real state an agent can act on (open the PR, or post
 * on the issue the work is claimed under), and it is a different fact from a
 * lookup that could not be performed. Collapsing them would be the Silent
 * Default Substitution `.claude/rules/config-access.md` forbids, in the one
 * sentence the agent actually reads.
 */
export type CommentTarget =
  | { reading: "PR"; number: number; branch: string }
  | { reading: "NO_PR"; branch: string }
  | { reading: "UNMEASURED"; why: string };

/**
 * No target was looked up, said as a reading.
 *
 * The DEFAULT for `adjudicateFiling`, so the adjudicator stays a pure
 * function of what it was handed and a caller that wants the network says so.
 * `filingGate` supplies the live one; `evals/` and the unit rows do not, and
 * an eval that silently opened a GitHub connection would be measuring the
 * network as well as the adjudicator.
 */
export const UNRESOLVED_COMMENT_TARGET: CommentTarget = {
  reading: "UNMEASURED",
  why: "no comment-target reader was supplied, so no open PR was looked up",
};

/**
 * The alternative, in one sentence that names it and says which kind it is.
 *
 * Composed HERE and not at the refusal site, because the reading is the only
 * thing that knows which of the three states it is in — the same reason
 * `CorpusReading` carries its own `why` rather than letting a caller write a
 * sentence that can be false for the input it is emitted on.
 */
export function commentTargetSentence(target: CommentTarget): string {
  switch (target.reading) {
    case "PR":
      return `Post it as a comment on PR #${target.number}, the open PR for branch \`${target.branch}\`.`;
    case "NO_PR":
      return (
        `Branch \`${target.branch}\` has no open PR, so there is no diff to comment on yet: ` +
        "post it on the issue this work is claimed under, or open the PR and comment there."
      );
    case "UNMEASURED":
      return (
        `UNMEASURED comment target — ${target.why}. The refusal stands: whether you declared a ` +
        "reason is a fact about this command, not about the tracker. Post it on the PR or issue " +
        "you are working, and say which."
      );
  }
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
  /**
   * Which reason the caller declared, or `null` for none (#1595).
   *
   * Carried on EVERY adjudication and not only on the refusal, because the
   * population is the point: the per-class not-useful rate #1595 asks to make
   * computable is `(closed wontfix/duplicate/no-change) / (all closed in that
   * class)`, and a column present only on the rows that were refused can
   * never supply its denominator.
   */
  exemption: CommentExemption | null;
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
 * `severity` and `jury` are always `null` **when this file writes the row**,
 * and are present anyway, so the two row shapes parse under one reader. A
 * chokepoint has no verifier group, and an absent vote is not a severity of
 * `Important`.
 *
 * They are typed `| null` rather than `null` since #1467. They were the bare
 * literal, which made the row shape unable to *hold* a vote rather than merely
 * not carrying one here — and `scripts/arbitrate-finding.ts`, the one path in
 * the tree that takes a ballot, writes to this same ledger. CRC-B4 asks that
 * the ledger record every verifier's individual vote and whether the verifiers
 * disagreed; a field typed `null` cannot, whatever is wired to it. The
 * chokepoint's own rows are unchanged and still write `null` for both.
 */
export interface FilingLedgerRow {
  /**
   * The plan that authorised this filing — `<path>:<line>` on `origin/main` —
   * or `null` for one no plan names.
   *
   * On EVERY row, not only the exempted ones, for the same reason
   * `FilingAdjudication.exemption` is: the question the cap's second route
   * raises is *how much of what we file is planned*, and that is a ratio. A
   * column present only where the exemption fired can supply its numerator
   * and never its denominator.
   *
   * It is also the audit trail for the exemption itself. An exemption that
   * reaches the tracker without naming the merged plan it rode in on is
   * indistinguishable from the cap not having been applied.
   */
  plannedBy?: string | null;
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
  severity: Severity | null;
  disposition: Disposition;
  refusal: ArbiterRefusal | null;
  /** Did it reach the tracker? */
  emitted: boolean;
  withheldBy: WithheldBy | null;
  /** The vote, when one was taken. `null` when no group was convened. */
  jury: JuryReading | null;
  duplicateOf: string[];
  /** The refusal was overridden with `--label arbiter-override`. */
  overridden: boolean;
  /**
   * The `at` of a prior REFUSE row for this same title, when one exists.
   *
   * **The field that makes an override survive a re-drafted body (#1536).**
   * `overridden` used to read `verdict.outcome === "REFUSE" && labelled`,
   * which is correct about this adjudication and blind to the one that came
   * before it: the body feeds `symptomHash`, so writing down *why* you are
   * overriding changes the keys, the duplicate stops matching, the verdict
   * is no longer a refusal and the label is never exercised. Measured on the
   * live ledger — the #1520 filing, same title, 37 seconds apart:
   *
   *     10:55:08.109Z  DROP   refusal=DUPLICATE  emitted=false  overridden=false
   *     10:55:45.786Z  ISSUE  refusal=null       emitted=true   overridden=false
   *
   * One `overridden: true` row had ever been written, against two overrides
   * performed that day. The countability `refusalMessage` promises was 50%
   * in the only sample there was.
   *
   * The join is the **title**, not the hash, and that is the whole point: an
   * override is a claim about a specific prior refusal, so it has to be
   * recognised by something the re-draft does not touch. `duplicateOf` on
   * this row then carries that refusal's targets, so the row names what was
   * waived rather than implying it.
   *
   * `null` also when the ledger could not be read — `priorRefusalFor`
   * returns `null` for "nothing matched" and the gate pushes
   * `unreadableLedgerNote` for "could not look", because those are different
   * states and only one of them is a reading.
   */
  refiledAfter: string | null;
  /**
   * Which of the three reasons the caller declared, or `null` (#1595).
   *
   * **Recorded on every row, kept and dropped alike, and that is the whole of
   * #1595's third scope item.** The rate it makes computable is per CLASS —
   * `(closed wontfix/duplicate/no-change) / (all closed in that class)` — and
   * the class key is `symptomHash`, already on this row since #1261. So the
   * join needs one new column and not a new store: group the rows by
   * `symptomHash`, read the declared reason off each, and the denominator is
   * every row in the group rather than only the ones somebody refused.
   *
   * The rate is deliberately NOT computed here or anywhere in #1595. Google
   * Tricorder's 10%/25% thresholds act on an ANALYZER over a population of a
   * reviewer's clicks; a closed-as-wontfix tracker issue costs an agent a
   * whole context, so the ratio is borrowed and the denominator is different.
   * Writing the column is what makes the question answerable later; writing a
   * threshold now would be the same unmeasured judgement this gate refuses.
   *
   * `null` is honest on three different rows and they are not told apart
   * here: a refused filing that declared nothing, an overridden one, and the
   * rows `scripts/arbitrate-finding.ts` and `lib/ai-review-jury.ts` write,
   * where no command line exists to carry a declaration. `refusal` and
   * `emitted` already separate those three, so a second encoding of the same
   * split would be a decider with a spare.
   */
  exemption: CommentExemption | null;
  /**
   * This row RESERVES the allowance; it does not record an outcome (#1595).
   *
   * **The whole of the race fix, written down as a column.** The cap used to
   * read the ledger, decide, and let the hook write the outcome afterwards —
   * three steps with the decision in the middle, so two hook processes that
   * both read before either wrote both saw a spent count of zero and both
   * filed. Nothing in the ledger could even show it afterwards: the two rows
   * are indistinguishable from two filings a day apart.
   *
   * An intent row is appended BEFORE the gate decides, and the decision is
   * then read off its POSITION among this run's intents in the window
   * (`intentsInRun`). Appends to one file are ordered by the filesystem, so
   * the position is a total order that needs no lock and no second file: the
   * first `FILINGS_PER_RUN` intents win and every later one is `OVER_CAP`.
   *
   * **`emitted: false`, always, and that is not a technicality.** A filing
   * count read off this ledger is `emitted && !intent`, and an intent row
   * that claimed `emitted: true` would double every filing it reserved —
   * #1344's overcount, reintroduced by the fix for the race. The outcome
   * lands on its own row, written by the hook as it always was, sharing this
   * row's key without the `INTENT_KEY_SUFFIX`.
   *
   * **A losing intent is never retracted, and it costs nothing.** It stays on
   * the ledger holding its ordinal, so later reads count it. That cannot gag
   * a run that has not spent its allowance: an intent can only lose when
   * `FILINGS_PER_RUN` intents precede it, and by induction those all won — so
   * a count at or above the cap always means the cap was genuinely reached.
   *
   * Absent on every row written before this existed, and on the rows
   * `scripts/arbitrate-finding.ts` and `lib/ai-review-jury.ts` write, neither
   * of which reserves anything. Absent reads as `false`.
   */
  intent?: boolean;
  /**
   * The `key` of an intent row this row gives back (#1595).
   *
   * **An intent that reserved an allowance for a command that then filed
   * nothing has to be released, and an append-only file releases by
   * appending.** The reservation is taken after the command-level decision
   * so a command already refused reserves nothing — but a refusal GENERATED
   * by the reservation loop, which is what a two-clause command at a cap of
   * one produces every time, arrives after clause 0 has already reserved.
   * Without this column that command files nothing and spends the run's only
   * allowance, and the corrected re-run is `OVER_CAP`: the exact outcome the
   * ordering exists to prevent, reached by the ordinary multi-clause path.
   *
   * `runIntents` subtracts released keys, so a released intent holds no
   * position. It is not retracted in place — nothing in this file rewrites a
   * row, because the total order appends give is the property the whole race
   * fix rests on.
   *
   * **A `null`-keyed intent cannot be released**, because nothing can name
   * it. That session's blocked multi-clause command does strand its
   * allowance for the window, and `unkeyedLedgerNote` already tells it that
   * its rows cannot be told apart. Fail-closed, stated rather than fixed by
   * inventing an identity.
   *
   * A release is visible only to reads that happen after it, so a racer that
   * already lost against a since-released intent stays lost and re-runs.
   * Conservative in the direction a cap must be conservative in.
   */
  releases?: string | null;
  /**
   * Which run filed it — the checkout, from `runIdFor` (#1595).
   *
   * **The cap's denominator, and it had to be written down before it could
   * be counted.** Nothing on this row could identify a run before: `key` is
   * `${session}.${pid}`, and on the live ledger that is two session values
   * across 186 emitted rows with the pid changing on every hook invocation.
   * So the existing identity answers "which command" and "which session"
   * and nothing in between, and the cap needs the unit between them.
   *
   * `null` on the rows `scripts/arbitrate-finding.ts` and
   * `lib/ai-review-jury.ts` write — neither adjudicates a `gh issue create`
   * from a checkout — and on every row written before this column existed.
   * **Not on a chokepoint filing from a directory that is not a checkout:**
   * `runIdFor` returns the `NON_CHECKOUT_RUN` bucket rather than `null`, so
   * the row still names a run and is still counted. Merging every
   * non-checkout filing on the machine into one allowance is deliberate and
   * is the fail-closed direction — see `runIdFor`, which first did the
   * opposite and was reversed.
   *
   * `emittedInRun` counts only rows whose `run` equals the run being
   * adjudicated, so a `null` row counts towards nothing. That is the honest
   * direction: a row that cannot name its run cannot be attributed to one,
   * and attributing it to all of them would cap every run on this machine
   * out of the backlog the column was added to measure.
   *
   * ## On an `UNMEASURED_CAP` row this field is a PLACEHOLDER, not a reading
   *
   * The gate writes `reading.run ?? NON_CHECKOUT_RUN`, and `runIdFor`
   * returns `null` when the remote read FAILED — a git timeout, a git that
   * vanished. So a row refused `UNMEASURED_CAP` for an unreadable run says
   * `NON_CHECKOUT`, which is a different fact: *"this is not a checkout"*
   * and *"I could not tell"* spelled identically, in the field that is the
   * cap's denominator. The same value, for two reasons — exactly the
   * conflation `RemoteReading.missing` exists to end one level down.
   *
   * It is harmless **today and only today**, for a reason that is a property
   * of the current readers rather than of the value: nothing aggregates by
   * `run`, and the two counters that read it (`intentsInRun`,
   * `emittedInRun`) key off `intent`/`emitted`, which are both false on an
   * `UNMEASURED_CAP` row. **The first reader that groups rows by `run` will
   * silently fold unreadable runs into the non-checkout bucket**, and it
   * will do so without touching this file.
   *
   * So: do not read this field off a refused row, and do not reach for it as
   * a discriminator between the two states — `FG-174` asserts that both
   * arms write the same value precisely so that a later case cannot. The fix
   * is a third sentinel, deliberately deferred to the decision-loop refactor
   * rather than added as a fifth patch to `runIdFor` (#1595, PR #1603).
   */
  run: string | null;
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
 * A resolved clause, as a `Finding` — the ONE binding (#1595).
 *
 * `adjudicateFiling` resolved this inline and `filingGate` now needs the same
 * object to compare a clause against its own siblings. Two spellings of "what
 * finding is this command filing" would be two deciders for one question, and
 * the second one always agrees with the first until the day it does not
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
 *
 * `body` is `null` for a `--body-file` that could not be read, which is the
 * UNMEASURED arm downstream; `finding.body` falls back to the inline value so
 * the keys are taken over whatever text there actually is. Those are
 * deliberately different fields and not one: an empty body that WAS read and
 * a body nobody could read are different facts.
 */
export function filingFinding(
  attempt: FilingAttempt,
  readBody: (path: string) => string | null = readBodyFile,
): { body: string | null; finding: Finding } {
  const body = attempt.bodyFile === null ? attempt.body : readBody(attempt.bodyFile);
  return { body, finding: { id: UNFILED_ID, title: attempt.title, body: body ?? attempt.body } };
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
  readTarget: () => Promise<CommentTarget> = async () => UNRESOLVED_COMMENT_TARGET,
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
  const { body, finding } = filingFinding(attempt, readBody);
  const category = classifyCategory(finding);
  const declared = declaredExemption(`${attempt.title}\n${body ?? attempt.body}`);
  const base = {
    category,
    symptomHash: symptomHash(finding),
    duplicateOf: [] as string[],
    collidingKeys: [] as string[],
    exemption: declared,
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
  // Cleanup is still postable, and this used to say so by spelling the
  // token: *"post it as cleanup with `--label arbiter-override`"*.
  //
  // **That was the complete bypass recipe, one field up from the tail it was
  // removed from on 2026-10-25.** `NO_CLAIM` is issued BEFORE
  // `COMMENT_INSTEAD`, so a filing that is undeclared and claimless is
  // refused here — and this sentence then handed over the label that waived
  // it, which carried the filing to the tracker without the comment default
  // ever being consulted. The refusal taught the route around itself, and
  // the route it taught was the cheapest one in the file.
  //
  // The sentence that replaces it keeps what was true — cleanup is postable
  // and the route is counted — and drops the recipe. An agent that already
  // holds the token still has it; one that does not does not learn it from
  // a refusal. `refusalMessage`'s waivable tail makes the same trade and
  // the argument is written out there.
  //
  // It is also no longer a sufficient instruction: since the sibling fix the
  // label alone posts nothing, so a filing that really is cleanup needs the
  // declaration too. A half-recipe that still worked would be worse than
  // either.
  if (namedClaim(`${attempt.title}\n${body}`) === null) {
    return {
      ...base,
      outcome: "REFUSE",
      refusal: "NO_CLAIM",
      reason:
        `the filing is novel, and names no SUCCESS.md claim — nothing says what it moves. ` +
        `Name one as "Claim <1-${SUCCESS_CLAIM_COUNT}>" in the title or body. Genuine cleanup ` +
        `is still postable by a route that is deliberately not spelled in a refusal, and that ` +
        `route is recorded against this run and counted later`,
    };
  }

  // ── it says what it moves. does anybody say why it cannot be a COMMENT? ──
  //
  // **The stage #1595 is about, and the one the header above was missing.**
  // Everything before this asks whether the finding is worth posting. This
  // one asks the question the arbiter's own docblock says comes first — *the
  // default is a comment, not an issue* — and nothing on the live filing path
  // asked it. Measured when #1595 was filed: 772 issues ever, 48 open, 3
  // older than three days, and 70–85% of everything closed each day since
  // 2026-10-20 had been filed less than six hours before it closed. Filing
  // tracked closing almost exactly. A tracker that is an output of the review
  // loop cannot be drained by closing faster.
  //
  // **LAST, and after `NO_CLAIM` specifically.** The cost doctrine would put
  // a regex over a string already in hand first, and first is wrong for the
  // reason the stage above gives: a duplicate must be refused as DUPLICATE
  // and an UNMEASURED tracker must stay UNMEASURED, because a policy refusal
  // that outranks a reading failure is a reading failure nobody ever sees.
  // Only an ALLOW reaches here, so this can mask nothing.
  //
  // After `NO_CLAIM` rather than before it, which is the one ordering choice
  // here worth defending. Putting it first makes `NO_CLAIM` unreachable for
  // the common filing — a shipped gate deleted as a side effect of adding
  // one — and the round trip it would save does not exist: `refusalMessage`
  // already tells every refused filing to resolve it in the PR or answer it
  // in a comment, so a `NO_CLAIM` refusal has already routed the agent here.
  //
  // **A declaration, never an inference.** There is no heuristic that reads
  // "this looks out of scope", because an inferred exception is exactly how a
  // filing default comes back — `Finding.outOfScope` says so in those words.
  if (declared === null) {
    return {
      ...base,
      outcome: "REFUSE",
      refusal: "COMMENT_INSTEAD",
      reason: exemptionReason(await readTarget()),
    };
  }

  return {
    ...base,
    outcome: "ALLOW",
    refusal: null,
    reason:
      `no open issue shares this symptom, ${category} is not a dropped category, ` +
      `it names SUCCESS.md claim ${namedClaim(`${attempt.title}\n${body}`)}, and it declares ` +
      `\`${declared}\` — ${COMMENT_EXEMPTIONS[declared]}`,
  };
}

/**
 * Why this filing was refused, and where the comment goes instead.
 *
 * ## The three tokens are rendered so that this sentence cannot satisfy the gate
 *
 * An agent that re-files after reading a refusal pastes the refusal. If the
 * list below spelled `Cannot be a comment: out-of-pr-diff` the gate's own
 * words would clear the gate — an allowlist that names what it exempts
 * becomes evidence those things were named. So the prefix never appears
 * adjacent to a token: the instruction line carries a `<placeholder>`, which
 * `declaredExemption` does not match, and the tokens are listed on their own
 * lines with no prefix. `test/issue-filing-gate.test.ts` feeds this string
 * back through `declaredExemption` rather than trusting the layout.
 */
export function exemptionReason(target: CommentTarget): string {
  return [
    "nobody declared a reason this finding cannot be a comment, and a comment is the default.",
    "",
    `  ${commentTargetSentence(target)}`,
    "",
    "  If filing genuinely IS the exception, say which of these three is true of it, on its",
    `  own line in the title or body, as \`${EXEMPTION_PREFIX} <one-token-from-below>\`:`,
    "",
    ...Object.entries(COMMENT_EXEMPTIONS).map(([token, meaning]) => `      ${token} — ${meaning}`),
    "",
    "  The list is closed. A reason that is not one of those three is a reason to comment.",
  ].join("\n");
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
 * The open PR for this working directory's branch — the comment target.
 *
 * **Only ever called on the refusal arm**, so the allow path pays nothing for
 * it. The reading is composed from two probes and neither may be guessed:
 *
 * - the branch, through `branchOf` in `lib/launch-base.ts` — ONE binding for
 *   "what branch is this directory on", rather than a second `rev-parse`
 *   here that would agree with it until the day it did not;
 * - the open PRs whose head is that branch, through the same Octokit client
 *   and the same `withTimeout` ceiling the corpus read uses.
 *
 * `HEAD` is filtered: a detached checkout has no branch to query a PR by, and
 * `head=owner:HEAD` would return an empty list that reads exactly like a
 * branch with no PR open. Two states, one observable — so the one that was
 * never asked says UNMEASURED.
 *
 * Every failure is UNMEASURED carrying its own `why`, never `NO_PR`. A
 * missing token, a 403 and a rate limit are all states where nobody looked,
 * and "this branch has no open PR" is a claim about the tracker. The refusal
 * stands either way: whether a reason was declared is a fact about the
 * command line, and the target is the helpful half of the sentence rather
 * than the deciding one.
 */
export async function openPrForBranch(
  projectRoot: string,
  repo: string | null = null,
): Promise<CommentTarget> {
  const branch = branchOf(projectRoot);
  if (branch === null || branch === "HEAD") {
    return {
      reading: "UNMEASURED",
      why:
        branch === "HEAD"
          ? `\`${projectRoot}\` is a detached checkout, so there is no branch to find a PR for`
          : `the branch of \`${projectRoot}\` could not be read`,
    };
  }
  const slug = corpusSlug(projectRoot, repo);
  if (slug === null) {
    return { reading: "UNMEASURED", why: "no repository slug resolved, so no PR list was asked for" };
  }
  try {
    const { owner } = parseOwnerRepo(slug);
    const prs = await withTimeout(
      listPRs(createGitHubClient(), slug, { state: "open", head: `${owner}:${branch}`, per_page: 5 }),
      OPEN_ISSUE_TIMEOUT_MS,
    );
    const number = prs.find(p => typeof p?.number === "number")?.number;
    return number === undefined ? { reading: "NO_PR", branch } : { reading: "PR", number, branch };
  } catch {
    return {
      reading: "UNMEASURED",
      why: `the open PRs of ${slug} could not be read, so the PR for \`${branch}\` was never found`,
    };
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

/**
 * Every row on the ledger, or `null` when the file is there and unreadable.
 *
 * **An absent ledger is an empty one; a corrupt ledger is neither.** That is
 * `.claude/rules/config-access.md`'s distinction, applied to the one file
 * this gate now reads as well as writes: a machine that has never adjudicated
 * a filing genuinely has no prior refusals, and saying UNMEASURED there would
 * put a note on the first `gh issue create` anybody ever runs.
 *
 * A single malformed line is skipped rather than refusing the file. The
 * ledger is append-only from several processes and a torn final write is the
 * expected failure, not a corrupted store — but a file that cannot be opened
 * at all is `null`, because that one cannot be told apart from a lookup
 * nobody performed.
 */
export function readLedgerRows(path: string = ledgerPath()): FilingLedgerRow[] | null {
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  const rows: FilingLedgerRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line) as FilingLedgerRow);
    } catch {
      // A torn append, not a corrupt store.
    }
  }
  return rows;
}

/**
 * The most recent refusal of a filing under this exact title, if any.
 *
 * Exported so the gate has ONE binding for "has this been refused before?"
 * and a test can read the same answer the gate acts on — two spellings of
 * this question would be the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 *
 * **Exact title, and no time bound.** A title is what the issue's own
 * evidence shows surviving a re-draft, and loosening it to a similarity
 * would re-introduce exactly the thing #1536 is about: a judgement over
 * prose, defeated by changing the prose. A window would be a second
 * threshold with no corpus behind it, and the cost of attributing an
 * override to a refusal from last month is a row that says so — visible,
 * and nothing is withheld by it.
 *
 * ## THREE ROWS THAT ARE NOT A REFUSAL, AND LOOK LIKE ONE
 *
 * The first spelling of this was `refusal !== null && !emitted`, and
 * `FG-48 CONTROL` turned it red inside the hour — a filing that had nothing
 * to do with #1536 started carrying `refiledNote` because an earlier row on
 * the shared ledger had the same title.
 *
 * - **`UNMEASURED` is not a refusal.** It is this file's whole doctrine
 *   that a filing nobody could adjudicate and a filing somebody refused are
 *   different states, and the first predicate collapsed them.
 * - **A clean clause blocked by a sibling** carries `withheldBy: BLOCKED`
 *   and `refusal: null` — withheld by the command, never adjudicated down.
 * - **A refusal that was overridden** reached the tracker. The next filing
 *   of that title is a second finding, not a re-draft of a waived one.
 *
 * So the test is that the row's OWN adjudication withheld it:
 * `withheldBy === refusal` is what distinguishes a refusal the row earned
 * from one it inherited, and it is the field `markBlockedCommand` moves.
 */
export function priorRefusalFor(
  title: string,
  rows: readonly FilingLedgerRow[],
): FilingLedgerRow | null {
  // Bounded on the way in, because it was bounded on the way out: a title
  // over `MAX_LEDGER_TITLE` is stored truncated, so comparing the raw one
  // would never match its own prior row and the #1536 override would stop
  // surviving a re-draft for exactly the longest titles.
  const wanted = ledgerTitle(title);
  let best: FilingLedgerRow | null = null;
  for (const row of rows) {
    if (row.title !== wanted) continue;
    if (row.refusal === null || row.refusal === "UNMEASURED") continue;
    if (row.emitted || row.overridden) continue;
    if (row.withheldBy !== row.refusal) continue;
    if (best === null || row.at >= best.at) best = row;
  }
  return best;
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
    /** The adjudications already on the ledger. `null` means unreadable. */
    readLedger?: () => FilingLedgerRow[] | null;
    /**
     * Append one row, reporting whether it landed.
     *
     * The gate writes exactly one kind of row itself — the intent that
     * reserves the allowance (`reserveAllowance`) — and the hook still writes
     * every outcome row afterwards. Injectable so a test can drive the race
     * without a filesystem, and so the two racers in `FG-165` can share one.
     */
    appendLedger?: (row: FilingLedgerRow) => boolean;
    /**
     * Where a comment should go instead, when a filing is refused for having
     * declared no reason (#1595). Injectable for the same reason
     * `readExisting` is: the live one talks to GitHub.
     */
    readTarget?: (projectRoot: string, repo: string | null) => Promise<CommentTarget>;
    /**
     * The checkout's `origin`, for `runIdFor`. Injectable only so a FAILED
     * read can be driven — see `runIdFor`, where the default lives.
     */
    readRemote?: (worktreePath: string) => RemoteReading;
    /**
     * The merged plans, for the cap's second route (`lib/filing-plan.ts`).
     *
     * Injectable for the same reason `readExisting` is — the live one shells
     * out to git. The DEFAULT is the only one that ships, and it reads
     * `origin/main`: a caller that passed the working tree here would hand
     * every agent the power to write its own exemption.
     */
    readPlan?: PlanSource;
  },
): Promise<FilingGateReading> {
  const attempts = filingAttempts(cmd);
  if (attempts.length === 0) return NO_FILING;

  const at = options.now ?? new Date().toISOString();
  const read = options.readExisting ?? openFindings;
  const planSource = options.readPlan ?? gitSource(options.projectRoot);
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

  // The comment target, cached per tracker exactly as the corpus is, and
  // LAZY in a way the corpus is not: the thunk is only called on the
  // COMMENT_INSTEAD arm, so a command every clause of which is allowed pays
  // nothing for it. A hook has no retry and no patience to spend on a read
  // that only composes a sentence.
  const readTarget = options.readTarget ?? openPrForBranch;
  const targets = new Map<string, Promise<CommentTarget>>();
  const targetFor = (repo: string | null) => {
    const key = repo ?? "";
    const hit = targets.get(key);
    if (hit !== undefined) return hit;
    const started = readTarget(options.projectRoot, repo);
    targets.set(key, started);
    return started;
  };

  const rows: FilingLedgerRow[] = [];
  const refusals: string[] = [];
  const notes: string[] = [];

  // One batch per command, so every row of one adjudication shares it and the
  // clause index separates them — `CandidateRecord.key`'s scheme exactly.
  const batch = filingBatch(at);
  if (batch === null) notes.push(unkeyedLedgerNote());

  // Read ONCE per command, before any clause, for the same reason the
  // corpus is: two clauses adjudicated against two snapshots of the same
  // store are two readings nobody can compare. `null` is a failed read and
  // is said out loud rather than standing in for "no prior refusal".
  const priorRows = (options.readLedger ?? (() => readLedgerRows()))();
  if (priorRows === null) notes.push(unreadableLedgerNote());

  // ── One issue per finding CLASS per run, never per instance (#1595) ──
  //
  // **Decided here and not in `adjudicateFiling`, because the unit is the
  // COMMAND.** `markBlockedCommand` is the same shape for the same reason: a
  // property of several clauses together cannot be read by a function that
  // sees one. *"Flag the class of bug, so the author fixes every instance,
  // not one line"* is CRC-N3, and this is its hook-side half — two clauses
  // sharing a class are one item saying *every instance*.
  //
  // Every sibling carries its CLAUSE INDEX as its id. `UNFILED_ID` for all of
  // them would make the comparison a no-op in exactly the configuration it is
  // written for, which `lib/finding-arbiter.ts` records happening once
  // already: *"treating the label as an identity is what made the in-batch
  // dedupe a no-op"*.
  //
  // Only clauses that CLEARED become siblings. The refusal says "fold it into
  // clause N", and that is only an instruction worth following if clause N is
  // itself going to be filed.
  const siblings: Finding[] = [];
  const siblingTitles = new Map<string, string>();

  // ── The cap (#1595, scope item 4) ──
  //
  // **The gate. Everything else in this file is a judgement and this is a
  // count.** Resolved once per command, because the run is a property of
  // the command's directory and a `rev-parse` per clause would be three
  // spellings of one answer.
  //
  // `spent` carries the in-command emissions as well as the ledger's, so a
  // three-clause command cannot file three issues under a cap of one by
  // adjudicating every clause against a snapshot taken before any of them
  // landed. That is the same shape as the sibling list above.
  //
  // **An UNREADABLE ledger REFUSES, and this is the one place in the file
  // that fails closed.** It allowed at first, on the standing policy that a
  // measurement apparatus must not block the thing it measures — which is
  // right for `recordAdjudication` returning `false` rather than throwing,
  // and wrong here. The ledger is not the apparatus for the cap; it is the
  // cap's STATE. "Could not read it" means the allowance is unknown, and
  // allowing on an unknown allowance is not a loud note, it is the gate
  // removed by anything that can make one file unreadable.
  //
  // The two readings this turns on already exist and are already separated:
  // `readLedgerRows` returns `[]` for a genuinely absent file and `null`
  // for present-and-unreadable. An empty population is an answer — a
  // machine that has never filed has spent nothing — and it allows. `null`
  // is not an answer, and it refuses as `UNMEASURED_CAP`, which
  // `waivableRefusal` excludes so the label cannot clear it either.
  // **A run that could not be READ is a third state and rides the same
  // conversion as an unreadable ledger.** `runIdFor` returns `null` only for
  // a remote read that failed — a git timeout, git missing — never for a
  // directory that simply has no origin, which is an answer and buckets.
  // Without the split the timeout silently re-keys a real checkout into the
  // shared allowance, which is the denominator changing underneath the count.
  const reading = runIdFor(options.projectRoot, options.readRemote);
  const run = reading.run ?? NON_CHECKOUT_RUN;
  const nowMs = Date.parse(at);
  const uncountable = priorRows === null || reading.run === null;
  let spent = uncountable ? 0 : intentsInRun(priorRows ?? [], run, nowMs);
  // One binding for the UNMEASURED_CAP sentence, because there are now two
  // ways to be uncountable and they name different things to repair: a
  // ledger nobody can read, and a run nobody could resolve.
  const uncountableReason = (target: CommentTarget) =>
    reading.run === null
      ? unreadableRunReason(reading.why ?? "the remote could not be read", target)
      : uncountableCapReason(run, target);
  // The per-clause verdicts, kept so the race stage below can compose the
  // same refusal message the loop composes. One array, written once per
  // clause beside `rows`, so `rows[i]` and `verdicts[i]` are one clause.
  const verdicts: FilingAdjudication[] = [];

  for (const [index, attempt] of attempts.entries()) {
    const read1 = await adjudicateFiling(
      attempt,
      () => readFor(attempt.repo),
      readBodyFile,
      () => targetFor(attempt.repo),
    );
    // The in-run class check, applied to anything the per-filing stages did
    // not already refuse. It converts an UNMEASURED as well as an ALLOW, and
    // that is deliberate: this reading needs no tracker, so an unreadable
    // tracker is no reason to let one command file a class twice. The note
    // below is keyed off `read1` rather than `verdict` so the unreadable
    // tracker is still said out loud when that happens.
    const { finding } = filingFinding(attempt);
    // **The cap is applied before anything READS THE TRACKER'S ANSWER, and
    // it converts an UNMEASURED.** Every other
    // UNMEASURED arm in this file allows, which is right for a reading about
    // the environment — but if the cap sat behind them, a session with no
    // `GITHUB_TOKEN` would have no cap at all, and this file's own header
    // says a developer's credential usually is not in the environment. A
    // gate that switches itself off in the configuration most agents run in
    // is not a gate. The cap needs no tracker, so nothing about the tracker
    // may excuse it.
    //
    // **Against the OTHER refusal in this block, the class check runs first,
    // and that ordering is forced.** The two are not in tension with the
    // paragraph above: the tracker is what the cap must not wait for, and
    // the class check reads no tracker either.
    // At `FILINGS_PER_RUN = 1` a run's second clause is over the cap
    // whatever it says, so a cap placed first makes `SAME_CLASS_IN_RUN`
    // unreachable — a refusal nothing can ever emit, which is a check that
    // cannot fail. Measured when the cap landed with the cap first: FG-133
    // and FG-134 both went red and the class refusal was dead code.
    //
    // Nothing is weakened by the order, because BOTH refuse. What changes is
    // which sentence the agent reads, and for two clauses of one class
    // *"fold this into clause 1 and say every instance"* is strictly more
    // actionable than *"post a comment"* — the same argument this file makes
    // for reporting DUPLICATE ahead of NO_CLAIM.
    const sameClass =
      read1.outcome === "REFUSE" ? [] : duplicateCollisions(finding, siblings);
    const read2: FilingAdjudication =
      sameClass.length === 0
        ? read1
        : {
            ...read1,
            outcome: "REFUSE",
            refusal: "SAME_CLASS_IN_RUN",
            collidingKeys: sameClass[0].keys,
            // NOT `duplicateOf`: that field holds ISSUE numbers a reader can
            // open, and a clause index is not one. The reason names the
            // clause instead.
            reason:
              `clause ${Number(sameClass[0].id) + 1} of this same command already files this ` +
              `class — "${siblingTitles.get(sameClass[0].id)}" — sharing ` +
              `${sameClass[0].keys.length} key(s): ${sameClass[0].keys.slice(0, MAX_QUOTED_KEYS).join(", ")}. ` +
              "One issue per finding class per run, never per instance: fold this instance into " +
              "that filing and say *every instance* in it, rather than filing the second one.",
          };
    const labelled = attempt.labels.includes(FILING_OVERRIDE_LABEL);
    const prior = priorRows === null ? null : priorRefusalFor(attempt.title, priorRows);
    // **An override waives A REFUSAL, and the refusal need not be this
    // adjudication's** (#1536). `verdict.outcome === "REFUSE" && labelled`
    // is blind to the re-drafted body that stopped colliding — see
    // `FilingLedgerRow.refiledAfter` for the two live rows 37 seconds apart
    // that measured it. Nothing here is stricter: `prior` cannot cause a
    // refusal, only name one that already happened.
    // **`OVER_CAP` is not waivable, and that is the whole point of it**
    // (#1595). The override waives a claim about a FINDING — this is a
    // duplicate, this names no claim, this should have been a comment — and
    // every one of those is an argument the filer can answer. The cap makes
    // no claim about the finding at all, so there is nothing to answer, and
    // a label that waived it would hand back exactly the per-filing
    // judgement the cap exists to replace: a valid reason defeating the cap
    // IS the bar that let three of three filings through on 2026-10-24.
    //
    // ONE binding, applied to two inputs. The cap below has to know whether
    // the label would carry this clause to the tracker BEFORE it decides,
    // and the row has to record whether it did AFTER. Written as two
    // expressions those are two deciders over one question, which is how the
    // bypass this closes got in.
    //
    // The `prior` arm reads `waivableRefusal` too, and for the same reason
    // the current arm does. Without it a row re-drafted after an `OVER_CAP`
    // or `UNMEASURED_CAP` refusal records `overridden: true` — the label
    // waiving, in the ledger's own account, a refusal no label can waive.
    // Nothing reaches the tracker that should not, because the clause is
    // being ALLOWED on its merits by then; what breaks is the measurement,
    // and the count of overrides against the cap is the number this whole
    // change exists to make readable. Raised by the AI review at round 6.
    // **`v.exemption !== null` is the sibling-refusal fix, and it is not a
    // new policy** (#1595, 2026-10-25). The adjudicator returns the FIRST
    // refusal it reaches, so waiving that one emits a filing whose later
    // refusals were never computed. `COMMENT_INSTEAD` is issued last, after
    // `NO_CLAIM` — deliberately, and the reason is defended at the stage
    // itself — so a filing that is undeclared AND claimless is refused
    // `NO_CLAIM`, the label waives that, and the unwaivable member is never
    // consulted. The route this change closed was "delete the declaration";
    // the route that replaced it was "delete the declaration AND the claim".
    // A gate that gets cheaper to beat the worse the filing gets is not a
    // gate, and there is no reason to believe `NO_CLAIM` is the only sibling
    // that can win the race.
    //
    // Keying unwaivability on the refusal ISSUED was the actual defect:
    // absence of a declaration is a property of the ATTEMPT, and which
    // refusal fired is a property of the precedence. Reading `exemption` —
    // which `adjudicateFiling` already computed and carries on EVERY
    // adjudication, so this is not a second decider — asks the attempt
    // directly and closes every sibling at once.
    //
    // **Not by making `COMMENT_INSTEAD` win the precedence race.** That
    // deletes `NO_CLAIM` for the common filing as a side effect of adding
    // one gate, which is exactly what the comment at that stage warns
    // against. The ordering is untouched; `FG-178` asserts the refusal is
    // still `NO_CLAIM`, so a later change that reorders goes red and says so.
    //
    // The invariant this restores, stated so it can be tested as one: **no
    // filing without a declaration reaches the tracker, label or no label.**
    // Without the label that was already true — undeclared is
    // `COMMENT_INSTEAD` and `COMMENT_INSTEAD` is not emitted. The label was
    // the only hole.
    const overrideOf = (v: FilingAdjudication) =>
      labelled &&
      v.exemption !== null &&
      waivableRefusal(v.refusal) &&
      (v.outcome === "REFUSE" || (prior !== null && waivableRefusal(prior.refusal)));

    // **The cap applies to anything that would REACH THE TRACKER, not to
    // anything that happens to be clean.** Gating it on `read1` being an
    // ALLOW — which is how it was first written, and what the AI review of
    // PR #1597 found at round 4 — makes `--label arbiter-override` a cap
    // bypass: a clause refused for any WAIVABLE reason skips the cap
    // entirely, the label then waives that refusal, and the filing lands
    // with the run already over its allowance. It is not a corner either.
    // The cheapest way to reach it was to DELETE the declaration: an
    // undeclared filing is `COMMENT_INSTEAD`, which was waivable, so
    // dropping one line and adding the label beat the gate. A cap that any
    // agent can step around by making its filing *worse* is not a cap.
    //
    // `COMMENT_INSTEAD` became unwaivable on 2026-10-25, so that specific
    // route is closed at its source as well as here. **This ordering stays**
    // — it is not the fix for one spelling of the bypass. Every remaining
    // waivable refusal reaches the tracker under the label, and the cap has
    // to be applied to all of them or it is applied to none.
    //
    // `SAME_CLASS_IN_RUN` keeps its precedence, because a clause refused for
    // it is not emitted and `wouldEmit` is therefore false — the conversion
    // only touches clauses that were going to reach the tracker.
    //
    // `uncountable` rides the same conversion rather than a second one. The
    // question *"may this clause reach the tracker?"* has one answer and one
    // place that applies it; "the allowance is spent" and "the allowance
    // cannot be read" are two reasons for the same No, and splitting them
    // across two branches is how the first bypass got in.
    const wouldEmit = read2.outcome !== "REFUSE" || overrideOf(read2);
    // **The cap's second route: a filing a MERGED plan names** (`lib/filing-plan.ts`).
    //
    // The number above was calibrated against one population — a review
    // finding filed mid-change. Decomposing a criterion into issues is the
    // other one, and it produces several issues in one run BY DESIGN, so a
    // cap of 1 does not slow it down, it forbids it.
    //
    // This is not a label and not a bar. The filer cannot argue into it and
    // cannot nominate its own plan: the title has to appear verbatim in a
    // file on `origin/main`, which means somebody merged it. That merged
    // plan is the human reading the cap stands in for.
    //
    // **It exempts the SPENT arm only, never `uncountable`.** Those are two
    // reasons for one No elsewhere in this function, and here they part: a
    // spent allowance is the cap doing its job on the wrong population, and
    // an unreadable ledger means this exemption cannot be RECORDED. An
    // exemption nobody can audit is the thing the ledger exists to prevent,
    // so it refuses with the rest.
    //
    // It exempts the cap and nothing else. A planned filing that duplicates
    // an open issue is still `DUPLICATE`, and one that declares no reason is
    // still `COMMENT_INSTEAD`; `read2` is untouched above.
    const planned = plannedFiling(attempt.title, planSource);
    const capped = uncountable || (spent >= FILINGS_PER_RUN && !planned.planned);
    const verdict: FilingAdjudication =
      wouldEmit && capped
        ? {
            ...read2,
            outcome: "REFUSE",
            refusal: uncountable ? "UNMEASURED_CAP" : "OVER_CAP",
            reason: uncountable
              ? uncountableReason(await targetFor(attempt.repo))
              : overCapReason(run, spent, await targetFor(attempt.repo)),
          }
        : read2;
    const overridden = overrideOf(verdict);
    // **This clause's own reading, and nothing about the command.** The
    // command-level decision is not available yet — it needs every clause —
    // so `emitted` here is provisional and `markBlockedCommand` below applies
    // the second half. #1344 is what happens when it is not applied: a clause
    // that cleared on its own merits inside a command the hook went on to
    // refuse was recorded as having reached the tracker.
    const cleared = verdict.outcome !== "REFUSE" || overridden;

    verdicts.push(verdict);
    rows.push({
      at,
      key: batch === null ? null : `${batch}/${index}`,
      id: UNFILED_ID,
      title: ledgerTitle(attempt.title),
      symptomHash: verdict.symptomHash,
      category: verdict.category,
      severity: null,
      // The adjudication's ROUTING decision, which is a different question
      // from whether anything was filed and stays answered on a blocked
      // command. `arbitrateBatch` does the same: a candidate withheld
      // `BATCH_UNMEASURED` keeps the disposition its verdict gave it.
      disposition: cleared ? "ISSUE" : "DROP",
      refusal: verdict.refusal,
      emitted: cleared,
      withheldBy: cleared ? null : verdict.refusal,
      jury: null,
      // This adjudication's collisions when it had any; otherwise the ones
      // the refusal being waived named, so the row NAMES the refusal rather
      // than leaving a reader to infer it from a timestamp. #1536 asks for
      // exactly this and points at the field.
      duplicateOf: verdict.duplicateOf.length > 0 ? verdict.duplicateOf : (prior?.duplicateOf ?? []),
      overridden,
      refiledAfter: prior?.at ?? null,
      exemption: verdict.exemption,
      plannedBy: planned.planned ? `${planned.plan}:${planned.line}` : null,
      run,
    });

    // A cleared clause is what a later clause of this command is compared
    // against, and it is what the cap counts. Both are applied AFTER the row,
    // so the clause never collides with itself and never caps itself out — a
    // self-collision would refuse every single-clause filing in the tree and
    // read exactly like a gate that works.
    //
    // `spent` moves on `cleared` and not on `emitted`, and they differ for
    // one row shape: a clean clause inside a command the hook goes on to
    // BLOCK. `markBlockedCommand` clears `emitted` on those below, so the
    // ledger never counts them and a re-run of that command gets its
    // allowance back. Reading `cleared` here is still right, because within
    // this command the clause is provisionally filing and a sibling must not
    // be allowed to file under the same allowance.
    // **A planned clause does not spend the allowance — here either.**
    //
    // This is the THIRD consumer of one fact, and the AI review of this
    // change found it after the first two were already written: a planned
    // clause that cleared still incremented `spent`, so in a multi-clause
    // command the next clause read the allowance as gone, was refused
    // `OVER_CAP`, and the refusal blocked the whole command — including the
    // exempt clause that had just cleared. The exemption would have made a
    // two-clause planned filing WORSE than a one-clause one.
    //
    // Named as one property rather than three guards, because three sites
    // answering one question is how a behavioural suite comes to catch only
    // the last of them to regress (`.claude/rules/checks-must-be-able-to-fail.md`,
    // the fourth shape): **a planned filing never touches the allowance — not
    // this counter, not the pre-read, not the reservation queue.** All three
    // read the one `planned` reading — this site and the pre-read read the
    // local directly, the reservation stage reads the `plannedBy` it was
    // written onto, because it runs after this loop. `FG-185` exercises all
    // three in one command.
    //
    // `siblings` still gets the clause. That is the DEDUPE corpus, not the
    // allowance: two planned clauses filing the same finding twice is still a
    // duplicate, and the plan route exempts the cap alone.
    if (cleared) {
      if (!planned.planned) spent += 1;
      siblings.push({ ...finding, id: String(index) });
      siblingTitles.set(String(index), attempt.title);
    }

    if (verdict.outcome === "REFUSE" && !overridden) refusals.push(refusalMessage(verdict));
    // `read1`, never `verdict`: a clause whose tracker could not be read AND
    // whose class a sibling already files is both facts at once, and the
    // conversion above keeps only the second. An UNMEASURED nobody sees is
    // the silent pass this file's header exists to prevent.
    if (read1.outcome === "UNMEASURED") notes.push(unmeasuredNote(read1));
    if (overridden) notes.push(overrideNote(verdict, prior));
    // A re-draft that cleared the gate on its own is not refused and not
    // blocked — the gate does not get stricter here (#1536). It is SAID, so
    // the honest filer who labels the override and the filer who reworded
    // until it passed stop producing the same ledger.
    else if (prior !== null && verdict.outcome !== "REFUSE") notes.push(refiledNote(attempt.title, prior));
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
  //
  // The rows above are written clause by clause, so they cannot yet know
  // this. `markBlockedCommand` is where the command-level decision reaches
  // them, and `clean` is read BEFORE it so the refusal still enumerates the
  // clauses an agent should re-run — see that function's header for why that
  // ordering is the whole of #1344's wrong fix.
  // ── The cap again, this time against the clauses that will actually file
  //    (#1595) ────────────────────────────────────────────────────────────
  //
  // Everything above decided from a snapshot READ BEFORE the decision, which
  // is the race: `filingGate` calls the tracker in between, so the window is
  // hundreds of milliseconds and two parallel hooks both counted zero.
  // `reserveAllowance` closes it by appending first and reading the position
  // back — see its header for why there is no lock.
  //
  // **Only when nothing else refuses, and that ordering is load-bearing.** A
  // blocked command files nothing, so reserving for it would spend the run's
  // allowance on a command that was never going to reach the tracker, and the
  // agent's corrected re-run would then be `OVER_CAP`. It is the same rule
  // `markBlockedCommand` applies to `emitted`, applied one step earlier
  // because a reservation cannot be taken back.
  //
  // **Everything reserved is released if the command ends up filing
  // nothing**, and the guard above is not enough for that. `refusals.length
  // === 0` tests the refusals that existed BEFORE this stage; the stage
  // generates its own, and at `FILINGS_PER_RUN = 1` every command with two
  // emitting clauses generates one — clause 0 wins, clause 1 loses, the
  // refusal blocks the command, and clause 0's reservation sits on the
  // ledger holding the run's only allowance for a command that filed
  // nothing. That is the ordinary multi-clause path, not an edge case, and
  // the comment above was right about the invariant while the code guarded
  // it against the wrong population. Found by the security review of
  // `822d5d7d`.
  //
  // So: stop at the first clause that does not win, and give back every
  // reservation this command took. `releaseAllowance` appends rather than
  // rewriting, because the order appends give is what the whole fix rests
  // on.
  if (refusals.length === 0) {
    const append = options.appendLedger ?? ((r: FilingLedgerRow) => recordAdjudication(r));
    const readAgain = options.readLedger ?? (() => readLedgerRows());
    const reserved: FilingLedgerRow[] = [];
    for (const [index, row] of rows.entries()) {
      if (!row.emitted) continue;
      // **A planned filing takes no position in the queue, because it is not
      // in the cap's accounting at all.**
      //
      // This stage re-decides the cap — deliberately, so that a filing in
      // flight in another process is visible — and `FG-153` records that it
      // refuses an over-cap clause *"whatever the pre-read decided"*. That
      // makes it the second consumer of one question, and the exemption has
      // to reach both or the earlier one is dead code: without this line
      // `FG-180` reads `OVER_CAP` with the pre-read having allowed it, which
      // is the fourth shape in `.claude/rules/checks-must-be-able-to-fail.md`
      // pointed at my own change.
      //
      // It is not a second DECIDER. `plannedBy` was computed once, above, and
      // written onto the row; this reads that value rather than asking
      // `plannedFiling` again. A second call would be two deciders over one
      // input, and a mutation of either would leave the other holding the
      // case up.
      //
      // Reserving one and immediately releasing it would also work and is
      // worse: it writes two rows per planned filing into the ledger the cap
      // is measured from, so `intentsInRun` would count planned work against
      // the population the number was calibrated on.
      if (row.plannedBy != null) continue;
      const reading = reserveAllowance(row, run, { now: nowMs, append, readLedger: readAgain });
      if (reading.outcome === "WON") {
        reserved.push(reading.intent);
        continue;
      }
      const refusal = reading.outcome === "LOST" ? "OVER_CAP" : "UNMEASURED_CAP";
      const target = await targetFor(attempts[index].repo);
      const reason =
        reading.outcome === "LOST"
          ? overCapReason(run, reading.already, target)
          : reading.outcome === "UNRESERVED"
            ? unreservedCapReason(run, target)
            : uncountableReason(target);
      if (reading.outcome === "UNRESERVED") notes.push(unreservedAllowanceNote());
      // The intent this clause took is released with the rest below: it won
      // no position, and a losing reservation that is never given back is
      // the same stranded allowance by a rarer route.
      if (reading.outcome !== "UNRESERVED") reserved.push(reading.intent);
      // **`waivableRefusal` is READ here, not restated.** Writing
      // `overridden: false` with a comment saying the predicate agrees makes
      // this a third place that decides whether a label waives something,
      // and a mutation of the predicate would leave this one holding the
      // case up — the fourth shape in
      // `.claude/rules/checks-must-be-able-to-fail.md`. It evaluates false
      // for both of these refusals; the point is that it evaluates.
      rows[index] = {
        ...row,
        emitted: false,
        disposition: "DROP",
        refusal,
        withheldBy: refusal,
        overridden: row.overridden && waivableRefusal(refusal),
      };
      refusals.push(refusalMessage({ ...verdicts[index], outcome: "REFUSE", refusal, reason }));
      // Nothing after this clause can file — the refusal blocks the command
      // — so reserving for it would strand another allowance.
      break;
    }
    if (refusals.length > 0) for (const intent of reserved) releaseAllowance(intent, append);
  }

  const blocking = refusals.length > 0;
  const clean = rows.filter(r => r.emitted);
  if (blocking && clean.length > 0) refusals.push(cleanClauseNote(clean, rows.length));
  const recorded = blocking ? markBlockedCommand(rows) : rows;

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
    rows: recorded,
  };
}

/**
 * Why a clause of a BLOCKED command did not reach the tracker when nothing
 * was wrong with the clause (#1344).
 *
 * One exported constant, so there is one thing to mutate and one declaring
 * position for the string the ledger carries.
 */
export const COMMAND_BLOCKED = "COMMAND_BLOCKED" satisfies WithheldBy;

/**
 * The command-level decision, applied to rows written clause by clause.
 *
 * ## What it fixes
 *
 * `filingGate` adjudicates one clause at a time and writes a row for each,
 * and the decision that matters — block the command, or let it run — is not
 * knowable until every clause has been read. So for the whole of #1338's
 * life, a command the hook went on to REFUSE left rows reading
 * `emitted: true` for every clause that had been clean on its own merits.
 * Nothing was filed: a hook's one lever is the entire Bash command. The
 * ledger overcounted filings by one row per clean clause of every blocked
 * mixed command, and an overcount there is not decoration — this ledger is
 * the record the arbiter's confidence is read off, and the direction it was
 * wrong in was toward suppressing real findings as duplicates.
 *
 * ## Three states, and the one that is new
 *
 * | state | `emitted` | `disposition` | `withheldBy` |
 * |---|---|---|---|
 * | reached the tracker | `true` | `ISSUE` | `null` |
 * | refused on its own merits | `false` | `DROP` | its own `ArbiterRefusal` |
 * | clean, and never attempted | `false` | `ISSUE` | `COMMAND_BLOCKED` |
 *
 * The third is the one this adds, and it must not be either of the others.
 * Marking it `DROP` with the sibling's refusal would say this clause was
 * wrong, which is the only thing the ledger knows it was not; leaving it
 * `emitted` says it was filed, which is #1344. `disposition` is deliberately
 * untouched — it is the adjudication's ROUTING decision, and
 * `arbitrateBatch` keeps it the same way for a candidate it withholds as
 * `BATCH_UNMEASURED`.
 *
 * The invariant `withheldBy === null` exactly when `emitted` — the one
 * `test/finding-arbiter.test.ts` holds over `CandidateRecord` — is preserved,
 * because the two row shapes exist to be read as one population.
 *
 * ## Call it AFTER `cleanClauseNote`, never before
 *
 * The cheapest wrong fix for #1344 is to flip `emitted` where the rows are
 * written. The count then comes out right and the refusal goes quiet: the
 * note that names the clean clauses is built from `rows.filter(r =>
 * r.emitted)`, so it would find none and tell the agent "0 of 2" with
 * nothing to re-run. That note is the half that makes blocking a mixed
 * command affordable at all (#1338), so the ordering is load-bearing and
 * `FG-94` is the case that holds it.
 *
 * ## What this does NOT claim
 *
 * `emitted: true` means the hook ALLOWED the command. It is a prediction,
 * not a receipt: this gate runs `PreToolUse`, and a `gh` that then fails on
 * auth, the network or a rate limit files nothing. That outcome is
 * **UNMEASURED by this ledger** and no value here stands in for it — a
 * fourth state inferred from something the gate cannot see would be exactly
 * the plausible-looking reading `.claude/rules/config-access.md` forbids.
 */
export function markBlockedCommand(rows: readonly FilingLedgerRow[]): FilingLedgerRow[] {
  return rows.map(row =>
    row.emitted ? { ...row, emitted: false, withheldBy: COMMAND_BLOCKED } : { ...row },
  );
}

/**
 * The refusal an agent reads.
 *
 * It names the category, the signal that matched, and the override — because
 * a refusal nobody can act on becomes a refusal everybody routes around, and
 * the three VERIFY-lock bypasses in `lib/issue-create-override.ts` are what
 * that looks like when it happens.
 *
 * **The override stanza is printed only when the label would actually waive
 * this refusal**, read from `waivableRefusal` rather than decided here. For
 * one review round it was unconditional, so an `OVER_CAP` refusal said *"no
 * label waives it"* in `overCapReason` and then closed by telling the agent
 * to re-run with the label — in the same message, four lines apart. The cap
 * holds either way, because `filingGate` reads the same predicate; what the
 * contradiction costs is the next agent, who is taught by the gate's own
 * output to reach for the override on the gate it cannot open.
 *
 * ## The two stanzas treat the label's NAME differently, on purpose
 *
 * **Unwaivable: the label is named, to deny it.** An agent that has read
 * about the override and finds silence tries it anyway, spends a round, and
 * silence is also indistinguishable from a message written before the
 * refusal became unwaivable. The sentence comes from
 * `UNWAIVABLE_REFUSALS`, so the reason given is this refusal's own.
 *
 * **Waivable: the label is NOT named, and no step is offered.** The old text
 * was a complete recipe with its own permission attached — *"If this one
 * genuinely is the exception, re-run with --label …"* — and *this one
 * genuinely is the exception* is a judgement every filing makes about
 * itself, so the condition admits everything. A refusal that supplies both
 * the verdict and the way around it is read as the way around it. The fact
 * that a waiver exists is still stated, with its cost, because an agent
 * acting on a real exception needs to know the route is recorded and
 * counted; what it no longer does is spell the token for an agent that did
 * not already have it. Naming-to-deny and naming-to-offer are different
 * acts, and only the first is worth the words (#1595, 2026-10-25).
 */
export function refusalMessage(v: FilingAdjudication): string {
  // **The BRANCH is `waivableRefusal`, the WORDS are the map.** Reading the
  // map for both would make this a second decider over "does the label
  // waive this" — the drift FG-156 exists to catch, and the mutation that
  // forces the predicate true would stop moving this message.
  const unwaivable = waivableRefusal(v.refusal)
    ? undefined
    : v.refusal === null
      ? undefined
      : UNWAIVABLE_REFUSALS[v.refusal];
  const tail = unwaivable
    ? [
        `--label ${FILING_OVERRIDE_LABEL} does NOT waive this one. ${unwaivable}`,
        `The attempt is recorded in ${ledgerPath()} either way.`,
      ]
    : [
        "A label waives this refusal. It is deliberately not spelled here and not offered",
        "as a step: every filing believes it is the exception, so a refusal that hands over",
        "the way around itself is read as the way around itself. If you reach for it, it is",
        `recorded in ${ledgerPath()} against this run and counted later.`,
      ];
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
    ...tail,
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

/**
 * The cap could not take a position in the queue, so it did not hold.
 *
 * Said out loud for the reason `unkeyedLedgerNote` is said out loud: the
 * filing proceeds, and what proceeds is a filing nothing counted. A silent
 * version of this is a cap that switches itself off whenever one file cannot
 * be written, which is the shape `.claude/rules/config-access.md` calls
 * Silent Default Substitution.
 *
 * It allows rather than refusing because this is the WRITER failing, not the
 * state being unknown — `reserveAllowance` has the two apart, and the other
 * one refuses.
 */
export function unreservedAllowanceNote(): string {
  return (
    "[FindingArbiter] UNMEASURED allowance — this filing's intent row could NOT be appended to " +
    `${ledgerPath()}, so it took no position in this run's queue and the per-run cap of ` +
    `${FILINGS_PER_RUN} could not hold for it. The filing is REFUSED, not allowed: see ` +
    "`unreservedCapReason`. This note names the writer so an operator repairs the file rather " +
    "than the filing."
  );
}

/**
 * How long a title may be on a ledger row. **An atomicity bound, not a
 * cosmetic one.**
 *
 * The whole race fix rests on appends to one file being serialised, and that
 * holds for a write small enough to reach the filesystem as one. A row large
 * enough to be split can tear, and a torn row is a reservation that took no
 * position while its writer believes it did — the one failure this design
 * has no reading for. `readLedgerRows` already treats a torn final line as
 * expected and skips it, which is exactly the silent slot loss.
 *
 * The title is the one field on the row a FILER sets and nothing else
 * bounds: `--title` takes whatever the command line carries. So it is bounded
 * here, and `ledgerTitle` is the single binding — the lookup in
 * `priorRefusalFor` joins on this field, so a title bounded when written and
 * not when read would stop matching its own prior row.
 *
 * 200 is comfortably inside any plausible single-write limit with the rest of
 * the row, and about twice the longest title on the live ledger. Do not raise
 * it without saying what makes the larger write atomic.
 */
export const MAX_LEDGER_TITLE = 200;

/** A title bounded for the ledger. One binding — see `MAX_LEDGER_TITLE`. */
export function ledgerTitle(title: string): string {
  return title.length <= MAX_LEDGER_TITLE ? title : `${title.slice(0, MAX_LEDGER_TITLE)}…`;
}

/**
 * An override is a decision somebody made, so it leaves a trace.
 *
 * `prior` is the ledger row this filing is waiving when the body was
 * re-drafted and the collision no longer reproduces. Naming its timestamp
 * rather than describing it is the point: a reader can find the refusal.
 */
export function overrideNote(v: FilingAdjudication, prior: FilingLedgerRow | null = null): string {
  if (v.refusal !== null) {
    return (
      `[FindingArbiter] Allowed by --label ${FILING_OVERRIDE_LABEL}, over a ${v.refusal} ` +
      `refusal: ${v.reason}. Recorded in ${ledgerPath()}.`
    );
  }
  return (
    `[FindingArbiter] Allowed by --label ${FILING_OVERRIDE_LABEL}, over the ${prior?.refusal} ` +
    `refusal of this same title at ${prior?.at}. This adjudication did not reproduce it — the ` +
    "body has changed since, and the body is an input to the symptom keys — so the override is " +
    `recorded against that row rather than this one. Recorded in ${ledgerPath()}.`
  );
}

/**
 * This title was refused before and is being filed again without the label.
 *
 * **Not a refusal.** #1536 says in as many words not to make the gate
 * stricter: the defect is that a re-draft was *invisible*, not that it got
 * through. So this is the visibility, and the filing proceeds.
 */
export function refiledNote(title: string, prior: FilingLedgerRow): string {
  return (
    `[FindingArbiter] This title was refused at ${prior.at} (${prior.refusal}` +
    `${prior.duplicateOf.length > 0 ? `, against ${prior.duplicateOf.map(d => `#${d}`).join(", ")}` : ""}) ` +
    "and this adjudication does not reproduce it, because the body has changed and the body is " +
    `an input to the symptom keys. The filing is ALLOWED and nothing is blocked. If you meant to ` +
    `override that refusal, say so with --label ${FILING_OVERRIDE_LABEL} so it is counted; if the ` +
    `re-draft genuinely describes a different finding, this note is the only record that the two ` +
    `share a title. Title: ${title}`
  );
}

/**
 * The prior-refusal lookup could not be performed, which is not the same as
 * finding nothing.
 *
 * Same split as `unmeasuredNote` and for the same reason: an override
 * attributed to no refusal and an override whose refusal could not be looked
 * up are different states, and only one of them is a reading.
 */
export function unreadableLedgerNote(): string {
  return (
    `[FindingArbiter] UNMEASURED prior refusals — ${ledgerPath()} exists and could not be read, ` +
    "so this command's rows carry `refiledAfter: null` meaning *not looked up* rather than *none " +
    "found*. The same read is the cap's state, so the filing is also refused `UNMEASURED_CAP` " +
    "rather than allowed: an unreadable ledger is not an empty one, and an allowance that cannot " +
    "be counted is not an allowance that is free."
  );
}
