/**
 * Adjudicate a `gh issue create` before it becomes an issue (#1261).
 *
 * `lib/finding-arbiter.ts` has been built, tested and **uncalled** for its
 * whole life. Measured on `origin/main` at 77bd12b2: the only reference to
 * `arbitrateBatch` outside its own file is its own `export` line, and the
 * only reference to `scripts/arbitrate-finding.ts` anywhere in the tree is
 * `package.json`'s `files[]` array — it is PUBLISHED, not invoked. This
 * module is the production caller, and the hook that calls it is
 * `hooks/FindingArbiterGate.hook.ts`.
 *
 * It is the same defect as #1241 (`reviewScopeForRound`), in the place that
 * decides the intake rate of the whole tracker: *a library function with no
 * production caller is not shipped, however well tested.*
 *
 * ## This gate fails OPEN, and that is the design, not an oversight
 *
 * Every other guard in `hooks/` fails closed. This one must not, and the
 * next reader will want to "fix" that, so it is stated here in the file they
 * will edit.
 *
 * The cost of being wrong is asymmetric. A false FILING is one duplicate
 * issue, which the next reader closes in ten seconds. A false SILENCE is a
 * real defect that was found, written up, and then deleted by a machine with
 * nobody told — and nothing downstream can recover it, because the only copy
 * was in the command we refused. #1162 is that defect arriving by its first
 * route; a gate that refused on error would be its second.
 *
 * So: a finding the arbiter could not adjudicate is **UNMEASURED, and
 * UNMEASURED is allowed through here**. That is the exact inverse of this
 * repository's standing position — `.claude/rules/config-access.md`, "an
 * absent credential is UNMEASURED, not a silent pass" — and the inversion is
 * deliberate. The standing rule governs a check whose job is to *withhold a
 * claim of success*, where refusing is the conservative direction. Here the
 * conservative direction is to let the report through, because the thing at
 * risk IS the report. Both rules say the same underlying thing: fail in the
 * direction that loses the least information.
 *
 * Every allow-on-error is annotated and logged, so an arbiter that quietly
 * stopped working shows up as a run of UNMEASURED rows rather than as
 * silence.
 *
 * ## It gates on duplication ONLY, and cannot gate on anything else
 *
 * Not by policy — by construction, which is the only kind of constraint that
 * survives an editor. `arbitrate` runs its checks in cost order and
 * short-circuits: duplicates first, then the verifier quorum. A hook has no
 * verifier group and passes no `votes`, so **every finding that is not a
 * duplicate returns at step 2 as UNMEASURED**, and steps 3 to 6 — the
 * category drop, the branch-scope reading, the citation-currency reading,
 * the severity tag — are unreachable from here. The only refusal this module
 * can physically produce is `DUPLICATE`.
 *
 * That matters because a worthiness score is the thing that would wreck
 * this. Duplicate detection is measurable and already written. "Is this
 * finding worth filing" is not, and a gate that guessed at it would suppress
 * exactly the novel findings this lane exists to produce. If you are adding
 * a severity threshold here, stop.
 *
 * `skipRepoChecks` is passed as well, so the guarantee holds even if the
 * check order in `arbitrate` is ever rearranged: no `git grep` and no file
 * read can run inside a PreToolUse hook on this path.
 *
 * ## Why this is a hook, when `scripts/arbitrate-finding.ts` says it is not
 *
 * That script's header argues the opposite case and it is answered rather
 * than ignored — its three objections, in its own order:
 *
 * 1. *"a multi-second pause on an unrelated Bash call"*. The tracker read is
 *    behind `createsIssue`, and the arbiter is behind a dynamic `import()`
 *    in the one branch that reaches it. A Bash call that is not a `gh issue
 *    create` pays one tokenize of its own command string and loads no
 *    arbiter at all.
 * 2. *"a tree-wide grep"*. Unreachable, twice over — see the section above.
 * 3. *"a check that fails open the moment the network does"*. True, and here
 *    it is the REQUIREMENT rather than the defect. The script is a decider
 *    whose non-zero exit withholds a finding; this is a guard whose job is to
 *    stop a duplicate, and the honest default for both is the direction that
 *    does not lose a report.
 *
 * The script's conclusion was right for the script. It is a CLI a caller
 * runs, and `gh issue create` is what agents actually type — which is why
 * the script has had no caller since the day it was written. A chokepoint
 * nobody routes through is not a chokepoint.
 *
 * **This does not replace that CLI.** The CLI reads all six checks with a
 * real verifier group and routes a finding to a comment, an issue or the
 * bin; this reads one axis and only ever says "already filed, here is
 * where". Different questions, and the CLI is still the better answer when a
 * caller has votes to offer.
 */

