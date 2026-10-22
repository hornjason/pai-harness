/**
 * Gate enforcement logic — extracted from GateEnforcement.hook.ts
 *
 * Deep module: exports enforcement decision logic, workflow gate failure
 * scanning, and signal logging. The hook file is a thin trigger that
 * delegates all logic here.
 *
 * Issue: #544. Fail-open closed by #1155.
 *
 * ## A state that could not be read is not a state with no failures (#1155)
 *
 * This module decides whether an agent is walking away from a gate FAIL. It
 * used to answer that question from a bare `catch` commented "skip malformed",
 * so a `workflow-state.json` that would not parse read as **no gate failure** —
 * the condition that should refuse most loudly producing the most permissive
 * result. That is *Silent Default Substitution* (`.claude/rules/config-access.md`)
 * and the same fail-open class `lib/gate-result-protection.ts` closed.
 *
 * Measured 2026-10-22, because "malformed" was covering more than one thing:
 *
 *  - **Three** distinct throw sources reached that one catch — a `JSON.parse`
 *    SyntaxError, a TypeError from reading `.phase` off a parsed `null`, and
 *    an fs error when the path exists but cannot be read (EISDIR, EACCES, or
 *    a delete racing the `existsSync` above it).
 *  - **The catch was not the only fail-open.** A state parsing to `42`, `"x"`
 *    or `[]` throws nothing at all: `.phase` is `undefined`, `gates || {}` is
 *    empty, and the old code returned `null` down the *normal* path. So six
 *    inputs read as a clean run, not three. `gate-result-protection` already
 *    refuses the non-object parses by name; this module now agrees with it.
 *
 * Three states that the old `null` conflated are now distinct, and only the
 * middle one refuses:
 *
 * | On disk | Reading |
 * |---|---|
 * | no work dir, or no state file — a first run | `MEASURED`, no failure |
 * | present, parses, no blocking gate FAIL | `MEASURED`, no failure |
 * | present and unreadable, unparseable, or not an object | `UNMEASURED` |
 *
 * ## Why the refusal is scoped to Skill calls, and is not a wider block
 *
 * A bare refusal here would be worse than the bug: `GateEnforcement` is a
 * PreToolUse hook on `.*`, so refusing every tool call would make a single
 * corrupt state file a denial of service on the session — and a guard nobody
 * can get out from under gets switched off, after which it guards nothing.
 * So the recovery path was measured before the failure mode was chosen:
 *
 *  - `makeEnforcementDecision` already blocks **only** `Skill` calls. Bash,
 *    Read, Edit and Agent are nagged, never blocked — that is the existing
 *    design's own escape hatch and it predates this change.
 *  - `WorkflowStateGuard` refuses direct `Write`/`Edit` of the artifact and
 *    names the repair: `bun -e "… writeWorkflowState(…)"`.
 *  - `BashWriteGuard` inspects only `>`/`>>`, `tee`, `cp` and `mv` targets,
 *    so that `bun -e` command carries no write target it can see and is
 *    allowed through.
 *
 * The repair therefore runs over Bash, which this refusal leaves open. There
 * is no deadlock, and `test/gate-enforcement.test.ts` holds that as a control
 * rather than as a comment: if a later change starts blocking Bash here, the
 * control goes red.
 *
 * The refusal is **immediate** rather than strike-counted. Strikes are keyed
 * on `issue` + `gate` by `loadStrikeCount`, and an unreadable state supplies
 * neither — there is nothing to count against. Same reasoning as an OUTCOME
 * AC failure, which also blocks on sight.
 *
 * One more consequence of the old `catch` is worth naming, because it is not
 * the one the issue was filed about: `runGateEnforcement` deletes
 * `gate-pending.json` when it sees no failure, so a corrupt state file also
 * **erased the strike counter**. An unmeasured reading now leaves it alone.
 *
 * ## The catch was one route to the wrong answer, not the only one
 *
 * A review of the first fix found three more, and measuring them found a
 * fourth. None of them throws: each walks past a malformed value and arrives
 * at the same "no gate failure" the catch produced. All now refuse.
 *
 * | Shape | Why it is not cosmetic |
 * |---|---|
 * | `gates` present and not an object | reads as a state with no gates |
 * | a record under a gate name not an object | reads as that gate not failing |
 * | `result: "FAIL"` with non-array `failures` | drops an explicit FAIL |
 * | `acs` present and not an array | `hasOutcomeAcFailure` false, so an immediate block degrades to a 3-strike nag |
 * | `issue` absent or not a number | `loadStrikeCount` compares with `===`, so strikes read 0 forever and max_strikes is never reached — escalation silently off |
 *
 * `failures` ABSENT stays legal, because the schema has it optional; only a
 * present-but-wrong-typed one refuses.
 *
 * ## Why refusing is safe here, which the issue asked to be shown and not assumed
 *
 * The issue's open question was transient corruption — a half-written state
 * during a concurrent gate run turning into a block. It cannot happen:
 * `writeState` in `gates/orchestrator.ts` writes a `.tmp`, RE-PARSES it to
 * prove it is valid JSON, and only then `renameSync`s over the real path.
 * rename(2) is atomic, so a concurrent reader sees the whole old file or the
 * whole new one, never a prefix of either. An unparseable state on disk is
 * therefore durable corruption from something other than the writer — which
 * is exactly the case that must refuse.
 *
 * Measured against the live work store on 2026-10-22 as a control on
 * over-refusal: 164 state files, `issue` a number in 164, `acs` an array in
 * 164, `slug` a string in 164, and `failures` a non-empty array in all 95
 * FAIL gates. This module reads that store as MEASURED with zero reasons.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { checkDocHygiene } from './doc-hygiene';
import { BLOCKING_GATES } from './gate-names';

export interface GateFailure {
  check: string;
  detail: string;
}

export interface WorkflowGateFailure {
  gate: string;
  issue: number;
  slug: string;
  failures: GateFailure[];
  hasOutcomeAcFailure: boolean;
}

export interface GatePending {
  session_id: string;
  gate: string;
  issue: number;
  slug: string;
  failures: GateFailure[];
  strike_count: number;
  max_strikes: number;
  outcome_ac_failure: boolean;
  created_at: string;
  expires_ts: number;
}

export type EnforcementAction = 'block' | 'nag' | 'pass';

export interface EnforcementDecision {
  action: EnforcementAction;
  decision?: string;
  reason?: string;
  reminder?: string;
  newStrikeCount: number;
}

/**
 * Format gate failures into human-readable text.
 */
