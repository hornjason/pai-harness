/**
 * organize.ts — Project organization tool
 *
 * Scans a project for unorganized markdown files, classifies them using
 * frontmatter, filename patterns, and content heuristics, and proposes
 * (or executes) moves into the correct directories.
 *
 * Directories: specs/, docs/research/, docs/adr/, docs/council/, docs/guides/, reference/
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  renameSync,
  mkdirSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "fs";
import { join, relative, dirname, basename } from "path";
import { loadComplianceConfig, type OrganizeExternalSource } from "./config-loader.js";
import { matchesAnyAlias, projectAliases } from "./project-aliases.js";
import { mayWrite, readDerivedDeclaration, skipLine } from "./derived-spec";

// ── Types ────────────────────────────────────────────────────────

export interface UnorganizedCandidate {
  /** Relative path from project root */
  source: string;
  /** Raw file content */
  content: string;
}

export interface ClassificationResult {
  /** Target directory (e.g. "specs", "docs/research", "docs/adr", "docs/council", "docs/guides", "reference") */
  targetDir: string;
  /** Human-readable classification label */
  classification: string;
  /** Why this classification was chosen */
  reasoning: string;
  /** Confidence score 0-1 */
  confidence: number;
}

export interface OrganizeProposal {
  /** Relative source path */
  source: string;
  /** Relative target path */
  target: string;
  /** Classification label */
  classification: string;
  /** Reasoning for the classification */
  reasoning: string;
  /** Confidence 0-1 */
  confidence: number;
}

export interface OrganizeOptions {
  /** If true, execute moves. If false, only return proposals */
  apply?: boolean;
  /** If true, only return proposals without executing */
  dryRun?: boolean;
  /** Path to the harness project root (for loading compliance.json config) */
  harnessRoot?: string;
}

/**
 * What a scan covered, and what it could not (#442).
 *
 * `scanExternalSources` had three fail-opens in one loop: a declared path
 * that is not on disk was `continue`d, an unreadable file was `catch {}`ed
 * into a non-match, and the whole directory walk sat inside another bare
 * `catch`. A user who declares where their documents live and is told
 * nothing when that place is not there has been given `0`, `{}` and `SKIP`
 * — which `.claude/rules/config-access.md` names as indistinguishable from
 * success. `UNMEASURED` is not.
 */
export interface OrganizeReport {
  proposals: OrganizeProposal[];
  /** Declared external paths that are not on disk. Named, not skipped. */
  unmeasured: string[];
  /** Paths that exist and could not be read. A non-match is not the answer. */
  unreadable: string[];
  /** The names matching was actually done against, so a miss is diagnosable. */
  aliases: string[];
}

// ── Well-known root files to skip ────────────────────────────────

const WELL_KNOWN_ROOT_FILES = new Set([
  "AGENTS.md",
  "README.md",
  "CLAUDE.md",
  "CHANGELOG.md",
  "CODE-MAP.md",
  "PROJECT-STATE.md",
  "CONTRIBUTING.md",
  "LICENSE.md",
  "ARCHITECTURE.md",
  "PRINCIPLES.md",
  "MODEL.md",
  "HARNESS.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
]);

// ── Standard directories ─────────────────────────────────────────

const STANDARD_DIRS = ["specs", "docs/research", "docs/adr", "docs/council", "docs/guides", "reference"];

// ── Classification doc-type to directory mapping ─────────────────

const DOC_TYPE_MAP: Record<string, string> = {
  spec: "specs",
  adr: "docs/adr",
  research: "docs/research",
  council: "docs/council",
  guide: "docs/guides",
  reference: "reference",
};

// ── Scan for unorganized files ───────────────────────────────────

export function scanUnorganized(root: string, fileTypes: string[] = [".md"]): UnorganizedCandidate[] {
  const candidates: UnorganizedCandidate[] = [];

  try {
    for (const f of readdirSync(root)) {
      const ext = f.substring(f.lastIndexOf(".")).toLowerCase();
      if (!fileTypes.includes(ext)) continue;
      if (WELL_KNOWN_ROOT_FILES.has(f)) continue;
      const fullPath = join(root, f);
      try {
        if (lstatSync(fullPath).isDirectory()) continue;
        if (ext === ".md") {
          const content = readFileSync(fullPath, "utf-8");
          candidates.push({ source: f, content });
        } else {
          candidates.push({ source: f, content: "" });
        }
      } catch {}
    }
  } catch {}

  return candidates;
}

// ── Classify a single document ───────────────────────────────────

