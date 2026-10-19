/**
 * Evidence pre-validator — dry-runs AC evidence commands at SCOPE phase
 * to catch broken commands BEFORE Marcus runs.
 *
 * 70% of pipeline failures (14/20 non-first-pass runs) are caused by evidence
 * commands that fail at VERIFY time. This module catches them early.
 */

import { execSync } from "child_process";

import { normalizeGitRefs } from "./git-ref-normalizer";
import { satisfiabilityRefusal } from "./evidence-satisfiability";

// ── Types ────────────────────────────────────────────────────────────────

export interface ACInput {
  id: string;
  evidenceMethod?: {
    type?: string;
    command?: string;
  };
  threshold?: {
    op?: string;
    value?: string | number;
    unit?: string;
  };
}

/** The AC's own bar, recorded verbatim beside the output it will be judged against. */
export interface ACThresholdInput {
  op?: string;
  value?: string | number;
  unit?: string;
}

/**
 * Whether the baseline output is a value a threshold can be compared against.
 *
 * MEASURED means the command printed something that stands for a reading of
 * the tree. UNMEASURED means it did not — it printed nothing, or it printed
 * only the tool announcing itself. Those two states are the whole point: `0`,
 * `{}`, an empty string and `bun test v1.3.14 (d1632b29)` are all
 * indistinguishable from success, and UNMEASURED is not.
 */
export type BaselineVerdict = "MEASURED" | "UNMEASURED";

/**
 * What an AC's evidence command printed on the PRE-CHANGE tree, beside the
 * threshold it will later be judged against (#669).
 *
 * Both halves are persisted so neither has to be re-derived: the pre-change
 * tree stops existing the moment Marcus writes a line, so a reader asking
 * "what did this print before the work" had no way to find out that did not
 * involve a checkout.
 */
export interface ACBaseline {
  verdict: BaselineVerdict;
  /** The command's own output, verbatim and trimmed. Empty only when UNMEASURED. */
  output: string;
  /** Why the baseline is UNMEASURED. Null — and only null — when it is MEASURED. */
  reason: string | null;
  /** The AC's threshold as written. Null when the AC declares none. */
  threshold: ACThresholdInput | null;
  /**
   * Whether the PRE-CHANGE output already clears the bar.
   *
   * Null — and only null — when no comparison was made: an UNMEASURED
   * baseline is never reduced to one, and neither is a bar nothing can be
   * compared against. `false` would claim the comparison happened and missed,
   * which is a different fact and the one that hides a banner.
   */
  satisfiesThreshold: boolean | null;
}

export interface PrevalidationResult {
  id: string;
  status: "ok" | "broken" | "empty" | "skipped";
  /** The pre-change reading (#669). */
  baseline?: ACBaseline;
  autoFixed?: boolean;
  /**
   * The command as the AC was written, present only when `autoFixed` is.
   *
   * `fixedCommand` alone says what to run next and nothing about what was
   * wrong with what was there. Once the reading is persisted (#235), the
   * original is the only way a reader can tell a repaired command from one
   * that was always written that way.
   */
  originalCommand?: string;
  fixedCommand?: string;
  needsRewrite?: boolean;
  diagnostic?: string;
}

/** The verdicts a pre-validation reading can carry. UNMEASURED is one of them. */
export type PrevalidationVerdict = "PASS" | "FAIL" | "UNMEASURED";

/**
 * One pre-validation of one AC set, in the shape persisted at
 * `evidencePrevalidation` in workflow-state.json.
 */