export function formatFailures(failures: GateFailure[]): string {
  return failures.map(f => `  - ${f.check}: ${f.detail}`).join('\n');
}

/**
 * Whether every state file under the work directory could actually be read.
 * `UNMEASURED` means at least one could not — which is not the same answer as
 * "no gate failed", and must never be collapsed into it.
 */
export type WorkflowReading = 'MEASURED' | 'UNMEASURED';

/**
 * A union rather than a record, so **`failure` exists only on the measured
 * variant** — the shape `lib/intake-sources.ts` uses for the same hazard over
 * these same files, and for the same stated reason: "a warning beside a
 * number is read after the number, if at all."
 *
 * The hazard is not hypothetical here, it was live in this module's first
 * draft: `runGateEnforcement` read `scan.failure` and consulted `reading`
 * only when that was null, so a sweep that failed to parse one state and
 * found a failure in another reported a COMPLETE result. `intake-sources`
 * declines to convert `FailureIntakeReading` to a union on the grounds that
 * its hazard is latent and the type is shipped; both halves of that argument
 * point the other way for this type, which is new in #1155 and whose first
 * consumer had already fallen into the trap.
 *
 * The partial result stays reachable — withholding it would make a partial
 * scan and a clean one look alike — but under a name nobody reaches for by
 * accident, because acting on it is a decision.
 */
export type WorkflowScan =
  | {
      reading: 'MEASURED';
      unmeasuredReasons: string[];
      /** The first blocking gate FAIL, in scope > verify > ship priority. */
      failure: WorkflowGateFailure | null;
    }
  | {
      reading: 'UNMEASURED';
      unmeasuredReasons: string[];
      /** What the states that COULD be read yielded. Deliberately not `failure`. */
      failureFromPartialScan: WorkflowGateFailure | null;
    };

/** A plain JSON object — not an array, not null, not a scalar. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** What one state file yielded: a failure, or a reason it could not be read. */
interface FileReading {
  failure: WorkflowGateFailure | null;
  unmeasured: string | null;
}

const READABLE: FileReading = { failure: null, unmeasured: null };

/**
 * Scan workflow-state.json files under workDir for active gate failures.
 * Returns the first failure found (scope > verify > ship priority).
 * Checks both direct children and nested subdirectories.
 *
 * An unreadable state does not abort the scan: a readable sibling can still
 * carry a real FAIL, and discarding it would trade one fail-open for another.
 * Both answers are carried — `failure` for the actionable one, `reading` for
 * whether the sweep was complete.
 */
