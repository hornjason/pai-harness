import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { plantCanaries, getDefaultCanaries } from "../lib/canary.js";
import { tryLoadRungateConfig } from "../lib/config-loader";
import {
  classifyContextDoc, classifyContextDocs, contextDocLines, contextDocNotes, hasBriefUnsafeChars,
  type ContextDocVerdict,
} from "../lib/context-docs";

// ── Gate contract interfaces (SC-373) ─────────────────────────────────────

export interface AssembleBriefInput {
  slug: string;
  workDir: string;
  projectRoot: string;
}

export interface AssembleResult {
  briefPath: string;
  acCount: number;
  contextFileCount: number;
  validated: boolean;
}

/**
 * The brief policies as the package ships them.
 *
 * #1174: this was `$HOME/.claude/skills/ship/brief-policies.json` and nothing
 * else — a path that exists on exactly one machine — while the
 * `config/brief-policies.json` the tarball actually carries was never read.
 * "A control that can only run on one laptop is the same fail-open as #140",
 * which is what `lib/issue-closure-audit.ts` says about its own
 * `~/.rungate/{slug}/run/`.
 *
 * Resolved from this module's own location, so it follows the package to
 * wherever it is installed. `lib/package-closure.ts` reads this expression
 * statically and fails the suite if `config/` ever leaves `files[]`.
 */
const PACKAGED_BRIEF_POLICIES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "config",
  "brief-policies.json",
);

/** A local edit layered over the shipped policies. Absent is the normal case. */
const BRIEF_POLICIES_OVERRIDE = join(
  process.env.HOME || "",
  ".claude",
  "skills",
  "ship",
  "brief-policies.json",
);

export async function assembleBrief(opts: AssembleBriefInput): Promise<AssembleResult> {
  const { slug, workDir, projectRoot } = opts;

  const sf = join(workDir, "workflow-state.json");
  if (!existsSync(sf)) {
    throw new Error(`workflow-state.json not found at ${sf}`);
  }

  const state = JSON.parse(readFileSync(sf, "utf-8"));
  const acs: any[] = state.acs || [];

  const contextFiles = deduplicateContextFiles(acs);
  const verifyCommands = extractVerifyCommands(acs);
  const scopeOut: string[] = state.scopeOut || [];

  // #439: through the one loader, so a project on the DIRECTORY layout is
  // read, and so a malformed config THROWS rather than reading as absent.
  // The previous `catch { return null }` turned a trailing comma into "no
  // docs declared" — `.claude/rules/config-access.md` names both.
  //
  // #311 SC-A9 asks for the THROWING loader here, per ADR-001 D2's caller
  // table ("a gate run without config is meaningless, not degraded"). It is
  // NOT used, and the conflict is recorded rather than resolved quietly.
  //
  // ADR-001 predates #439, which shipped SC-1614 — *malformed config throws;
  // absent config does not* — with the two halves asserted separately
  // precisely so nobody could conflate them again. Throwing here conflates
  // them from the other direction: an unscaffolded project and a project with
  // a trailing comma would once more produce one outcome, which is the
  // corollary ADR-001 itself exists to defend. SC-1617 pins this call in
  // source text for the same reason.
  //
  // The worry behind SC-A9 is real — a silently empty context section reads
  // like a project that declared no docs. It is not answered by throwing; it
  // is answered by the brief SAYING so, which is #497's question and not
  // this issue's.
  const harness = tryLoadRungateConfig(projectRoot);
  const projectContextDocs = classifyContextDocs(projectRoot, harness?.contextDocs);
  const hasAgents = existsSync(join(projectRoot, "AGENTS.md"));

  const sections: string[] = [];

  sections.push(buildContextSection(projectRoot, projectContextDocs));
  sections.push(buildSpecAlignment(state.governingSpec));
  sections.push(buildTaskSection(state.issueGoal, acs));
  if (state.issueType === "bug-fix" || state.issueType === "bug") {
    sections.push(buildRCASection(state.rca));
  }
  sections.push(buildGitProtocol(state.issue));
  sections.push(buildFilesSection(projectRoot, contextFiles));
  sections.push(buildScopeSection(scopeOut, harness?.forbiddenCommands));
  sections.push(buildVerifySection(verifyCommands));
  sections.push(buildReportSection());

  let brief = sections.join("\n\n");

  // Plant canary values in the brief for behavioral verification (D-5, SC-409)
  const canaries = getDefaultCanaries().filter((c) => c.location === "brief");
  if (canaries.length > 0) {
    const { brief: briefWithCanaries, planted } = plantCanaries(brief, canaries);
    brief = briefWithCanaries;
    writeFileSync(join(workDir, "canaries.json"), JSON.stringify(planted.map(c => ({
      id: c.id, phrase: c.phrase, location: c.location,
    })), null, 2));
  }

  const briefPath = join(workDir, "marcus-brief.md");
  writeFileSync(briefPath, brief);

  const validated = validateBrief(brief);

  const projectContextCount =
    projectContextDocs.filter(d => d.kind === "included").length + (hasAgents ? 1 : 0);

  return {
    briefPath,
    acCount: acs.length,
    contextFileCount: contextFiles.length + projectContextCount,
    validated,
  };
}