export interface EvidencePrevalidationReading {
  verdict: PrevalidationVerdict;
  /** ISO timestamp of the measurement. */
  checkedAt: string;
  /** Per-AC results. Empty — and only empty — when the verdict is UNMEASURED. */
  acs: PrevalidationResult[];
  /**
   * The ids of the ACs classified `broken`, in the order they were measured.
   *
   * Derived from `acs`, never supplied — `EvidencePrevalidationSchema` refuses
   * a reading whose `broken` disagrees with its own results, so this cannot
   * drift into an independent claim.
   *
   * It exists because the gate's single refusal site,
   * `prevalidationViolations` in gates/workflow.test.ts, names the ACs to fix
   * out of exactly this key — and until #274 no writer produced it. Every
   * genuine FAIL therefore refused with "no broken AC ids were recorded", which
   * is true of the key and false of the reading: the per-AC results were right
   * there under `acs`. Fail-closed, so nothing shipped that should not have,
   * but a refusal the heal loop cannot act on costs a round and teaches
   * nothing, which is part of how #261 cost two.
   */
  broken: string[];
  /**
   * The ids whose PRE-CHANGE output already satisfied their own threshold
   * (#669).
   *
   * Derived from `acs` by `alreadySatisfiedIds`, the same binding the gate's
   * refusal reads, so the list the reading carries and the list the refusal
   * names cannot be two different answers to one question.
   */
  alreadySatisfied: string[];
  /** Why the reading is UNMEASURED. Null — and only null — when it is not. */
  reason: string | null;
}

// ── The pre-change baseline (#669) ──────────────────────────────────────

/**
 * A line that is a tool announcing itself rather than reporting anything.
 *
 * Deliberately narrow. The direction this is allowed to be wrong in is toward
 * MEASURED: a pattern that swallowed ordinary output would convert real
 * evidence into an absence, which is strictly worse than the state it
 * replaces. So the digits must be introduced by a literal `v` or the word
 * `version` — `3.14` on its own is a number somebody measured, and
 * `bun test v1.3.14 (d1632b29)` is not.
 */
const VERSION_BANNER =
  /^(?:[A-Za-z][\w.+-]*(?:[ \t]+[A-Za-z][\w.+-]*){0,2}[ \t]+)?(?:v|[Vv]ersion[ \t]+)\d+\.\d+(?:\.\d+)?[\w.+-]*(?:[ \t]*\([0-9a-f]{6,}\))?$/;

/**
 * Why this output is not a measurement, or null if it is.
 *
 * THE single binding that decides it, because two deciders answering one
 * question are behaviourally one and a mutation of either leaves the other
 * holding the case up (`.claude/rules/checks-must-be-able-to-fail.md`).
 *
 * The two unmeasured states carry DIFFERENT sentences on purpose. A command
 * that printed nothing and a command that printed only a banner are fixed by
 * different edits, so one shared reason would be a warning nobody can act on.
 */
export function baselineUnmeasuredReason(output: string | null): string | null {
  if (output === null) {
    return "the evidence command was not run, so there is no baseline output to read";
  }
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return "the command ran and printed nothing, so there is no value to compare against the threshold";
  }
  const lines = trimmed.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.every((l) => VERSION_BANNER.test(l))) {
    return (
      `the only output is a tool version banner (${lines.join(" / ")}), which is the tool ` +
      "announcing itself and not a reading of the tree"
    );
  }
  return null;
}

/**
 * Does this output clear this bar? Null when no comparison could be made.
 *
 * Null rather than false for an uncomparable pair, because `false` says the
 * bar was tested and missed — a claim about the tree — while null says nobody
 * could test it. Collapsing the two is how an AC with a nonsense threshold
 * reads as an AC that simply has not landed yet.
 */