export function findWorkflowGateFailure(workDir: string): WorkflowScan {
  const reasons: string[] = [];
  // An absent work directory is a first run, not a corrupt one. MEASURED.
  if (!existsSync(workDir)) return { reading: 'MEASURED', failure: null, unmeasuredReasons: [] };

  let failure: WorkflowGateFailure | null = null;

  // First failure wins, as before — but the sweep RUNS TO COMPLETION rather
  // than returning on it. Stopping early would make `reading` depend on
  // readdir order: a corrupt state sorting after a failing one would go
  // unreported, and the same two files would answer differently on a
  // filesystem that enumerated them the other way round.
  const take = (r: FileReading): void => {
    if (r.unmeasured) reasons.push(r.unmeasured);
    if (r.failure && !failure) failure = r.failure;
  };

  try {
    const dirs = readdirSync(workDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const d of dirs) {
      // Level 1: direct children
      take(checkWorkflowFile(`${workDir}/${d.name}/workflow-state.json`, d.name));

      // Level 2: nested subdirectories
      try {
        const subDirs = readdirSync(`${workDir}/${d.name}`, { withFileTypes: true })
          .filter(sd => sd.isDirectory());
        for (const sd of subDirs) {
          take(checkWorkflowFile(
            `${workDir}/${d.name}/${sd.name}/workflow-state.json`,
            `${d.name}/${sd.name}`,
          ));
        }
      } catch (err) {
        reasons.push(`${workDir}/${d.name}: directory could not be listed (${err})`);
      }
    }
  } catch (err) {
    reasons.push(`${workDir}: work directory could not be listed (${err})`);
  }

  // Same derivation as `lib/intake-sources.ts`: the reading is a function of
  // whether anything went unread, and NOT of whether a failure turned up.
  return reasons.length === 0
    ? { reading: 'MEASURED', failure, unmeasuredReasons: reasons }
    : { reading: 'UNMEASURED', failureFromPartialScan: failure, unmeasuredReasons: reasons };
}

/**
 * Check a single workflow-state.json file for gate failures.
 *
 * Returns a reason rather than `null` whenever the file is present but could
 * not be read as a workflow state — see the module docstring for the six
 * inputs that used to come back as a clean run.
 */
