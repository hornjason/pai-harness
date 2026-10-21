/**
 * Which tool names Claude Code actually knows, so a deny list denies things
 * that exist (#885).
 *
 * The CLI validates every `--allowedTools` / `--disallowedTools` entry at
 * startup and prints a warning for a name it does not recognise:
 *
 *     Permission deny rule "SlashCommand" matches no known tool — check for typos.
 *     Permission deny rule "MultiEdit" matches no known tool — check for typos.
 *
 * Then it carries on. So **a rule that matches no known tool is
 * indistinguishable from a rule that is holding** — eleven entries in a deny
 * list read as eleven denials, and two of them are inert. Nothing asserted
 * otherwise, which also means a tool renamed upstream silently turns its
 * denial off and the only trace is a line in a log nobody greps.
 *
 * ## The record, and how it was taken
 *
 * Measured 2026-10-21 against `claude 2.1.306`, with this command — no network
 * call is made, because the CLI validates the rules and then refuses the empty
 * prompt:
 *
 *     printf '' | claude -p --disallowedTools "<comma-separated names>"
 *
 * The candidate list probed was deliberately WIDER than anything this repo
 * emits. A record built only from the names we use would be the question
 * restated — `.claude/rules/checks-must-be-able-to-fail.md`'s #530 shape,
 * where the artifact agrees because you put the value in it. 35 names went in;
 * the 29 below came back known and 6 came back unknown.
 *
 * ## What this record is NOT
 *
 * It is not a claim about the CLI running in CI, which is a different version
 * (`v2.1.303` at the time of writing). It is a claim about the vocabulary on
 * the day and version named above, and `probePermissionRules` below is how a
 * machine with a CLI re-takes it. A tree with no `claude` on PATH gets
 * `UNMEASURED` from that probe and the static comparison from
 * `unknownAgainstRecord`, which is `.claude/rules/checks-must-be-able-to-fail.md`'s
 * split: enforce the half the repo owns, and make the other half say it did
 * not run.
 */

import { probeExternalTool, toolProbe, type ToolProbe } from "./tool-probe";

export const CLAUDE_TOOL_VOCABULARY_VERSION = "2.1.306";
export const CLAUDE_TOOL_VOCABULARY_MEASURED_ON = "2026-10-21";
export const CLAUDE_TOOL_VOCABULARY_COMMAND =
  `printf '' | claude -p --disallowedTools "<comma-separated names>"`;

/** Names the CLI resolved to a tool. Re-take with the command above. */
export const VERIFIED_KNOWN_TOOLS: ReadonlySet<string> = new Set([
  "Agent",
  "AskUserQuestion",
  "Bash",
  "BashOutput",
  "Edit",
  "EnterPlanMode",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "KillShell",
  "ListAgents",
  "ListMcpResources",
  "Monitor",
  "NotebookEdit",
  "Read",
  "ReadMcpResource",
  "ReportFindings",
  "ScheduleWakeup",
  "SendMessage",
  "Skill",
  "Task",
  "TaskList",
  "TaskStop",
  "TodoWrite",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
]);

/**
 * Names the CLI resolved to NOTHING, kept as data rather than deleted.
 *
 * This is the negative control the check needs, built from real readings
 * instead of a synthetic typo: "every name is known" passes over an empty
 * list, and a control made of names nobody writes proves only that the
 * comparison runs. These are names this project or its history actually used.
 *
 * `NotebookRead` and `LS` are retired tools, probed as controls alongside the
 * two the issue is about.
 */
export const VERIFIED_UNKNOWN_TOOLS: ReadonlySet<string> = new Set([
  "LS",
  "MultiEdit",
  "NotebookRead",
  "SlashCommand",
]);

/**
 * The tool a permission rule names, with any path spec removed.
 *
 * `Edit(./**)` is a rule about the `Edit` tool, and the CLI resolves the tool
 * name before it looks at the pattern. A check that compared the whole rule
 * text to the vocabulary would report every path-scoped rule as unknown — a
 * detector narrower than what it detects, arriving as a flood of false
 * positives rather than as silence.
 */
export function ruleToolName(rule: string): string {
  const open = rule.indexOf("(");
  return (open === -1 ? rule : rule.slice(0, open)).trim();
}

/**
 * The names in `rules` that the record does not vouch for, in order.
 *
 * One binding, so there is one thing to mutate. A name is vouched for only by
 * `VERIFIED_KNOWN_TOOLS`: membership of `VERIFIED_UNKNOWN_TOOLS` is NOT an
 * exemption, it is the record saying the opposite. The caller that keeps an
 * inert rule on purpose declares it where it keeps it, and says why.
 */
export function unknownAgainstRecord(rules: readonly string[]): string[] {
  return rules.map(ruleToolName).filter(name => !VERIFIED_KNOWN_TOOLS.has(name));
}

/** Every name the CLI complained about, in the order it complained. */
export function parseUnknownRuleWarnings(output: string): string[] {
  const out: string[] = [];
  for (const m of output.matchAll(/rule "([^"]+)" matches no known tool/g)) out.push(m[1]!);
  return out;
}

export interface PermissionRuleProbe {
  /** `MEASURED` only when a CLI ran and validated the rules. */
  reading: "MEASURED" | "UNMEASURED";
  /** Names this CLI did not recognise. Empty and meaningless when UNMEASURED. */
  unknown: string[];
  probe: ToolProbe;
}

/**
 * Ask the installed CLI which of `rules` it does not know.
 *
 * Takes no network: the CLI validates the rules, then refuses the empty prompt
 * and exits. A tree with no `claude` on PATH reads `UNMEASURED` — not an empty
 * `unknown` list, which is what a passing probe looks like.
 */
export function probePermissionRules(
  rules: readonly string[],
  opts?: { timeoutMs?: number; command?: string },
): PermissionRuleProbe {
  const command = opts?.command ?? "claude";
  const present = probeExternalTool(command, ["--version"], opts);
  if (!present.available) return { reading: "UNMEASURED", unknown: [], probe: present };

  const joined = rules.join(",");
  let output: string;
  try {
    const r = Bun.spawnSync([command, "-p", "--disallowedTools", joined], {
      stdin: new Blob([""]),
      stdout: "pipe",
      stderr: "pipe",
      timeout: opts?.timeoutMs ?? 30_000,
    });
    output = `${r.stdout?.toString() ?? ""}${r.stderr?.toString() ?? ""}`;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      reading: "UNMEASURED",
      unknown: [],
      probe: toolProbe({
        outcome: "errored",
        tool: `${command} -p --disallowedTools`,
        reason: `the rule validation run did not complete: ${message.split("\n")[0]}`,
      }),
    };
  }
  return {
    reading: "MEASURED",
    unknown: parseUnknownRuleWarnings(output),
    probe: toolProbe({
      outcome: "available",
      tool: `${command} -p --disallowedTools`,
      reason: `${command} validated ${rules.length} permission rule(s)`,
    }),
  };
}