export function thresholdSatisfiedBy(
  output: string,
  threshold: ACThresholdInput | null | undefined,
): boolean | null {
  const op = threshold?.op;
  if (!op) return null;
  const text = output.trim();
  if (op === "exists") return text.length > 0;
  if (op === "contains") {
    if (threshold?.value === undefined || threshold.value === null) return null;
    return text.includes(String(threshold.value));
  }
  const expected = parseFloat(String(threshold?.value));
  const actual = parseFloat(text);
  if (Number.isNaN(expected) || Number.isNaN(actual) || !/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  switch (op) {
    case ">=": return actual >= expected;
    case "<=": return actual <= expected;
    case ">": return actual > expected;
    case "<": return actual < expected;
    case "==": return actual === expected;
    case "!=": return actual !== expected;
    default: return null;
  }
}

/**
 * Compose one AC's pre-change baseline from what its command printed.
 *
 * One site, so the ordering is not re-decided anywhere: the output is
 * classified FIRST, and only a MEASURED output is ever handed to the
 * comparison. That ordering is the whole of #669's third criterion — an
 * UNMEASURED baseline is never reduced to a threshold comparison, and the
 * only way to guarantee that is to make the comparison unreachable from the
 * unmeasured branch rather than to check afterwards that it did not happen.
 *
 * `output` is null when the command never ran at all.
 */
export function acBaseline(
  output: string | null,
  threshold: ACThresholdInput | null | undefined,
): ACBaseline {
  const recorded = threshold ? { ...threshold } : null;
  const reason = baselineUnmeasuredReason(output);
  if (reason !== null) {
    return {
      verdict: "UNMEASURED",
      output: (output ?? "").trim(),
      reason,
      threshold: recorded,
      satisfiesThreshold: null,
    };
  }
  const text = (output as string).trim();
  return {
    verdict: "MEASURED",
    output: text,
    reason: null,
    threshold: recorded,
    satisfiesThreshold: recorded ? thresholdSatisfiedBy(text, recorded) : null,
  };
}

/**
 * The ids whose PRE-CHANGE output already clears their own threshold.
 *
 * An AC in this list cannot observe the work: its command printed a
 * satisfying value before a line was written, so it will print one afterwards
 * whatever Marcus does. That is a check that cannot fail, arriving in the
 * harness's own acceptance criteria.
 *
 * Exported and called by BOTH the writer (`measureEvidencePrevalidation`) and
 * the reader (`prevalidationViolations` in gates/workflow.test.ts), so there
 * is one binding to mutate. `broken` taught this at the cost of a heal round:
 * until #295 the reader derived its own answer, disagreed with the writer, and
 * the refusal named nothing.
 */
export function alreadySatisfiedIds(acs: unknown): string[] {
  if (!Array.isArray(acs)) return [];
  return acs
    .filter((ac: unknown) => (ac as { baseline?: ACBaseline })?.baseline?.satisfiesThreshold === true)
    .map((ac: unknown) => String((ac as { id?: unknown })?.id ?? ""))
    .filter((id: string) => id.length > 0);
}

// ── Auto-fix patterns ───────────────────────────────────────────────────

/**
 * Does this command's non-zero exit mean "grep selected no lines" (#271)?
 *
 * `grep` documents three outcomes: 0 if a line was selected, 1 if none was,
 * and greater than 1 if an error occurred. Exit 1 is a RESULT — and for a
 * zero-count acceptance criterion it is the result that satisfies the
 * threshold. Run wf_ea3e428f-64f was refused because its AC printed `0`, the
 * exact value its `== 0` threshold required, and exited 1.
 *
 * This replaces an auto-fix that appended `|| true`. That wrapper swallowed
 * exit 2 as well, turning a missing file or a bad pattern into a clean
 * verdict, so reading grep's own convention is strictly narrower than what it
 * replaces rather than a wider amnesty.
 *
 * Only the LAST pipeline stage is consulted, because that is the one whose
 * status the shell reports. A grep earlier in the chain must not excuse a
 * later command's failure, or any command could buy amnesty by mentioning
 * grep.
 */
export function grepNoMatchIsResult(command: string, exitCode: number): boolean {
  if (exitCode !== 1) return false;
  const lastStage = command.split("|").pop()?.trim() ?? "";
  return /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:[a-z]*grep)\b/.test(lastStage);
}

/**
 * Detect if a command pipes bun test output through grep.
 * This loses exit codes and is fragile. Rewrite to direct bun test.
 */