function checkWorkflowFile(wfPath: string, slug: string): FileReading {
  // Genuinely absent: this issue simply has no state yet.
  if (!existsSync(wfPath)) return READABLE;

  let wf: unknown;
  try {
    wf = JSON.parse(readFileSync(wfPath, 'utf-8'));
  } catch (err) {
    return { failure: null, unmeasured: `${wfPath}: could not be read as JSON (${err})` };
  }

  // A workflow state is always an object. An array, a null or a scalar is a
  // reading that could not be taken, and throws nothing on the way past.
  if (!isPlainObject(wf)) {
    return {
      failure: null,
      unmeasured: `${wfPath}: parsed to ${Array.isArray(wf) ? 'an array' : typeof wf}, not a workflow state object`,
    };
  }

  const refuse = (what: string) => ({
    failure: null,
    unmeasured: `${wfPath}: ${what} — the state is malformed, so whether a gate FAILed is unknown`,
  });

  try {
    if (wf.phase === 'DONE') return READABLE;

    // Every shape check below mirrors `WorkflowStateSchema` in gates/schema.ts,
    // which `writeWorkflowState` enforces on the way in. A value that violates
    // it did not come from the sanctioned writer, and walking past it reaches
    // the same wrong answer as the catch this issue was filed about.
    //
    // Mirrored by hand rather than imported: `package.json` `files[]` ships
    // `lib/` and `hooks/` and NOT `gates/`, so importing the schema here
    // would make the published package reference a file it does not ship.
    // `lib/` imports nothing from `gates/` today and this is not the change
    // that should be the first. The duplication is bounded to four field
    // types, and over-refusal is controlled by measurement, not by hope:
    // across the 164 state files in the live work store this reports
    // MEASURED with zero reasons.
    if (wf.gates !== undefined && !isPlainObject(wf.gates)) {
      return refuse(`gates is ${Array.isArray(wf.gates) ? 'an array' : typeof wf.gates}, not an object`);
    }
    // `acs` feeds hasOutcomeAcFailure, which is the difference between an
    // immediate block and a three-strike nag — so a malformed one downgrades
    // enforcement rather than merely losing detail.
    if (wf.acs !== undefined && !Array.isArray(wf.acs)) {
      return refuse(`acs is ${typeof wf.acs}, not an array`);
    }
    // `issue` keys the strike counter, and `loadStrikeCount` compares it with
    // `===`. A string issue reads 0 strikes on every call, so the agent never
    // reaches max_strikes and is never blocked — escalation silently off.
    if (typeof wf.issue !== 'number') {
      return refuse(wf.issue === undefined ? 'issue is absent' : `issue is ${wf.issue === null ? 'null' : typeof wf.issue}, not a number`);
    }
    if (wf.slug !== undefined && typeof wf.slug !== 'string') {
      return refuse(`slug is ${typeof wf.slug}, not a string`);
    }

    const gates = (wf.gates ?? {}) as Record<string, unknown>;
    // #1137: the registry, not a second copy of it. This list and
    // GateResultProtection's agreed on every input anyone had, so nothing
    // could go red when they diverged.
    for (const gateName of BLOCKING_GATES) {
      const raw = gates[gateName];
      if (raw === undefined || raw === null) continue;
      if (!isPlainObject(raw)) {
        return refuse(`gates.${gateName} is ${Array.isArray(raw) ? 'an array' : typeof raw}, not an object`);
      }
      const gate = raw as {
        result?: unknown;
        failures?: { check?: string; id?: string; detail?: string; message?: string }[];
      };
      if (gate.result !== 'FAIL') continue;

      // `failures` is optional in the schema, so ABSENT is legal and reads as
      // a FAIL with nothing to report (0 of 95 live FAIL gates omit it).
      // Present-but-not-an-array is not legal, and dropping a FAIL because
      // its detail is the wrong type is the fail-open in miniature.
      if (gate.failures !== undefined && !Array.isArray(gate.failures)) {
        return refuse(`gates.${gateName}.result is FAIL but failures is ${typeof gate.failures}, not an array`);
      }
      if (!Array.isArray(gate.failures) || gate.failures.length === 0) continue;

      const acs = (wf.acs ?? []) as { type?: string; verdict?: string }[];
      return {
        unmeasured: null,
        failure: {
          gate: gateName,
          issue: wf.issue,
          slug: (wf.slug as string | undefined) || slug,
          failures: gate.failures.map(f => ({
            check: f.check || f.id || 'unknown',
            detail: f.detail || f.message || JSON.stringify(f),
          })),
          hasOutcomeAcFailure: acs.some(ac => ac?.type === 'OUTCOME' && ac?.verdict === 'FAIL'),
        },
      };
    }
  } catch (err) {
    // Nothing above should throw now that the shape is checked first — so if
    // one does, that is an unread state, not a clean one. Refuse, don't skip.
    return { failure: null, unmeasured: `${wfPath}: could not be interpreted (${err})` };
  }

  return READABLE;
}

/**
 * Determine the enforcement action (block/nag/pass) for a given gate state and tool call.
 */
export function makeEnforcementDecision(pending: GatePending, toolName: string): EnforcementDecision {
  const isSkillCall = toolName === 'Skill';
  const failureText = formatFailures(pending.failures);

  // OUTCOME AC failure -> immediate block on Skill calls
  if (pending.outcome_ac_failure && isSkillCall) {
    return {
      action: 'block',
      decision: 'block',
      reason: `OUTCOME AC failed — must fix before proceeding. Gate: ${pending.gate}, issue #${pending.issue}.\n${failureText}`,
      newStrikeCount: pending.strike_count,
    };
  }

  // Strike-based block on Skill calls
  if (isSkillCall && pending.strike_count >= pending.max_strikes) {
    return {
      action: 'block',
      decision: 'block',
      reason: `Gate blocked after ${pending.strike_count} strikes: ${pending.gate} (issue #${pending.issue}).\n${failureText}\nFix the failures or post skip-reason to the issue.`,
      newStrikeCount: pending.strike_count,
    };
  }

  // Nag — only count strikes for Skill calls
  const newStrikeCount = isSkillCall ? pending.strike_count + 1 : pending.strike_count;

  const reminder = [
    '<system-reminder>',
    `⚠️ GATE FAIL (${pending.gate}): issue #${pending.issue}`,
    failureText,
    `Strike ${newStrikeCount}/${pending.max_strikes}. Fix before proceeding or post skip-reason to issue.`,
    '</system-reminder>',
  ].join('\n');

  return {
    action: 'nag',
    reminder,
    newStrikeCount,
  };
}

/**
 * Load cached strike count from gate-pending.json if it matches the current failure.
 */