import { execFileSync } from "child_process";
import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";

import { clauses, createsIssue, flagValues } from "./issue-create-override";

/**
 * The decision field the hook emits, declared exactly once.
 *
 * One mutable site, so `test/finding-arbiter-gate.test.ts` can build a
 * mutant copy with this set to something Claude Code does not act on and
 * prove that a case which saw a refusal saw THIS constant — not a literal
 * inlined somewhere else. `.claude/rules/checks-must-be-able-to-fail.md`,
 * the section on a script whose job is to exit non-zero; a hook's decision
 * field is that same single site wearing different clothes.
 */
export const FINDING_GATE_DECISION = "block";

/**
 * The environment variable that turns the gate off, and the one value it
 * reads. Spelled exactly, for the reason `.claude/rules/config-access.md`
 * gives about `RUNGATE_REQUIRE_AI_REVIEW`: a loose reading of a variable
 * that disables a gate is a gate that disables itself by accident.
 */
export const FINDING_GATE_ENV = "RUNGATE_FINDING_GATE";
export const FINDING_GATE_OFF = "off";

/**
 * The id an allowed finding carries once it joins the comparison set for the
 * rest of its own command. Not an issue number, and deliberately readable:
 * it is what the refusal says this symptom collides with.
 *
 * The POSITION is part of the id, so no two entries in the comparison corpus
 * can share one. A corpus that hands one id to two findings is the defect
 * #1253 closed in `scripts/arbitrate-finding.ts`, and the refusal it produces
 * here — "already reported as X, X" — is exactly the unactionable shape this
 * module's refusal message exists to avoid.
 */
export const earlierInCommand = (position: number): string =>
  `an earlier issue created by this same command (number ${position} in it)`;

/** An issue a command is about to create, as read off the command line. */
export interface ProposedIssue {
  title: string;
  body: string;
  /**
   * Why the body could not be read, or `null` when it was. A proposal
   * carrying a reason is never adjudicated — it is allowed and annotated.
   */
  unreadable: string | null;
}

/** What the gate decided, and everything a log line or a message needs. */
export interface GateReading {
  /** Non-null means refuse. The text is shown to the agent verbatim. */
  refusal: string | null;
  /** Why nothing could be adjudicated. Non-null means this allow is UNMEASURED. */
  unmeasured: string | null;
  /** One row per proposed issue, in command order. */
  rows: GateRow[];
}

export interface GateRow {
  title: string;
  /** `DUPLICATE`, `UNMEASURED`, or whatever the arbiter returned. */
  refusal: string | null;
  duplicateOf: string[];
  /** The keys that produced the collision, so a reader can judge the match. */
  collidingKeys: string[];
  reason: string;
  /** Did this proposal reach the tracker? */
  allowed: boolean;
}

export interface GateOptions {
  /** Repository root. `gh` resolves the tracker from its `origin` remote. */
  projectRoot: string;
  /** `owner/name`. Absent, `gh` reads it from `projectRoot`'s own remote. */
  repo?: string;
  /**
   * A pinned comparison population, as JSON on disk, in the shape
   * `gh issue list --json number,title,body` returns.
   *
   * The same seam `scripts/arbitrate-finding.ts` exposes as `--existing`,
   * and for the same two uses: a test, and a measurement. A caller-supplied
   * population is never truncation-checked — it is the caller's own corpus.
   */
  existingFile?: string | null;
  /** Where readings are appended, as JSONL. */
  logPath?: string | null;
  /** How many open issues to compare against. See the truncation refusal. */
  limit?: number;
  /** Milliseconds the tracker read may take before the finding is UNMEASURED. */
  timeoutMs?: number;
  /** For the test. Defaults to the real `gh issue list`. */
  listIssues?: (limit: number) => string;
  /** For the test. Defaults to appending to `logPath`. */
  log?: (row: unknown) => void;
}

