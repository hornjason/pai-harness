/**
 * Evidence pre-validator — dry-runs AC evidence commands at SCOPE phase
 * to catch broken commands BEFORE Marcus runs.
 *
 * 70% of pipeline failures (14/20 non-first-pass runs) are caused by evidence
 * commands that fail at VERIFY time. This module catches them early.
 */

import { execSync } from "child_process";

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
  fixedCommand?: string;
  needsRewrite?: boolean;
  diagnostic?: string;
}

// ── Auto-fix patterns ───────────────────────────────────────────────────

/**
 * Detect if a command is a grep that exits 1 on zero matches.
 * Returns a wrapped version that exits 0 even on zero matches.
 */
function tryFixGrepExitCode(command: string): string | null {
  // Only fix bare grep commands (not piped chains)
  if (/\bgrep\b/.test(command) && !command.includes("|")) {
    // Wrap with || true to handle zero-match exit code 1
    return `${command} || true`;
  }
  return null;
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
  // Pattern 1: grep exit code 1 (zero matches) — wrap with || true
  if (exitCode === 1 && /\bgrep\b/.test(command)) {
    const fixed = tryFixGrepExitCode(command);
    if (fixed) return { fixedCommand: fixed };
  }

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
    const command = ac.evidenceMethod?.command;

    // Skip ACs without a command
    if (!command) {
      results.push({
        id: ac.id,
        status: "skipped",
      });
      continue;
    }

    // Check for bun test pipe pattern BEFORE running — always auto-fix
    const pipeFix = tryFixBunTestPipe(command);
    if (pipeFix) {
      results.push({
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
        results.push({
          id: ac.id,
          status: "empty",
          diagnostic: `Command succeeded but produced no output: ${command}`,
        });
      } else {
        results.push({
          id: ac.id,
          status: "ok",
        });
      }
    } catch (e: any) {
      const exitCode: number = e.status ?? 1;
      const stdout = (e.stdout?.toString?.() || "").trim();
      const stderr = (e.stderr?.toString?.() || "").trim();

      // Try auto-fix first
      const fix = attemptAutoFix(command, ac.evidenceMethod?.type, exitCode, stdout);

      if (fix) {
        results.push({
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

        results.push({
          id: ac.id,
          status: "broken",
          needsRewrite: true,
          diagnostic: diagParts.join(". "),
        });
      }
    }
  }

  return results;
}