export function classifyDocument(
  filename: string,
  content: string,
  artifactClassification: Record<string, string> = {},
): ClassificationResult {
  // 0. Non-markdown files: classify by extension from config
  const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();
  if (ext !== ".md" && artifactClassification[ext]) {
    return {
      targetDir: artifactClassification[ext],
      classification: "artifact",
      reasoning: `non-markdown file type ${ext} classified as ${artifactClassification[ext]} by config`,
      confidence: 0.85,
    };
  }

  // 1. Check frontmatter doc-type (highest confidence)
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const docTypeMatch = fmMatch[1].match(/doc-type:\s*(\S+)/);
    if (docTypeMatch) {
      const docType = docTypeMatch[1].trim();
      const targetDir = DOC_TYPE_MAP[docType];
      if (targetDir) {
        return {
          targetDir,
          classification: docType,
          reasoning: `frontmatter doc-type: ${docType}`,
          confidence: 0.95,
        };
      }
    }
  }

  // 2. Check filename patterns (high confidence)
  const nameUpper = filename.toUpperCase();

  if (/^ADR[-_]\d+/i.test(filename)) {
    return {
      targetDir: "docs/adr",
      classification: "adr",
      reasoning: `filename matches ADR pattern: ${filename}`,
      confidence: 0.9,
    };
  }

  if (nameUpper.includes("SPEC") && !nameUpper.includes("INSPECT")) {
    return {
      targetDir: "specs",
      classification: "spec",
      reasoning: `filename contains 'spec': ${filename}`,
      confidence: 0.85,
    };
  }

  if (nameUpper.includes("RESEARCH") || nameUpper.includes("EVAL") || nameUpper.includes("FINDINGS")) {
    return {
      targetDir: "docs/research",
      classification: "research",
      reasoning: `filename suggests research: ${filename}`,
      confidence: 0.8,
    };
  }

  if (nameUpper.includes("GUIDE") || nameUpper.includes("SETUP") || nameUpper.includes("ONBOARDING")) {
    return {
      targetDir: "docs/guides",
      classification: "guide",
      reasoning: `filename suggests guide: ${filename}`,
      confidence: 0.8,
    };
  }

  if (nameUpper.includes("COUNCIL") || nameUpper.includes("DEBATE") || nameUpper.includes("SYNTHESIS")) {
    return {
      targetDir: "docs/council",
      classification: "council",
      reasoning: `filename suggests council: ${filename}`,
      confidence: 0.8,
    };
  }

  // 3. Content heuristics (medium confidence)
  const contentLower = content.toLowerCase();

  // ADR heuristics: Decision + Status/Context/Consequences
  if (
    contentLower.includes("## decision") &&
    (contentLower.includes("## status") || contentLower.includes("## context") || contentLower.includes("## consequences"))
  ) {
    return {
      targetDir: "docs/adr",
      classification: "adr",
      reasoning: "content structure matches ADR pattern (Decision/Status/Context sections)",
      confidence: 0.7,
    };
  }

  // Spec heuristics: Success Criteria or Acceptance Criteria
  if (contentLower.includes("success criteria") || contentLower.includes("acceptance criteria")) {
    return {
      targetDir: "specs",
      classification: "spec",
      reasoning: "content contains success/acceptance criteria sections",
      confidence: 0.7,
    };
  }

  // Research heuristics: Findings/Recommendation/Evaluation/Analysis
  const researchSignals = ["## findings", "## recommendation", "## evaluation", "## analysis", "competitor", "evaluated"];
  const researchHits = researchSignals.filter((s) => contentLower.includes(s)).length;
  if (researchHits >= 2) {
    return {
      targetDir: "docs/research",
      classification: "research",
      reasoning: `content has ${researchHits} research signals (findings, recommendation, evaluation, etc.)`,
      confidence: 0.65,
    };
  }

  // Reference/deprecated heuristics
  if (
    contentLower.includes("deprecated") ||
    contentLower.includes("no longer in use") ||
    contentLower.includes("historical reference") ||
    contentLower.includes("archived") ||
    contentLower.includes("superseded")
  ) {
    return {
      targetDir: "reference",
      classification: "reference",
      reasoning: "content indicates deprecated/historical document",
      confidence: 0.6,
    };
  }

  // Guide heuristics: step-by-step, how to, getting started
  if (
    contentLower.includes("step-by-step") ||
    contentLower.includes("getting started") ||
    contentLower.includes("## prerequisites") ||
    contentLower.includes("## installation")
  ) {
    return {
      targetDir: "docs/guides",
      classification: "guide",
      reasoning: "content structure suggests a guide (step-by-step, prerequisites, etc.)",
      confidence: 0.6,
    };
  }

  // Default: reference (lowest confidence)
  return {
    targetDir: "reference",
    classification: "unclassified",
    reasoning: "no strong signals detected, defaulting to reference",
    confidence: 0.3,
  };
}