function tryFixBunTestPipe(command: string): string | null {
  const match = command.match(/^(bun test\s+\S+)\s*\|.*$/);
  if (match) {
    // Strip the pipe and use direct bun test
    return match[1].trim();
  }
  return null;
}

/**
 * Attempt auto-fix on a command. Returns the fixed command or null.
 */
function attemptAutoFix(
  command: string,
  evidenceType: string | undefined,
  exitCode: number,
  stdout: string,
): { fixedCommand: string } | null {
  // The grep exit-1 pattern used to live here, rewriting the command to
  // `... || true`. It is gone (#271): a zero-match grep is now CLASSIFIED as a
  // result rather than repaired into one that cannot fail. Rewriting it hid
  // exit 2 — a missing file or a bad pattern — behind the same clean verdict.
  // See grepNoMatchIsResult.

  // Pattern 2: bun test piped through grep — rewrite to direct bun test
  const pipeFix = tryFixBunTestPipe(command);
  if (pipeFix) return { fixedCommand: pipeFix };

  return null;
}

// ── Core function ────────────────────────────────────────────────────────

/**
 * Dry-run every AC evidence command and return per-AC validation results.
 *
 * For each AC with an evidenceMethod.command:
 * - Runs the command with a short timeout
 * - Classifies result as ok, broken, empty, or skipped
 * - Attempts auto-fix for known broken patterns
 * - Sets needsRewrite when auto-fix cannot repair
 */