function deduplicateContextFiles(acs: any[]): Array<{ path: string; reason: string }> {
  const seen = new Set<string>();
  const result: Array<{ path: string; reason: string }> = [];

  for (const ac of acs) {
    for (const cf of ac.contextFiles || []) {
      if (!seen.has(cf.path)) {
        seen.add(cf.path);
        result.push({ path: cf.path, reason: cf.reason || "" });
      }
    }
  }

  return result;
}

function extractVerifyCommands(acs: any[]): string[] {
  const commands: string[] = [];
  for (const ac of acs) {
    const cmd = ac.evidenceMethod?.command;
    if (cmd) commands.push(cmd);
  }
  return commands;
}

// `loadProjectHarness` and `extractContextDocs` were deleted in #439. The
// first read `.claude/rungate.json` directly and swallowed parse errors; the
// second filtered out absolute and traversing paths with no record that it
// had. `lib/config-loader.ts` and `lib/context-docs.ts` own those now, and
// each owns it once.

function buildContextSection(projectRoot: string, docs: ContextDocVerdict[]): string {
  const lines = [
    "## Context (read first, in order)",
    `1. ${projectRoot}/CLAUDE.md (if exists)`,
    // "(if exists)" like entry 1, and for the same reason (#272). This said
    // PRIMARY with no qualifier while entries 3 and 4 were both conditional on
    // its absence — so in a project without MODEL.md, which includes this one,
    // the list opened by naming a missing file as the primary source.
    `2. ${projectRoot}/MODEL.md (if exists; PRIMARY when present — system flow, three rules, troubleshooting map)`,
    `3. ${projectRoot}/PRINCIPLES.md (ONLY if MODEL.md doesn't exist)`,
    `4. ${projectRoot}/ARCHITECTURE.md (ONLY if MODEL.md doesn't exist)`,
  ];

  let idx = 5;

  // Include AGENTS.md from project repo when present
  const agentsPath = join(projectRoot, "AGENTS.md");
  if (existsSync(agentsPath)) {
    lines.push(`${idx}. ${projectRoot}/AGENTS.md (agent role definitions)`);
    idx++;
  }

  // contextDocs, classified rather than filtered: every declared entry either
  // appears here or is named in the notes below. Nothing is dropped silently.
  lines.push(...contextDocLines(docs, idx));
  lines.push(...contextDocNotes(docs));

  return lines.join("\n");
}

function buildSpecAlignment(governingSpec?: { path: string; detectedFrom?: string }): string {
  if (!governingSpec) {
    return [
      "## Spec Alignment",
      "- **Governing spec:** None detected",
      "- **Verified no contradiction:** N/A",
    ].join("\n");
  }

  return [
    "## Spec Alignment (MANDATORY)",
    `- **Governing spec:** ${governingSpec.path}`,
    `- **Detected from:** ${governingSpec.detectedFrom || "unknown"}`,
    "- **Verified no contradiction:** DA verified before brief generation",
  ].join("\n");
}

function buildTaskSection(issueGoal: string, acs: any[]): string {
  const lines = ["## Task", "", `**Goal:** ${issueGoal}`, ""];

  lines.push("### Acceptance Criteria", "");
  if (acs.length === 0) {
    lines.push("- (no acceptance criteria defined yet)");
  } else {
    for (const ac of acs) {
      const threshold = ac.threshold
        ? ` (${ac.threshold.op} ${ac.threshold.value}${ac.threshold.unit ? " " + ac.threshold.unit : ""})`
        : "";
      lines.push(`- **${ac.id}** [${ac.type || "CODE"}]: ${ac.statement}${threshold}`);
    }
  }

  return lines.join("\n");
}

