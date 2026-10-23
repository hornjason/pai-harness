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
 * - **A body passed as `--body-file`.** The symptom keys are in the file, not
 *   in the command, so the dedupe has nothing to read. That is `UNMEASURED`
 *   and therefore allowed — see above.
 * - **Whether a refusal was right.** The ledger records what was adjudicated,
 *   not what the outcome should have been. It supplies the left-hand side of
 *   that join and nothing more, exactly as `CandidateRecord` says of itself.
 */

import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

import { resolveRepoSlug } from "./branch-cleanup";
import { createGitHubClient, listOpenIssues } from "./github";
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

/** How many open issues the dedupe compares against. */
export const OPEN_ISSUE_LIMIT = 100;

/** One `gh issue create` clause, as much of it as the two stages read. */
export interface FilingAttempt {
  title: string;
  body: string;
  labels: string[];
  /** The body is in a file, so the command does not carry the symptom. */
  bodyFromFile: boolean;
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

/**
 * Every `gh issue create` in this command, one entry per clause.
 *
 * Per clause and not per command, for the reason `verifyPhaseRefusal` is:
 * `gh issue comment … && gh issue create …` is a create, and a reading over
 * the whole string lets the first half excuse the second.
 */
export function filingAttempts(cmd: string): FilingAttempt[] {
  return clauses(cmd)
    .filter(createsIssue)
    .map(tokens => {
      const bodyFile = flagValues(tokens, BODY_FILE_FLAG);
      return {
        title: flagValues(tokens, TITLE_FLAG).join(" "),
        body: flagValues(tokens, BODY_FLAG).join("\n"),
        labels: labelValues(tokens),
        bodyFromFile: bodyFile.length > 0,
      };
    });
}

/**
 * The single place that decides whether a filing may proceed.
 *
 * `readExisting` is a thunk and not a value so the `gh issue list` is never
 * paid for a finding the category stage already drops. It returns `null` for
 * "could not be read", which is a different fact from an empty tracker — the
 * distinction `.claude/rules/config-access.md` makes about a corrupt config,
 * applied to the one input this gate cannot produce itself.
 */
export async function adjudicateFiling(
  attempt: FilingAttempt,
  readExisting: () => Promise<readonly Finding[] | null>,
): Promise<FilingAdjudication> {
  const finding: Finding = { id: UNFILED_ID, title: attempt.title, body: attempt.body };
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
  if (attempt.bodyFromFile) {
    return {
      ...base,
      outcome: "UNMEASURED",
      refusal: "UNMEASURED",
      reason: "the body is in a file, so the keys this would be deduplicated on are not in the command",
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

  // ── is this new? ──
  const existing = await readExisting();
  if (existing === null) {
    return {
      ...base,
      outcome: "UNMEASURED",
      refusal: "UNMEASURED",
      reason: "the open-issue set could not be read, so whether this symptom is already filed was never asked",
    };
  }
  const collisions = duplicateCollisions(finding, existing);
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

  return {
    ...base,
    outcome: "ALLOW",
    refusal: null,
    reason: `no open issue shares this symptom, and ${category} is not a dropped category`,
  };
}

/**
 * The open issues, as findings — or `null` when the set could not be read.
 *
 * `null` and `[]` are different facts and the caller treats them differently:
 * an empty tracker means nothing is a duplicate, an unreadable one means
 * nobody asked. Every failure path here returns `null` rather than `[]`, so a
 * `gh` that is missing, unauthenticated, rate-limited, slow or returning
 * something unexpected cannot be mistaken for a clean tracker.
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
 * environment. With no token this returns `null`, the dedupe is UNMEASURED,
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
export async function openFindings(projectRoot: string): Promise<readonly Finding[] | null> {
  const override = process.env.RUNGATE_OPEN_FINDINGS;
  if (override !== undefined && override !== "") {
    try {
      return asFindings(JSON.parse(readFileSync(override, "utf-8")));
    } catch {
      return null;
    }
  }
  try {
    const { slug } = resolveRepoSlug({ projectRoot });
    if (slug === null) return null;
    const issues = await listOpenIssues(createGitHubClient(), slug, OPEN_ISSUE_LIMIT);
    return issues.map(i => ({ id: String(i.number), title: i.title, body: i.body }));
  } catch {
    // Every failure lands here as `null`, which is "nobody asked" and not
    // "nothing matched" — a missing token, a 403, a rate limit and an
    // unreachable API are all states this must not report as a clean tracker.
    return null;
  }
}

/** Supplied rows as `Finding`s, or `null` if the shape is not what we asked for. */
function asFindings(parsed: unknown): readonly Finding[] | null {
  if (!Array.isArray(parsed)) return null;
  const out: Finding[] = [];
  for (const row of parsed) {
    if (row === null || typeof row !== "object") return null;
    const r = row as Record<string, unknown>;
    const id = r.number ?? r.id;
    if (typeof id !== "number" && typeof id !== "string") return null;
    if (typeof r.title !== "string") return null;
    out.push({ id: String(id), title: r.title, body: typeof r.body === "string" ? r.body : "" });
  }
  return out;
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
    readExisting?: (projectRoot: string) => Promise<readonly Finding[] | null>;
  },
): Promise<FilingGateReading> {
  const attempts = filingAttempts(cmd);
  if (attempts.length === 0) return NO_FILING;

  const at = options.now ?? new Date().toISOString();
  const read = options.readExisting ?? openFindings;
  // Read once per command, not once per clause: two creates in one command
  // adjudicated against two different snapshots is a reading nobody can act
  // on. The PROMISE is cached rather than its value, so two clauses cannot
  // both start a request before either has resolved.
  let cached: Promise<readonly Finding[] | null> | undefined;
  const readExisting = () => (cached ??= read(options.projectRoot));

  const rows: FilingLedgerRow[] = [];
  const refusals: string[] = [];
  const notes: string[] = [];

  for (const attempt of attempts) {
    const verdict = await adjudicateFiling(attempt, readExisting);
    const overridden = verdict.outcome === "REFUSE" && attempt.labels.includes(FILING_OVERRIDE_LABEL);
    const emitted = verdict.outcome !== "REFUSE" || overridden;

    rows.push({
      at,
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

  return {
    refusal: refusals.length > 0 ? refusals.join("\n\n") : null,
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

/** Said out loud, because an UNMEASURED that nobody sees is a silent pass. */
export function unmeasuredNote(v: FilingAdjudication): string {
  return (
    `[FindingArbiter] UNMEASURED — this filing was NOT adjudicated: ${v.reason}. ` +
    "It is allowed through, because a broken adjudicator must not become a gag on " +
    `the tracker, and the row is recorded in ${ledgerPath()} as UNMEASURED rather ` +
    "than as a finding that passed. Those are different states."
  );
}

/** An override is a decision somebody made, so it leaves a trace. */
export function overrideNote(v: FilingAdjudication): string {
  return (
    `[FindingArbiter] Allowed by --label ${FILING_OVERRIDE_LABEL}, over a ${v.refusal} ` +
    `refusal: ${v.reason}. Recorded in ${ledgerPath()}.`
  );
}