export async function prevalidateEvidence(
  acs: ACInput[],
  projectRoot: string,
): Promise<PrevalidationResult[]> {
  const results: PrevalidationResult[] = [];

  for (const ac of acs) {
    const rawCommand = ac.evidenceMethod?.command;

    // Skip ACs without a command.
    //
    // It still carries a baseline (#669), and the baseline still says why
    // there is nothing in it. A missing `baseline` key and a command that
    // produced no value read identically to every consumer, which is the
    // confusion this field exists to remove.
    if (!rawCommand) {
      results.push({
        id: ac.id,
        status: "skipped",
        baseline: acBaseline(null, ac.threshold),
      });
      continue;
    }

    // Qualify bare `main`/`master` refs to `origin/...` BEFORE anything else,
    // including before the dry-run (#118).
    //
    // This is deliberately NOT an entry in attemptAutoFix, which only fires on
    // a FAILING dry-run. A stale-`main` command often succeeds here — the local
    // ref is only sometimes behind — and then fails at Verify, which is exactly
    // what happened on #103: a false FAIL on an untouched file spawned a second
    // Marcus to "fix" it and cost roughly 300k tokens. The defect is in the
    // text of the command, not in its exit code, so the repair has to be too,
    // and it has to happen before the command is dry-run or persisted.
    const refFix = normalizeGitRefs(rawCommand);
    const command = refFix.command;
    const refRewritten = refFix.changed;

    /**
     * Carry the ref rewrite onto whatever verdict this AC ends up with.
     *
     * Every exit path has to go through here. If the rewrite were only
     * reported on the paths that already set `fixedCommand`, a command that
     * dry-runs clean would be reported "ok" with no fixed form, the caller
     * would persist the original, and the stale ref would reach Verify intact
     * — the bug surviving its own fix.
     */
    const withRefFix = (r: PrevalidationResult): PrevalidationResult =>
      refRewritten && !r.fixedCommand
        ? { ...r, autoFixed: true, fixedCommand: command }
        : r;

    /**
     * Every exit path for this AC goes through here, so an auto-fix cannot be
     * reported without the command it replaced (#235). Stamping it at the
     * single push site rather than at each branch is what keeps a later
     * auto-fix pattern from quietly landing with only half the pair.
     */
    /**
     * What the command printed on this tree, or null if it never ran (#669).
     *
     * Captured per AC and read by `record` so the baseline is composed at the
     * SINGLE push site. Stamping it at each branch instead would let a later
     * classification land with the pre-change reading quietly missing, which
     * is the half-pair problem `originalCommand` already has a comment about.
     */
    let printed: string | null = null;

    const record = (r: PrevalidationResult): void => {
      const withBaseline: PrevalidationResult = {
        ...r,
        baseline: acBaseline(printed, ac.threshold),
      };
      results.push(withBaseline.autoFixed ? { ...withBaseline, originalCommand: rawCommand } : withBaseline);
    };

    // Check for bun test pipe pattern BEFORE running — always auto-fix
    const pipeFix = tryFixBunTestPipe(command);

    /**
     * Refuse an AC whose command could not satisfy its threshold under ANY
     * implementation, BEFORE dry-running it (#217).
     *
     * Before the dry-run because the dry-run cannot see this. Measured on
     * `wf_5e3ed885-98c`: `grep -n 'SC-\w+' …` is a basic regular expression
     * whose `+` is a literal, so it selects nothing and dry-runs as `empty` —
     * a WARNING, and the same reading a correct AC produces before the work
     * is done. `grep -c … | wc -l` is worse: it prints `1`, dry-runs `ok`,
     * and the threshold it satisfies is then a constant.
     *
     * This is the inverse of the defect `.claude/rules/checks-must-be-able-to-fail.md`
     * is about, and it is the same defect: a verdict independent of the code.
     *
     * Judged on the command that will actually RUN, not the one as written —
     * after the ref rewrite and after the bun-test-pipe fix. Both change the
     * text, and the pipe fix changes whether the threshold is coherent at
     * all: `bun test … | grep -c pass` with `contains` is an incoherent pair
     * that the fix resolves by deleting the `grep -c`. Refusing the written
     * form would refuse a command the pre-validator was about to repair.
     */
    const unsatisfiable = satisfiabilityRefusal({
      ...ac,
      evidenceMethod: { ...ac.evidenceMethod, command: pipeFix ?? command },
    });
    if (unsatisfiable) {
      record(withRefFix({
        id: ac.id,
        status: "broken",
        needsRewrite: true,
        diagnostic: `The evidence cannot satisfy its own threshold: ${unsatisfiable}`,
      }));
      continue;
    }

    if (pipeFix) {
      record({
        id: ac.id,
        status: "ok",
        autoFixed: true,
        fixedCommand: pipeFix,
      });
      continue;
    }

    try {
      const output = execSync(command, {
        encoding: "utf-8",
        timeout: 10000,
        cwd: projectRoot,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      printed = output;

      if (output.length === 0) {
        record(withRefFix({
          id: ac.id,
          status: "empty",
          diagnostic: `Command succeeded but produced no output: ${command}`,
        }));
      } else {
        // The ok path is the one that MATTERS for #118: a stale-`main` command
        // usually dry-runs clean here and only diverges later, in a worktree
        // whose local ref has drifted. Without withRefFix the caller would
        // persist the original and the rewrite would be a no-op in exactly the
        // case it exists for.
        record(withRefFix({
          id: ac.id,
          status: "ok",
        }));
      }
    } catch (e: any) {
      const exitCode: number = e.status ?? 1;
      const stdout = (e.stdout?.toString?.() || "").trim();
      const stderr = (e.stderr?.toString?.() || "").trim();
      // A command that exited non-zero still ran, so its stdout is the
      // baseline reading. `grep` exit 1 is the case that matters: it is a
      // RESULT (#271), and the value it measured is in stdout.
      printed = stdout;

      // A grep that selected nothing has not failed — it has measured zero
      // (#271). Classified here, before any repair is attempted, so the
      // verdict comes from grep's documented contract rather than from a
      // rewrite. `grep -c` prints "0", a real value; plain `grep` prints
      // nothing, which is `empty` — the status that already exists for a
      // command that ran and produced no value. Collapsing that into "ok"
      // would hand the gate an AC with no evidence, which is #277.
      if (grepNoMatchIsResult(command, exitCode)) {
        record(withRefFix({
          id: ac.id,
          ...(stdout.length === 0
            ? {
                status: "empty" as const,
                diagnostic: `Command selected no lines and printed nothing: ${command}`,
              }
            : { status: "ok" as const }),
        }));
        continue;
      }

      // Try auto-fix first
      const fix = attemptAutoFix(command, ac.evidenceMethod?.type, exitCode, stdout);

      if (fix) {
        // fix.fixedCommand is derived from `command`, which is already
        // ref-normalized, so the rewrite is carried without needing withRefFix.
        record({
          id: ac.id,
          status: "ok",
          autoFixed: true,
          fixedCommand: fix.fixedCommand,
        });
      } else {
        // Cannot auto-fix — mark as broken with diagnostic
        const diagParts: string[] = [];
        diagParts.push(`Command failed with exit code ${exitCode}`);
        if (stderr) diagParts.push(stderr.slice(0, 200));
        if (!stdout && !stderr) diagParts.push(`No output from: ${command}`);

        record(withRefFix({
          id: ac.id,
          status: "broken",
          needsRewrite: true,
          diagnostic: diagParts.join(". "),
        }));
      }
    }
  }

  return results;
}

// ── The persisted reading (#235) ─────────────────────────────────────────

/**
 * Pre-validate an AC set and reduce it to one reading for workflow-state.json.
 *
 * NEVER THROWS, for the reason the rest of this path fails closed: it runs
 * inside the scope gate, and a throw there is a refusal the caller's error
 * handling turns back into "nothing to report". Before #235 the gate called
 * `prevalidateEvidence(...).then(...)` and swallowed rejections into a
 * `console.warn`, so a pre-validation that blew up and a pre-validation that
 * found nothing wrong left the state file in exactly the same condition:
 * empty. UNMEASURED is the third verdict that makes those two distinguishable.
 *
 * The runner is injectable so the UNMEASURED path can be driven in a test. The
 * default is the production one; nothing but a test should pass the third
 * argument.
 */
export async function measureEvidencePrevalidation(
  acs: ACInput[],
  projectRoot: string,
  run: (acs: ACInput[], projectRoot: string) => Promise<PrevalidationResult[]> = prevalidateEvidence,
): Promise<EvidencePrevalidationReading> {
  const checkedAt = new Date().toISOString();

  const unmeasured = (reason: string): EvidencePrevalidationReading => ({
    verdict: "UNMEASURED",
    checkedAt,
    acs: [],
    broken: [],
    alreadySatisfied: [],
    reason,
  });

  if (!Array.isArray(acs) || acs.length === 0) {
    return unmeasured(
      "the evidence commands were not pre-validated: this run has no ACs to measure, " +
        "so there is no verdict to read",
    );
  }

  let results: PrevalidationResult[];
  try {
    results = await run(acs, projectRoot);
  } catch (e: any) {
    return unmeasured(
      `the evidence commands were not pre-validated: the pre-validator threw — ${
        e?.message ? String(e.message).slice(0, 300) : String(e)
      }`,
    );
  }

  if (!Array.isArray(results)) {
    return unmeasured(
      `the evidence commands were not pre-validated: the pre-validator returned ${typeof results}, not a list of results`,
    );
  }

  // `empty` is a warning rather than a refusal — the command runs, it just
  // prints nothing — so only `broken` moves the verdict. Both still reach the
  // file, which is the point: a warning that lives in stdout is a warning no
  // later check can see.
  const broken = results.filter((r) => r.status === "broken");

  return {
    verdict: broken.length > 0 ? "FAIL" : "PASS",
    checkedAt,
    acs: results,
    // Mapped from the same filter the verdict is derived from, at the single
    // site that derives it, so the verdict and the names it refuses under
    // cannot disagree.
    broken: broken.map((r) => r.id),
    // Same discipline as `broken`, through the binding the gate reads (#669).
    alreadySatisfied: alreadySatisfiedIds(results),
    reason: null,
  };
}