function buildGitProtocol(issue: number): string {
  return [
    "## Git protocol",
    `- Branch: \`${issue}-deep-modules\` (create from main if not in a worktree)`,
    "- Before committing, rebase onto latest main",
    "- Commit all changes before reporting back",
    "- Push with `-u` before reporting",
    "- Never commit to main directly, never force push",
  ].join("\n");
}

function buildFilesSection(
  projectRoot: string,
  contextFiles: Array<{ path: string; reason: string }>,
): string {
  const lines = ["## Files to read before touching anything"];

  if (contextFiles.length === 0) {
    lines.push("- (no context files specified)");
  } else {
    for (const cf of contextFiles) {
      // The same classifier `contextDocs` uses, not a second copy of its
      // rules (#497). These paths come from the AC schema and had no
      // filtering of any kind before BUG-439-A, and an externality control on
      // one of the two doors into a brief is the thing #439 correctly said
      // the old filter was not.
      //
      // The reason string goes through the character predicate separately:
      // it is rendered on the same line and the classifier only sees paths.
      const verdict = classifyContextDoc(projectRoot, cf.path);
      if (verdict.kind === "rejected") {
        lines.push(`- (REJECTED ${JSON.stringify(cf.path)}: ${verdict.reason})`);
        continue;
      }
      if (hasBriefUnsafeChars(cf.reason ?? "")) {
        lines.push(`- (REJECTED ${JSON.stringify(cf.path)}: its reason contains a newline or control character)`);
        continue;
      }
      // Rendered as declared, not as resolved: these are repo-relative paths
      // an agent is meant to recognise, and rewriting them to absolute would
      // change every existing brief for no gain.
      lines.push(`- ${cf.path}${cf.reason ? " — " + cf.reason : ""}`);
    }
  }

  return lines.join("\n");
}

function buildScopeSection(scopeOut: string[], forbiddenCommands?: string[]): string {
  const lines = ["## Scope — do NOT touch"];

  if (scopeOut.length === 0) {
    lines.push("- (no explicit scope boundaries — stay within task scope)");
  } else {
    for (const item of scopeOut) {
      lines.push(`- ${item}`);
    }
  }

  // #343: this said "Never run `make rebuild`" — one consumer's forbidden
  // command, written into every consumer's brief. The command comes from the
  // consumer's own `forbiddenCommands` now, and nothing is emitted when none
  // is configured. A guessed prohibition in a brief is worse than silence:
  // the agent obeys it, and nobody finds out it was invented.
  for (const cmd of forbiddenCommands ?? []) {
    lines.push(`- Never run \`${cmd}\` — the DA runs it, not you`);
  }
  // Harness-general, not consumer-specific: these files are DA-owned for
  // every project, because parallel worktrees each writing their own copy
  // produce conflicting state (#296).
  lines.push("- Never modify `project-state.json` or `PROJECT-STATE.md` — DA manages these");

  return lines.join("\n");
}

function buildVerifySection(commands: string[]): string {
  const lines = ["## Verify"];

  if (commands.length === 0) {
    lines.push("- `bunx tsc --noEmit`");
  } else {
    for (const cmd of commands) {
      lines.push(`- \`${cmd}\``);
    }
    lines.push("- `bunx tsc --noEmit`");
  }

  return lines.join("\n");
}

function buildRCASection(rca?: { rootCause?: string; prediction?: string; predictionVerified?: boolean }): string {
  return [
    "## Root Cause Analysis (bug-fix)",
    `- **Root cause:** ${rca?.rootCause || "(investigate and fill)"}`,
    `- **Prediction:** ${rca?.prediction || "(what will the fix change?)"}`,
    `- **Prediction verified:** ${rca?.predictionVerified ?? "(verify after fix)"}`,
  ].join("\n");
}

export interface JourneyStep {
  action: string;
  wait_for?: string;
  assertion?: { type: string; target?: string; expected?: string };
  on_fail?: string;
}