// ── Main organize function ───────────────────────────────────────

/**
 * The full result: what was proposed, and what could not be looked at.
 *
 * `organizeProject` below is a view onto this, not a second implementation —
 * eight call sites want only the proposals and changing them all would have
 * bought nothing. One decider, one convenience accessor.
 */
export function organizeProjectReport(root: string, options: OrganizeOptions = {}): OrganizeReport {
  const complianceConfig = options.harnessRoot
    ? loadComplianceConfig(options.harnessRoot)
    : null;
  const organizeConfig = complianceConfig?.organize;
  const fileTypes = organizeConfig?.fileTypes || [".md"];
  const artifactClassification = organizeConfig?.artifactClassification || {};

  const candidates = scanUnorganized(root, fileTypes);
  const proposals: OrganizeProposal[] = [];

  for (const candidate of candidates) {
    const classification = classifyDocument(candidate.source, candidate.content, artifactClassification);

    const currentDir = dirname(candidate.source);
    if (currentDir === classification.targetDir) continue;

    const targetPath = join(classification.targetDir, basename(candidate.source));

    proposals.push({
      source: candidate.source,
      target: targetPath,
      classification: classification.classification,
      reasoning: classification.reasoning,
      confidence: classification.confidence,
    });
  }

  const aliases = projectAliases(root, organizeConfig?.aliases ?? []);
  const report: OrganizeReport = { proposals, unmeasured: [], unreadable: [], aliases };

  // Scan external sources from config
  if (organizeConfig?.externalSources) {
    proposals.push(...scanExternalSources(root, organizeConfig.externalSources, aliases, report));
  }

  if (options.apply && !options.dryRun) {
    executeProposals(root, proposals);
  }

  return report;
}

export function organizeProject(root: string, options: OrganizeOptions = {}): OrganizeProposal[] {
  return organizeProjectReport(root, options).proposals;
}

// ── External source scanning ────────────────────────────────────

function scanExternalSources(
  projectRoot: string,
  sources: OrganizeExternalSource[],
  aliases: string[],
  report: { unmeasured: string[]; unreadable: string[] },
): OrganizeProposal[] {
  const proposals: OrganizeProposal[] = [];

  for (const source of sources) {
    const expandedPath = expandHome(source.path);
    if (!existsSync(expandedPath)) {
      // UNMEASURED, not skipped. The user said their documents live here.
      report.unmeasured.push(source.path);
      continue;
    }
    if (source.target === null) continue;

    let stat;
    try {
      stat = lstatSync(expandedPath);
    } catch {
      report.unreadable.push(source.path);
      continue;
    }
    if (!stat.isDirectory()) continue;

    let entries: string[];
    try {
      entries = readdirSync(expandedPath);
    } catch {
      // Was a bare `catch {}` around the whole walk. A declared source the
      // process cannot list is the single most important thing to say.
      report.unreadable.push(source.path);
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(expandedPath, entry);
      let isDir: boolean;
      try {
        isDir = lstatSync(entryPath).isDirectory();
      } catch {
        report.unreadable.push(entryPath);
        continue;
      }
      if (!isDir && !entry.endsWith(".md")) continue;

      let matches = false;
      if (source.matchBy === "project-name") {
        matches = matchesAnyAlias(entry, aliases);
        if (!matches && isDir) {
          try {
            matches = readdirSync(entryPath).some(f => matchesAnyAlias(f, aliases));
          } catch {
            report.unreadable.push(entryPath);
            continue;
          }
        }
      } else if (source.matchBy === "content-reference") {
        if (!entry.endsWith(".md")) continue;
        let content: string;
        try {
          content = readFileSync(entryPath, "utf-8");
        } catch {
          // Was `catch {}`, which made unreadable and not-a-match the same
          // answer. They are opposite answers: one is "no", the other is
          // "I could not look".
          report.unreadable.push(entryPath);
          continue;
        }
        matches = matchesAnyAlias(content, aliases);
      }

      if (!matches) continue;

      const targetPath = join(source.target, entry);
      if (existsSync(join(projectRoot, targetPath))) continue;

      proposals.push({
        source: entryPath,
        target: targetPath,
        classification: source.type,
        reasoning: `external ${source.type} matched by ${source.matchBy} in ${source.path}`,
        confidence: 0.7,
      });
    }
  }

  return proposals;
}

/**
 * `~` expansion, anchored.
 *
 * `source.path.replace("~", HOME)` replaces the FIRST `~` anywhere in the
 * string, so `/srv/backup~old/docs` became `/srv/backup<HOME>old/docs`. Only
 * a leading `~` is a home reference.
 */
