import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, basename } from "path";

export interface AssembleResult {
  briefPath: string;
  acCount: number;
  contextFileCount: number;
  validated: boolean;
}

const BRIEF_POLICIES_PATH = join(
  process.env.HOME || "",
  ".claude",
  "skills",
  "ship",
  "brief-policies.json",
);

const REQUIRED_SECTIONS = ["Goal", "ACs", "Files", "Scope", "Verify"] as const;

export async function assembleBrief(opts: {
  slug: string;
  workDir: string;
  projectRoot: string;
}): Promise<AssembleResult> {
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

  const harness = loadProjectHarness(projectRoot);
  const projectContextDocs = extractContextDocs(harness);
  const hasAgents = existsSync(join(projectRoot, "AGENTS.md"));

  const sections: string[] = [];

  sections.push(buildContextSection(projectRoot));
  sections.push(buildSpecAlignment(state.governingSpec));
  sections.push(buildTaskSection(state.issueGoal, acs));
  if (state.issueType === "bug-fix" || state.issueType === "bug") {
    sections.push(buildRCASection(state.rca));
  }
  sections.push(buildGitProtocol(state.issue));
  sections.push(buildFilesSection(contextFiles));
  sections.push(buildScopeSection(scopeOut));
  sections.push(buildVerifySection(verifyCommands));
  sections.push(buildReportSection());

  const brief = sections.join("\n\n");
  const briefPath = join(workDir, "marcus-brief.md");
  writeFileSync(briefPath, brief);

  const validated = validateBrief(brief);

  const projectContextCount = projectContextDocs.length + (hasAgents ? 1 : 0);

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

function loadProjectHarness(projectRoot: string): Record<string, any> | null {
  const harnessPath = join(projectRoot, ".claude", "rungate.json");
  if (!existsSync(harnessPath)) return null;
  try {
    return JSON.parse(readFileSync(harnessPath, "utf-8"));
  } catch {
    return null;
  }
}

function extractContextDocs(harness: Record<string, any> | null): string[] {
  if (!harness?.contextDocs) return [];
  const docs = harness.contextDocs;
  const raw = Array.isArray(docs) ? docs : typeof docs === "object" ? Object.values(docs) as string[] : [];
  return raw.filter((p): p is string =>
    typeof p === "string" &&
    !p.includes("..") &&
    !p.startsWith("/") &&
    p.length > 0
  );
}

function buildContextSection(projectRoot: string): string {
  const lines = [
    "## Context (read first, in order)",
    `1. ${projectRoot}/CLAUDE.md (if exists)`,
    `2. ${projectRoot}/MODEL.md (PRIMARY — system flow, three rules, troubleshooting map)`,
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

  // Include contextDocs from rungate.json
  const harness = loadProjectHarness(projectRoot);
  const contextDocs = extractContextDocs(harness);
  for (const doc of contextDocs) {
    lines.push(`${idx}. ${projectRoot}/${doc}`);
    idx++;
  }

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

function buildFilesSection(contextFiles: Array<{ path: string; reason: string }>): string {
  const lines = ["## Files to read before touching anything"];

  if (contextFiles.length === 0) {
    lines.push("- (no context files specified)");
  } else {
    for (const cf of contextFiles) {
      lines.push(`- ${cf.path}${cf.reason ? " — " + cf.reason : ""}`);
    }
  }

  return lines.join("\n");
}

function buildScopeSection(scopeOut: string[]): string {
  const lines = ["## Scope — do NOT touch"];

  if (scopeOut.length === 0) {
    lines.push("- (no explicit scope boundaries — stay within task scope)");
  } else {
    for (const item of scopeOut) {
      lines.push(`- ${item}`);
    }
  }

  lines.push("- Never run `make rebuild` — DA does that");

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

function validateBrief(brief: string): boolean {
  let policies: any = null;
  if (existsSync(BRIEF_POLICIES_PATH)) {
    try {
      policies = JSON.parse(readFileSync(BRIEF_POLICIES_PATH, "utf-8"));
    } catch {
      // If policies can't be read, skip validation
    }
  }

  if (!policies?.policies?.marcus?.requiredPatterns) {
    // Fallback: check for required section headers
    for (const section of REQUIRED_SECTIONS) {
      const patterns: Record<string, RegExp> = {
        Goal: /(?:goal|objective|task)/i,
        ACs: /(?:acceptance criter|AC-|success criter)/i,
        Files: /(?:files to|files changed|file.*read)/i,
        Scope: /(?:scope.*not|do not touch|out of scope)/i,
        Verify: /(?:verify|verification)/i,
      };
      if (!patterns[section]?.test(brief)) return false;
    }
    return true;
  }

  for (const pattern of policies.policies.marcus.requiredPatterns) {
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