/** The default comparison depth. 32 open issues at the time of writing. */
export const DEFAULT_POPULATION_LIMIT = 120;

/** The default tracker-read budget. Past this the finding is let through. */
export const DEFAULT_TRACKER_TIMEOUT_MS = 10_000;

/**
 * The issues a command proposes to create, one per `gh issue create` clause.
 *
 * Reads through `clauses`/`flagValues` in `lib/issue-create-override.ts`
 * rather than a parser of its own, because that walk is the one that already
 * knows `--title "--label=follow-up"` is a title and not an override. A
 * second walk here would be two parsers disagreeing about where a value
 * ends.
 *
 * A command may carry more than one create — `gh issue create … && gh issue
 * create …` — and that is exactly the in-batch case #1187 was filed for:
 * #1195 and #1196 were the same symptom filed a minute apart, close enough
 * that neither was in the tracker when the other was adjudicated. So the
 * proposals go to `arbitrateBatch`, which accumulates as it walks, and not
 * to `arbitrate` once per clause against a fixed snapshot.
 */
export function proposedIssues(cmd: string, cwd: string): ProposedIssue[] {
  const out: ProposedIssue[] = [];
  for (const tokens of clauses(cmd).filter(createsIssue)) {
    const title = flagValues(tokens, { long: "--title", short: "-t" })[0] ?? "";
    const inline = flagValues(tokens, { long: "--body", short: "-b" })[0];
    const file = flagValues(tokens, { long: "--body-file", short: "-F" })[0];

    if (inline !== undefined) {
      out.push({ title, body: inline, unreadable: null });
      continue;
    }
    if (file === undefined) {
      // No body flag at all: `gh` opens an editor or applies a template, so
      // what reaches the tracker is not on this command line and cannot be
      // adjudicated from it.
      out.push({
        title,
        body: "",
        unreadable: "the command carries no --body or --body-file, so the issue text is not on the command line",
      });
      continue;
    }
    if (file === "-") {
      out.push({ title, body: "", unreadable: "--body-file - reads stdin, which a PreToolUse hook cannot see" });
      continue;
    }
    try {
      out.push({ title, body: readFileSync(resolve(cwd, file), "utf-8"), unreadable: null });
    } catch (error) {
      out.push({ title, body: "", unreadable: `--body-file ${file} could not be read: ${describe(error)}` });
    }
  }
  return out;
}

/** Read the comparison population. Throws; every throw is an allow upstream. */
function existingFindings(
  options: GateOptions,
  limit: number,
): Array<{ id: string; title: string; body: string }> {
  let raw: string;
  let fromTracker = true;
  if (options.existingFile) {
    raw = readFileSync(options.existingFile, "utf-8");
    fromTracker = false;
  } else {
    raw = (options.listIssues ?? defaultListIssues(options))(limit + 1);
  }
  const parsed = JSON.parse(raw) as Array<{ number?: number; id?: string; title?: string; body?: string }>;
  if (!Array.isArray(parsed)) throw new Error("the comparison population is not a JSON array");
  if (fromTracker && parsed.length > limit) {
    // A dedupe against a truncated corpus reports "no duplicate" exactly as
    // a complete one does, so the reading is UNMEASURED rather than clean.
    // Unlike `scripts/arbitrate-finding.ts`, UNMEASURED here ALLOWS.
    throw new Error(
      `the tracker returned more than ${limit} open issues, so the comparison population is truncated`,
    );
  }
  return parsed.map((i, at) => {
    const id = i.number !== undefined ? String(i.number) : i.id;
    if (id === undefined || id === "" || id === "undefined") {
      // A refusal that cannot name what the symptom collides with is not
      // reviewable, and an unreviewable refusal is worse than no refusal.
      throw new Error(`entry ${at} of the comparison population has neither \`number\` nor \`id\``);
    }
    return { id, title: i.title ?? "", body: i.body ?? "" };
  });
}

/**
 * The tracker read.
 *
 * `--repo` is passed only when the caller named one. Otherwise `gh` resolves
 * the repository from `projectRoot`'s own `origin`, which is both the
 * correct answer and the one that cannot hardcode a consumer's slug into
 * harness code.
 */
