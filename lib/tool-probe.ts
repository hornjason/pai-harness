/**
 * Asking whether an external tool is there, with three answers instead of one
 * (#626 AC-10, #597).
 *
 * `lib/compliance.ts` asked it with a boolean:
 *
 *     function checkToolAvailable(command, args): boolean {
 *       try {
 *         const result = Bun.spawnSync([command, ...args], { timeout: 5_000 });
 *         return result.exitCode === 0 || result.stdout.toString().length > 0;
 *       } catch { return false; }
 *     }
 *
 * `false` meant "the tool is not installed", "the tool is installed and the
 * probe failed", and "npx went to the registry and the registry was slow"
 * alike. That is the fail-open shape `.claude/rules/checks-must-be-able-to-fail.md`
 * opens with, in the place it costs the most: three Layer 1 compliance tests
 * go red or green in CI depending on whether `npx @reporails/cli version`
 * reaches the network, and the verdict cannot say which of the three happened
 * — proven on #597 by re-running an identical SHA red to green with no code
 * change.
 *
 * So the probe has three outcomes and a `reason`, and the boolean every
 * existing caller wants is derived from the outcome rather than being the
 * whole reading. A consumer that only needs "can I run this" keeps working;
 * a consumer that needs to report UNMEASURED now has something to report it
 * from.
 *
 * ## Why `absent` is decided by the spawn failing, not by an exit code
 *
 * A tool that is not on `PATH` makes `Bun.spawnSync` throw before any process
 * exists; a tool that is there and unhappy exits non-zero. Those are the two
 * facts, and they arrive by two different routes, which is what makes the
 * distinction honest rather than a reading of an exit code nobody standardised.
 *
 * `npx <pkg> version` is the awkward case and is deliberately NOT special-cased:
 * `npx` is always present, so an uninstalled package surfaces as `errored`, not
 * `absent`. That is the truth about what was observed — the probe ran and did
 * not succeed — and inventing `absent` from a parse of npx's stderr would be a
 * detector narrower than what it detects.
 */

/** The three things a probe can find. Ordered as they are reported. */
export const TOOL_PROBE_OUTCOMES = ["available", "absent", "errored"] as const;

export type ToolProbeOutcome = (typeof TOOL_PROBE_OUTCOMES)[number];

export interface ToolProbe {
  outcome: ToolProbeOutcome;
  /**
   * The old boolean, derived. Present so a caller that genuinely only needs
   * "can I run this" does not have to re-derive it — and so the collapse is
   * visible as a projection of the reading rather than as the reading itself.
   */
  available: boolean;
  /** The command probed, as it was asked for. */
  tool: string;
  /** The exit code, or null when no process ever existed. */
  exitCode: number | null;
  /** One line a log reader can act on. */
  reason: string;
}

export interface ToolProbeOptions {
  timeoutMs?: number;
}

/** The probe's own budget. A tool that cannot answer in five seconds is not ready to be used in a gate. */
export const TOOL_PROBE_TIMEOUT_MS = 5_000;

export function probeExternalTool(command: string, args: string[] = [], opts?: ToolProbeOptions): ToolProbe {
  const tool = [command, ...args].join(" ");
  let exitCode: number | null = null;
  let stdout = "";
  let stderr = "";

  try {
    const result = Bun.spawnSync([command, ...args], {
      timeout: opts?.timeoutMs ?? TOOL_PROBE_TIMEOUT_MS,
      stdout: "pipe",
      stderr: "pipe",
    });
    exitCode = typeof result.exitCode === "number" ? result.exitCode : null;
    stdout = result.stdout?.toString() ?? "";
    stderr = result.stderr?.toString() ?? "";
  } catch (e) {
    // No process was created at all. That is the one condition that means the
    // tool is not here, and it is why this branch is not merged with a
    // non-zero exit below.
    const message = e instanceof Error ? e.message : String(e);
    return {
      outcome: "absent",
      available: false,
      tool,
      exitCode: null,
      reason: `${command} is not on PATH: ${message.split("\n")[0]}`,
    };
  }

  if (exitCode === 0 || stdout.trim().length > 0) {
    return {
      outcome: "available",
      available: true,
      tool,
      exitCode,
      reason: `${tool} ran and answered (exit ${exitCode})`,
    };
  }

  return {
    outcome: "errored",
    available: false,
    tool,
    exitCode,
    reason:
      `${tool} ran and did not succeed (exit ${exitCode})` +
      (stderr.trim() ? `: ${stderr.trim().split("\n")[0].slice(0, 200)}` : "") +
      ` — the tool was reachable, so this is not the same as it being absent`,
  };
}