export function loadStrikeCount(pendingFile: string, issue: number, gate: string): number {
  if (!existsSync(pendingFile)) return 0;
  try {
    const cached = JSON.parse(readFileSync(pendingFile, 'utf-8'));
    if (cached.issue === issue && cached.gate === gate) {
      return cached.strike_count || 0;
    }
  } catch {}
  return 0;
}

/**
 * Build a GatePending object from a workflow gate failure and session context.
 */
export function buildGatePending(
  wfFailure: WorkflowGateFailure,
  sessionId: string,
  strikeCount: number,
): GatePending {
  return {
    session_id: sessionId,
    gate: wfFailure.gate,
    issue: wfFailure.issue,
    slug: wfFailure.slug,
    failures: wfFailure.failures,
    strike_count: strikeCount,
    max_strikes: 3,
    outcome_ac_failure: wfFailure.hasOutcomeAcFailure,
    created_at: new Date().toISOString(),
    expires_ts: Date.now() + (4 * 60 * 60 * 1000),
  };
}

/**
 * Log an enforcement signal event to the signals file.
 *
 * SC-504: appendFileSync creates the file if absent — the previous
 * existence guard silently dropped signals on first write.
 */
export function logSignal(signalsDir: string, signalsFile: string, event: Record<string, unknown>): void {
  try {
    if (!existsSync(signalsDir)) mkdirSync(signalsDir, { recursive: true });
    appendFileSync(signalsFile, JSON.stringify(event) + '\n', 'utf-8');
  } catch (err) {
    console.error(`[GateEnforcement] Signal log write failed: ${err}`);
  }
}

/**
 * Everything the hook needs from its environment. Passed in rather than
 * read from module scope so the whole decision path is callable from a test.
 */
export interface GateEnforcementInput {
  /** Directory holding the per-issue workflow-state.json files. */
  workDir: string;
  /** Directory for the signals log; created on demand. */
  signalsDir: string;
  /** Signals JSONL path. */
  signalsFile: string;
  /** gate-pending.json path — the strike counter's home. */
  pendingFile: string;
  /** Project root, scanned for doc-hygiene findings (SC-508). */
  projectRoot: string;
  sessionId: string;
  toolName: string;
}

export interface GateEnforcementResult {
  /** What the hook should print on stdout, or null to stay silent. */
  stdout: string | null;
  action: EnforcementAction;
}

/**
 * The whole GateEnforcement decision, extracted from the hook (SC-369).
 *
 * The hook is now a trigger: parse stdin, call this, print, exit 0. Keeping
 * the logic here is what makes it reachable by test/gate-enforcement.test.ts
 * without simulating a PreToolUse payload.
 */
/**
 * One emitter for both enforcement outcomes, so a block and a nag cannot drift
 * into different event shapes. `reason` is attributed only for a block: a nag
 * has no reason, and emitting one anyway would make every nag look like a
 * near-block in the signal history.
 */
export function logEnforcementSignal(
  signalsDir: string,
  signalsFile: string,
  pending: GatePending,
  tool: string,
  action: 'block' | 'nag',
  strike: number,
): void {
  logSignal(signalsDir, signalsFile, {
    ts: new Date().toISOString(),
    type: 'gate_enforcement',
    gate: pending.gate,
    issue: pending.issue,
    strike,
    tool,
    action,
    ...(action === 'block'
      ? { reason: pending.outcome_ac_failure ? 'outcome_ac_failure' : 'max_strikes' }
      : {}),
  });
}

/**
 * What an agent is told when the gate state cannot be read. It names the
 * artifact, the reason, and the one command that can repair it — a refusal
 * with no way out is a denial of service, not a guard.
 */
export function unmeasuredStateReason(
  reasons: string[],
  alsoFound: WorkflowGateFailure | null = null,
): string {
  return [
    'UNMEASURED: the harness gate state could not be read, so whether a gate is ' +
      'currently FAILing is unknown — and an unknown is not a pass.',
    ...reasons.map(r => `  - ${r}`),
    ...(alsoFound
      ? [
          '',
          `The states that COULD be read also carry a ${alsoFound.gate} gate FAIL on ` +
            `issue #${alsoFound.issue}:`,
          formatFailures(alsoFound.failures),
        ]
      : []),
    '',
    'Repair the state, then retry. workflow-state.json is not directly writable ' +
      '(WorkflowStateGuard); go through the validating writer:',
    '  bun -e "import {writeWorkflowState} from \'./gates/orchestrator.ts\'; ' +
      'writeWorkflowState(\'WORK_DIR/workflow-state.json\', STATE);"',
    '',
    'Bash, Read and Edit are not blocked — only Skill calls are, so the repair ' +
      'above is reachable right now.',
  ].join('\n');
}