export function expandHome(path: string): string {
  if (path !== "~" && !path.startsWith("~/")) return path;
  const home = process.env.HOME || "";
  return home ? home + path.slice(1) : path;
}

// ── Execute proposals (move files) ───────────────────────────────

function executeProposals(root: string, proposals: OrganizeProposal[]): void {
  const moveMap = new Map<string, string>();

  for (const proposal of proposals) {
    const isAbsolute = proposal.source.startsWith("/");
    const srcPath = isAbsolute ? proposal.source : join(root, proposal.source);
    const tgtPath = join(root, proposal.target);

    if (!existsSync(srcPath)) continue;

    const tgtDir = dirname(tgtPath);
    if (!existsSync(tgtDir)) {
      mkdirSync(tgtDir, { recursive: true });
    }

    if (isAbsolute) {
      // External source: create symlink, don't move
      if (!existsSync(tgtPath)) {
        symlinkSync(srcPath, tgtPath);
      }
    } else if (lstatSync(srcPath).isSymbolicLink()) {
      const linkTarget = readlinkSync(srcPath);
      unlinkSync(srcPath);
      symlinkSync(linkTarget, tgtPath);
    } else {
      renameSync(srcPath, tgtPath);
    }

    moveMap.set(proposal.source, proposal.target);
  }

  // Update internal references in all moved files
  updateInternalReferences(root, moveMap);

  // Update AGENTS.md docs-routing
  updateDocsRouting(root, proposals);
}

// ── Update internal markdown references ──────────────────────────

function updateInternalReferences(root: string, moveMap: Map<string, string>): void {
  if (moveMap.size === 0) return;

  // For each moved file, update any markdown links that reference other moved files
  for (const [, newPath] of moveMap) {
    const fullPath = join(root, newPath);
    if (!existsSync(fullPath)) continue;

    // Skip symlinks for content modification
    if (lstatSync(fullPath).isSymbolicLink()) continue;

    let content = readFileSync(fullPath, "utf-8");
    let changed = false;

    for (const [oldSource, newTarget] of moveMap) {
      // Skip self-references
      if (newPath === newTarget && oldSource === newPath) continue;

      // Calculate old relative reference from old location to old source
      const oldRelative = `./${oldSource}`;
      // Calculate new relative reference from new location to new target
      const newDir = dirname(newPath);
      const newRelative = relative(newDir, newTarget) || basename(newTarget);
      const newRelativeFormatted = newRelative.startsWith("..") ? newRelative : `./${newRelative}`;

      if (content.includes(oldRelative)) {
        content = content.replace(new RegExp(escapeRegex(oldRelative), "g"), newRelativeFormatted);
        changed = true;
      }

      // Also check bare filename references like (AUTH-SPEC.md) in link syntax
      const bareOldName = basename(oldSource);
      const linkPattern = new RegExp(`\\]\\(${escapeRegex(bareOldName)}\\)`, "g");
      if (linkPattern.test(content)) {
        content = content.replace(linkPattern, `](${newRelativeFormatted})`);
        changed = true;
      }
    }

    // #1286: organize moves docs into `specs/`, `docs/` and `reference/` and
    // then rewrites links INSIDE them. A moved file can be a spec a generator
    // owns, and rewriting its links is discarded at the next regeneration.
    const derived = readDerivedDeclaration(content);
    if (changed && !mayWrite(derived)) {
      console.warn(skipLine(newPath, derived));
      continue;
    }

    if (changed) {
      writeFileSync(fullPath, content);
    }
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Update AGENTS.md docs-routing table ──────────────────────────

export function updateDocsRouting(root: string, proposals: OrganizeProposal[]): void {
  const agentsPath = join(root, "AGENTS.md");
  if (!existsSync(agentsPath)) return;
  if (proposals.length === 0) return;

  let content = readFileSync(agentsPath, "utf-8");

  // Find the Documentation Routing table
  const tablePattern = /(\| I need to understand\.\.\. \| Read \|\n\|[-|]+\|\n)((?:\|[^\n]+\|\n)*)/;
  const match = content.match(tablePattern);
  if (!match) return;

  const existingTable = match[2];
  const newRows: string[] = [];

  for (const proposal of proposals) {
    // Skip if already in table
    if (existingTable.includes(proposal.target)) continue;

    const label = basename(proposal.target, ".md").replace(/-/g, " ");
    newRows.push(`| ${label} | ${proposal.target} |`);
  }

  if (newRows.length === 0) return;

  const updatedTable = match[1] + existingTable + newRows.join("\n") + "\n";
  content = content.replace(tablePattern, updatedTable);
  writeFileSync(agentsPath, content);
}
