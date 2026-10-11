/**
 * Evidence pre-validator — dry-runs AC evidence commands at SCOPE phase
 * to catch broken commands BEFORE Marcus runs.
 *
 * 70% of pipeline failures (14/20 non-first-pass runs) are caused by evidence
 * commands that fail at VERIFY time. This module catches them early.
 */

import { execSync } from "child_process";

import { normalizeGitRefs } from "./git-ref-normalizer";

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

export interface PrevalidationResult {
  id: string;
  status: "ok" | "broken" | "empty" | "skipped";
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
  /** Why the reading is UNMEASURED. Null — and only null — when it is not. */
  reason: string | null;
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

    // Skip ACs without a command
    if (!rawCommand) {
      results.push({
        id: ac.id,
        status: "skipped",
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
    const record = (r: PrevalidationResult): void => {
      results.push(r.autoFixed ? { ...r, originalCommand: rawCommand } : r);
    };

    // Check for bun test pipe pattern BEFORE running — always auto-fix
    const pipeFix = tryFixBunTestPipe(command);
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
    reason: null,
  };
}