export function runGateEnforcement(input: GateEnforcementInput): GateEnforcementResult {
  const scan = findWorkflowGateFailure(input.workDir);

  // #1155: the sweep was incomplete. Refuse rather than report a clean run we
  // did not observe — and refuse WHETHER OR NOT a failure was also readable.
  // Gating this on "found nothing" was the first draft's own instance of the
  // bug: a scan that missed a state and found a failure elsewhere reported a
  // complete result, and the unread state may hold the OUTCOME AC failure
  // that would have blocked on sight rather than nagged for three strikes.
  //
  // Skill-scoped, so the repair path stays open; and the strike counter is
  // left alone, because an unmeasured reading is not evidence that the gate
  // it was counting against has been fixed.
  if (scan.reading === 'UNMEASURED') {
    const alsoFound = scan.failureFromPartialScan;
    const reason = unmeasuredStateReason(scan.unmeasuredReasons, alsoFound);
    logSignal(input.signalsDir, input.signalsFile, {
      ts: new Date().toISOString(),
      type: 'gate_enforcement',
      reading: 'UNMEASURED',
      tool: input.toolName,
      action: input.toolName === 'Skill' ? 'block' : 'nag',
      reasons: scan.unmeasuredReasons,
      ...(alsoFound ? { partial_gate: alsoFound.gate, partial_issue: alsoFound.issue } : {}),
    });

    if (input.toolName === 'Skill') {
      return { stdout: JSON.stringify({ decision: 'block', reason }), action: 'block' };
    }
    return {
      stdout: ['<system-reminder>', `⚠️ ${reason}`, '</system-reminder>'].join('\n'),
      action: 'nag',
    };
  }

  // Narrowed to the MEASURED variant by the return above, so `failure` is
  // reachable here and only here.
  const wfFailure = scan.failure;

  if (!wfFailure) {
    if (existsSync(input.pendingFile)) {
      try {
        unlinkSync(input.pendingFile);
      } catch (err) {
        console.error(`[GateEnforcement] Could not clear ${input.pendingFile}: ${err}`);
      }
    }
    return { stdout: null, action: 'pass' };
  }

  const strikeCount = loadStrikeCount(input.pendingFile, wfFailure.issue, wfFailure.gate);
  const pending = buildGatePending(wfFailure, input.sessionId, strikeCount);
  const decision = makeEnforcementDecision(pending, input.toolName);

  if (decision.action === 'block') {
    logEnforcementSignal(
      input.signalsDir, input.signalsFile, pending, input.toolName, 'block', pending.strike_count,
    );
    return {
      stdout: JSON.stringify({ decision: 'block', reason: decision.reason }),
      action: 'block',
    };
  }

  if (input.toolName === 'Skill') {
    try {
      writeFileSync(
        input.pendingFile,
        JSON.stringify({ ...pending, strike_count: decision.newStrikeCount }, null, 2),
        'utf-8',
      );
    } catch (err) {
      console.error(`[GateEnforcement] Strike count write failed: ${err}`);
    }
  }

  logEnforcementSignal(
    input.signalsDir, input.signalsFile, pending, input.toolName, 'nag', decision.newStrikeCount,
  );
  logDocHygieneSignals(input.signalsDir, input.signalsFile, input.projectRoot);

  return { stdout: decision.reminder ?? null, action: 'nag' };
}

/**
 * SC-508: doc-hygiene findings ride along as signals for promotion tracking.
 * Best-effort by design — a hygiene scan failure must not block a tool call —
 * but it says so on stderr rather than vanishing.
 */
export function logDocHygieneSignals(
  signalsDir: string,
  signalsFile: string,
  projectRoot: string,
  check: typeof checkDocHygiene = checkDocHygiene,
): number {
  try {
    const result = check(projectRoot);
    if (result.pass) return 0;
    for (const finding of result.findings) {
      logSignal(signalsDir, signalsFile, {
        ts: new Date().toISOString(), type: 'doc-hygiene',
        checkId: finding.checkId, file: finding.file,
        level: finding.level, message: finding.message,
      });
    }
    return result.findings.length;
  } catch (err) {
    console.error(`[GateEnforcement] doc-hygiene signal sweep skipped: ${err}`);
    return 0;
  }
}