function defaultListIssues(options: GateOptions) {
  return (limit: number): string =>
    execFileSync(
      "gh",
      [
        "issue", "list",
        ...(options.repo?.trim() ? ["--repo", options.repo.trim()] : []),
        "--state", "open",
        "--limit", String(limit),
        "--json", "number,title,body",
      ],
      {
        cwd: options.projectRoot,
        encoding: "utf-8",
        timeout: options.timeoutMs ?? DEFAULT_TRACKER_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
}

/**
 * The single place that decides. `refusal === null` means allow.
 *
 * Every failure path in here returns an allow, and that is asserted rather
 * than promised: `test/finding-arbiter-gate.test.ts` drives a throwing
 * tracker read, a tracker timeout, an unparseable population, a population
 * with no ids, a truncated population and an unreadable body through this
 * function and expects an allow from each — because a header promising
 * fail-open is not a fail-open.
 */
export async function findingGateReading(
  cmd: string,
  cwd: string,
  options: GateOptions,
): Promise<GateReading> {
  const allow = (unmeasured: string | null, rows: GateRow[] = []): GateReading =>
    ({ refusal: null, unmeasured, rows });

  let proposals: ProposedIssue[];
  try {
    proposals = proposedIssues(cmd, cwd);
  } catch (error) {
    // The tokenizer is upstream of every decision here. If it throws we do
    // not know whether this was even an issue creation, so the only honest
    // reading is that nothing was measured.
    return allow(`the command could not be parsed: ${describe(error)}`);
  }
  if (proposals.length === 0) return allow(null);

  const readable = proposals.filter(p => p.unreadable === null);
  if (readable.length === 0) {
    return record(options, allow(proposals[0].unreadable, proposals.map(unreadableRow)));
  }

  let reading: GateReading;
  try {
    // Dynamic, and the reason is objection 1 in the header: this pulls in
    // the arbiter and the jury, and an unrelated Bash call must not pay for
    // modules it will never reach.
    const { arbitrate, UNFILED_ID } = await import("./finding-arbiter");
    const limit = options.limit ?? DEFAULT_POPULATION_LIMIT;

    // `arbitrate` in a walk, and NOT `arbitrateBatch`. The difference is one
    // predicate and it is the difference between a working in-batch dedupe
    // and a dead one.
    //
    // `arbitrateBatch` accumulates survivors with `if (verdict.disposition
    // !== "DROP") seen.push(finding)` — "only something that will actually
    // be posted or filed occupies the space". That is correct for its own
    // caller, where a DROP really does mean the finding goes nowhere. It is
    // wrong here, because this gate convenes no verifier group, so EVERY
    // non-duplicate comes back `DROP`/`UNMEASURED` — and this gate ALLOWS
    // those, which means they reach the tracker and must occupy the space.
    // Called through `arbitrateBatch`, `seen` never grows past the tracker
    // snapshot and two identical findings in one command both survive. That
    // is #1187's own incident shape, so it is worth being exact about:
    // measured here, the batch call let both through and this walk refuses
    // the second (`test/finding-arbiter-gate.test.ts`, "two IDENTICAL
    // findings in one command").
    //
    // The duplicate DECISION is still entirely `arbitrate`'s — nothing here
    // re-implements `duplicateOverlap`, which would be the two-deciders
    // shape. Only the "did it reach a reader" predicate differs, and it
    // differs because for this caller the honest answer genuinely differs.
    const seen = [...existingFindings(options, limit)];
    const rows: GateRow[] = [];
    for (const p of readable) {
      const finding = { id: UNFILED_ID, title: p.title, body: p.body };
      const verdict = arbitrate(finding, {
        projectRoot: options.projectRoot,
        existing: seen,
        // No `votes`, and that omission is load-bearing: it is what makes
        // DUPLICATE the only refusal reachable from here. See the header.
        skipRepoChecks: true,
      });
      const allowed = verdict.refusal !== "DUPLICATE";
      // An allowed finding joins the comparison set for everything after it,
      // under an id that names where it came from. `UNFILED_ID` would make
      // the refusal read "already reported as new", which is unactionable.
      if (allowed) seen.push({ ...finding, id: earlierInCommand(rows.length + 1) });
      rows.push({
        title: p.title,
        refusal: verdict.refusal,
        duplicateOf: verdict.duplicateOf,
        collidingKeys: verdict.collidingKeys,
        reason: verdict.reason,
        allowed,
      });
    }
    for (const p of proposals) if (p.unreadable !== null) rows.push(unreadableRow(p));

    // Read off `allowed`, which is the ONE place a row's fate is decided.
    // Re-testing `refusal === "DUPLICATE"` here would be a second decider
    // over the same question — and the measurement that says so is real: a
    // mutation of the `allowed` predicate alone left this filter holding
    // the case up, and 33 of 34 cases stayed green
    // (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
    const dupes = rows.filter(r => !r.allowed);
    reading = dupes.length === 0
      ? allow(null, rows)
      : { refusal: refusalMessage(dupes), unmeasured: null, rows };
  } catch (error) {
    reading = allow(
      `the arbiter could not adjudicate this finding: ${describe(error)}`,
      proposals.map(p => ({
        title: p.title,
        refusal: "UNMEASURED",
        duplicateOf: [],
        collidingKeys: [],
        reason: "the arbiter did not return a reading",
        allowed: true,
      })),
    );
  }
  return record(options, reading);
}

function unreadableRow(p: ProposedIssue): GateRow {
  return {
    title: p.title,
    refusal: "UNMEASURED",
    duplicateOf: [],
    collidingKeys: [],
    reason: p.unreadable ?? "",
    allowed: true,
  };
}

const describe = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).trim().slice(0, 400);

/**
 * What the agent is told when a filing is refused.
 *
 * It names the issue the symptom is already reported as, because a refusal
 * that does not is one the agent can only respond to by retrying. #1162's
 * defect is a finding dropped with no trace; a refusal nobody can act on is
 * the same loss with a message attached.
 */
export function refusalMessage(dupes: GateRow[]): string {
  // A tracker id renders as `#N`; `EARLIER_IN_COMMAND` renders as itself. A
  // blanket `#` prefix would produce "#an earlier `gh issue create`…".
  const name = (d: string) => (/^\d+$/.test(d) ? `#${d}` : d);
  // Rendered from `collidingKeys`, not from the arbiter's `reason`, which
  // opens by restating the ids — "already reported as #1268 — the symptom is
  // already reported as 1268" was the live reading before this.
  const one = (r: GateRow) =>
    `  "${r.title}"\n    already reported as ${r.duplicateOf.map(name).join(", ")}\n` +
    `    they share ${r.collidingKeys.length} symptom key(s): ${r.collidingKeys.slice(0, 6).join(", ")}`;
  return (
    "[FindingArbiterGate] This symptom is already on the tracker, so filing it " +
    "again adds a duplicate rather than a report (#1187, #1261).\n\n" +
    dupes.map(one).join("\n") +
    "\n\nWhat to do instead, in order:\n" +
    "  1. If the open issue is missing something yours has, comment on it:\n" +
    "     gh issue comment <N> --body \"…\"\n" +
    "  2. If it is genuinely a different symptom, say so in the title and body. " +
    "The match is on shared symbols, files and quantities, so naming the specific " +
    "thing you found will not collide.\n" +
    `  3. If this refusal is wrong, ${FINDING_GATE_ENV}=${FINDING_GATE_OFF} bypasses ` +
    "the gate. Every bypass is logged; say why in the issue body.\n\n" +
    "This gate adjudicates duplicates ONLY. It never judges whether a finding is " +
    "worth filing, and anything it cannot read it lets through."
  );
}

/** Append the reading. Never throws: a log that fails must not become a refusal. */
function record(options: GateOptions, reading: GateReading): GateReading {
  if (reading.rows.length === 0) return reading;
  const row = {
    at: new Date().toISOString(),
    decision: reading.refusal === null ? "allow" : FINDING_GATE_DECISION,
    unmeasured: reading.unmeasured,
    findings: reading.rows,
  };
  try {
    if (options.log) {
      options.log(row);
    } else if (options.logPath) {
      mkdirSync(dirname(options.logPath), { recursive: true });
      appendFileSync(options.logPath, JSON.stringify(row) + "\n");
    }
  } catch {
    // Deliberately swallowed, and the only swallow here that produces no
    // annotation. The refusal is already in front of the agent as a tool
    // result; losing its JSONL copy must not also lose the refusal, and it
    // must certainly not turn an allow into a block.
  }
  return reading;
}