export const MAX_JOURNEY_STEPS = 8;

export function validateJourneySteps(steps: JourneyStep[]): { valid: boolean; splitRequired: boolean } {
  if (steps.length <= MAX_JOURNEY_STEPS) return { valid: true, splitRequired: false };
  return { valid: false, splitRequired: true };
}

export function splitJourney(steps: JourneyStep[]): JourneyStep[][] {
  const chunks: JourneyStep[][] = [];
  for (let i = 0; i < steps.length; i += MAX_JOURNEY_STEPS) {
    chunks.push(steps.slice(i, i + MAX_JOURNEY_STEPS));
  }
  return chunks;
}

function buildReportSection(): string {
  return [
    "## Report back",
    "For each acceptance criterion, provide evidence:",
    "- AC-N: → file.ts:L## [description] (code presence)",
    "- AC-N: → grep: \"pattern\" returned N matches (absence/presence)",
    "- AC-N: → test: test-name PASS (test-verified)",
    "Plus: files changed (paths + line numbers), test output, scope conflicts",
  ].join("\n");
}

/**
 * Shipped policies, with the `$HOME` copy layered over them when it exists.
 *
 * Deliberately unguarded. The previous reader wrapped the parse in `catch {}`
 * and fell through to a hardcoded second copy of the patterns, so a trailing
 * comma in the policy file read as "no policies" and the brief was then
 * reported `validated: true` — UNMEASURED passing itself off as a pass.
 * `.claude/rules/config-access.md` names that Silent Default Substitution and
 * is explicit that a corrupt config is never a missing config.
 */
export function loadBriefPolicies(): any {
  if (!existsSync(PACKAGED_BRIEF_POLICIES)) {
    throw new Error(
      `brief policies not found at ${PACKAGED_BRIEF_POLICIES}. The package ships ` +
        `config/brief-policies.json; an installation without it cannot validate a brief, ` +
        `and UNMEASURED refuses rather than passing.`,
    );
  }
  const shipped = JSON.parse(readFileSync(PACKAGED_BRIEF_POLICIES, "utf-8"));
  if (!existsSync(BRIEF_POLICIES_OVERRIDE)) return shipped;

  // Per agent type, so an override naming only `marcus` does not delete the
  // shipped `quinn` and `rook` entries.
  const override = JSON.parse(readFileSync(BRIEF_POLICIES_OVERRIDE, "utf-8"));
  return {
    ...shipped,
    ...override,
    policies: { ...shipped.policies, ...override.policies },
  };
}

function validateBrief(brief: string): boolean {
  return validateBriefAgainst(brief, loadBriefPolicies());
}

/**
 * Split from the loader so the refusal below has an input a test can hand it.
 * A refusal nothing can reach is a refusal nobody has watched fire — see
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 */
export function validateBriefAgainst(brief: string, policies: any): boolean {
  const required = policies?.policies?.marcus?.requiredPatterns;

  // An empty policy set validates every brief, which is indistinguishable
  // from not validating at all — the exact state the issue asks be refused.
  if (!Array.isArray(required) || required.length === 0) {
    throw new Error(
      `brief policies declare no requiredPatterns for "marcus". An empty policy set passes ` +
        `every brief and cannot be told apart from no validation at all, so this refuses.`,
    );
  }

  for (const pattern of required) {
    let p = pattern.pattern as string;
    let flags = "";
    if (p.startsWith("(?i)")) {
      p = p.slice(4);
      flags = "i";
    }
    const re = new RegExp(p, flags);
    if (!re.test(brief)) return false;
  }

  return true;
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);
  let slug = "", workDir = "", projectRoot = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--slug" && args[i + 1]) slug = args[++i];
    if (args[i] === "--work-dir" && args[i + 1]) workDir = args[++i];
    if (args[i] === "--project-root" && args[i + 1]) projectRoot = args[++i];
  }
  if (!slug || !workDir || !projectRoot) {
    console.error("Usage: bun run brief-assembler.ts --slug SLUG --work-dir DIR --project-root DIR");
    process.exit(1);
  }
  assembleBrief({ slug, workDir, projectRoot })
    .then(r => console.log(`Brief written: ${r.briefPath} (${r.acCount} ACs, validated=${r.validated})`))
    .catch(e => { console.error(e.message); process.exit(1); });
}
