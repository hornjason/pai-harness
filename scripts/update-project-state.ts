#!/usr/bin/env bun
/**
 * Auto-update PROJECT-STATE.md with SC status, test results, and session summaries
 *
 * Usage:
 *   bun scripts/update-project-state.ts                # Full update with test run
 *   bun scripts/update-project-state.ts --skip-tests   # Fast SC-only update (pre-commit mode)
 *   bun scripts/update-project-state.ts --session-end  # Add session summary with git commits
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const PROJECT_STATE = join(ROOT, "PROJECT-STATE.md");
const SPECS_DIR = join(ROOT, "specs");
const SESSION_LOG_DIR = join(ROOT, "docs/session-log");
const MAX_LINES = 150;
const MAX_ARCHIVED_SESSIONS = 3;

interface TestCounts {
  pass: number;
  fail: number;
  skip: number;
  todo: number;
}

interface SCStatus {
  [scNumber: string]: boolean; // SC-268 -> true (completed) or false (open)
}

interface PhaseInfo {
  header: string; // e.g., "## ✅ Phase 0 — Scaffold Output (COMPLETE)"
  emoji: string; // ✅, 🔄, or ⬜
  scs: string[]; // ["SC-268", "SC-269", ...]
}

/**
 * Parse test output for counts
 */
function parseTestOutput(output: string): TestCounts {
  const counts: TestCounts = { pass: 0, fail: 0, skip: 0, todo: 0 };

  // Bun test output format:
  //  942 pass
  //  8 skip
  //  45 todo
  //  6 fail

  const passMatch = output.match(/(\d+)\s+pass/);
  const failMatch = output.match(/(\d+)\s+fail/);
  const skipMatch = output.match(/(\d+)\s+skip/);
  const todoMatch = output.match(/(\d+)\s+todo/);

  if (passMatch) counts.pass = parseInt(passMatch[1], 10);
  if (failMatch) counts.fail = parseInt(failMatch[1], 10);
  if (skipMatch) counts.skip = parseInt(skipMatch[1], 10);
  if (todoMatch) counts.todo = parseInt(todoMatch[1], 10);

  return counts;
}

/**
 * Get current test counts by running bun test
 */
function getTestCounts(): TestCounts | null {
  try {
    const output = execSync("bun test", {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 120000, // 2 minute timeout
      stdio: ["ignore", "pipe", "pipe"]
    });

    return parseTestOutput(output);
  } catch (error: any) {
    // Tests may fail, but we can still parse output
    if (error.stdout || error.stderr) {
      const output = (error.stdout || "") + (error.stderr || "");
      return parseTestOutput(output);
    }
    return null;
  }
}

/**
 * Scan all spec files and build SC status map
 * - [x] SC-268: ... -> SC-268 is completed
 * - [ ] SC-269: ... -> SC-269 is open
 */
function scanSCStatus(): SCStatus {
  const status: SCStatus = {};

  if (!existsSync(SPECS_DIR)) {
    return status;
  }

  // Use Bun's built-in glob
  const glob = new Bun.Glob("**/*.md");

  for (const file of glob.scanSync({ cwd: SPECS_DIR, absolute: true })) {
    if (!existsSync(file)) continue;

    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");

    for (const line of lines) {
      // Match: - [x] SC-268: ...
      const completedMatch = line.match(/^- \[x\] (SC-\d+):/i);
      if (completedMatch) {
        status[completedMatch[1].toUpperCase()] = true;
        continue;
      }

      // Match: - [ ] SC-268: ...
      const openMatch = line.match(/^- \[ \] (SC-\d+):/i);
      if (openMatch) {
        status[openMatch[1].toUpperCase()] = false;
      }
    }
  }

  return status;
}

/**
 * Extract phase information from PROJECT-STATE.md
 */
function extractPhaseInfo(content: string): Map<string, PhaseInfo> {
  const phases = new Map<string, PhaseInfo>();
  const lines = content.split("\n");

  let currentPhase: string | null = null;
  let currentHeader = "";
  let currentEmoji = "";
  let inTable = false;
  const currentSCs: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match phase headers: ## ✅ Phase 0, ## 🔄 Phase 1, ## ⬜ Phase 2
    const phaseMatch = line.match(/^## ([✅🔄⬜]) (Phase \d+[^(]*)/);
    if (phaseMatch) {
      // Save previous phase if exists
      if (currentPhase) {
        phases.set(currentPhase, {
          header: currentHeader,
          emoji: currentEmoji,
          scs: [...currentSCs]
        });
        currentSCs.length = 0;
      }

      currentEmoji = phaseMatch[1];
      currentPhase = phaseMatch[2].trim();
      currentHeader = line;
      inTable = false;
      continue;
    }

    // Check if we're in a table
    if (line.match(/^\| Status \| SC \|/) || line.match(/^\|---|---|/)) {
      inTable = true;
      continue;
    }

    // Extract SCs from table rows: | ✅ | SC-268 | ... |
    if (inTable && currentPhase) {
      const scMatch = line.match(/^\| [✅⬜] \| (SC-\d+) \|/);
      if (scMatch) {
        currentSCs.push(scMatch[1].toUpperCase());
      } else if (line.trim() && !line.startsWith("|")) {
        // End of table
        inTable = false;
      }
    }

    // Stop at next major section (Live Tracking, etc.)
    if (line.startsWith("## ") && !line.match(/^## [✅🔄⬜] Phase/)) {
      break;
    }
  }

  // Save last phase
  if (currentPhase) {
    phases.set(currentPhase, {
      header: currentHeader,
      emoji: currentEmoji,
      scs: currentSCs
    });
  }

  return phases;
}

/**
 * Determine phase emoji based on SC completion
 */
function determinePhaseEmoji(phaseSCs: string[], scStatus: SCStatus): string {
  if (phaseSCs.length === 0) return "⬜"; // No SCs = not started

  const completedCount = phaseSCs.filter(sc => scStatus[sc] === true).length;

  if (completedCount === 0) return "⬜"; // None completed = not started
  if (completedCount === phaseSCs.length) return "✅"; // All completed
  return "🔄"; // Some completed = in progress
}

/**
 * Update PROJECT-STATE.md with SC status, test counts, phase headers, etc.
 */
function updateProjectState(
  testCounts: TestCounts | null,
  skipTests: boolean,
  sessionEnd: boolean
): void {
  if (!existsSync(PROJECT_STATE)) {
    console.log("PROJECT-STATE.md not found, skipping update");
    return;
  }

  let content = readFileSync(PROJECT_STATE, "utf-8");
  const scStatus = scanSCStatus();

  // 1. Update frontmatter date
  const today = new Date().toISOString().split("T")[0];
  content = content.replace(
    /^updated: \d{4}-\d{2}-\d{2}$/m,
    `updated: ${today}`
  );

  // 2. Update test counts if we have them
  if (testCounts && !skipTests) {
    const testLine = `**Tests:** ${testCounts.pass} pass, ${testCounts.fail} fail, ${testCounts.skip} skip, ${testCounts.todo} todo`;
    content = content.replace(
      /\*\*Tests:\*\* \d+ pass.*$/gm,
      testLine
    );
  }

  // 3. Update SC table row status emojis (| ✅ | SC-268 | or | ⬜ | SC-268 |)
  content = content.replace(
    /^\| ([✅⬜]) \| (SC-\d+) \|/gm,
    (match, _oldEmoji, scNumber) => {
      const isCompleted = scStatus[scNumber.toUpperCase()] === true;
      const newEmoji = isCompleted ? "✅" : "⬜";
      return `| ${newEmoji} | ${scNumber} |`;
    }
  );

  // 4. Update phase headers based on SC completion
  const phases = extractPhaseInfo(content);

  // Build replacement map
  const replacements: Array<[string, string]> = [];

  for (const [phaseName, phaseInfo] of phases.entries()) {
    const newEmoji = determinePhaseEmoji(phaseInfo.scs, scStatus);

    // Determine new status text
    let newStatus = "";
    if (newEmoji === "✅") newStatus = "(COMPLETE)";
    else if (newEmoji === "🔄") newStatus = "(IN PROGRESS)";
    else if (newEmoji === "⬜") newStatus = "(NOT STARTED)";

    const newHeader = `## ${newEmoji} ${phaseName} ${newStatus}`;

    if (newHeader !== phaseInfo.header) {
      replacements.push([phaseInfo.header, newHeader]);
    }
  }

  // Apply all replacements
  for (const [oldHeader, newHeader] of replacements) {
    content = content.replace(oldHeader, newHeader);
  }

  // 5. Update "Current phase" line to reflect first incomplete phase
  const phaseList = Array.from(phases.entries());
  const firstIncompletePhase = phaseList.find(([_, info]) => {
    const emoji = determinePhaseEmoji(info.scs, scStatus);
    return emoji === "🔄" || emoji === "⬜"; // In progress or not started
  });

  if (firstIncompletePhase) {
    const [phaseName, phaseInfo] = firstIncompletePhase;
    const openCount = phaseInfo.scs.filter(sc => scStatus[sc] !== true).length;

    // Extract just "Phase N — description" from full phase name
    const phaseDescription = phaseName.replace(/\(.*\)/, "").trim();

    content = content.replace(
      /^\*\*Current phase:.*$/m,
      `**Current phase: ${phaseDescription} — ${openCount} SCs open**`
    );
  }

  // 6. Add session summary if --session-end
  if (sessionEnd) {
    // Archive previous session first
    const { content: contentAfterArchive, archived } = archivePreviousSession(content);
    content = contentAfterArchive;

    const sessionSummary = generateSessionSummary(scStatus);

    // Find the "Session YYYY-MM-DD summary:" section or create it
    const sessionHeaderRegex = /^\*\*Session \d{4}-\d{2}-\d{2}.*summary:\*\*$/m;

    if (content.match(sessionHeaderRegex)) {
      // Replace existing session summary
      content = content.replace(
        /(\*\*Session \d{4}-\d{2}-\d{2}.*summary:\*\*\n)[\s\S]*?(?=\n\*\*|\n##|\n---|\n$)/,
        `$1${sessionSummary}\n`
      );
    } else {
      // Add new session summary after "Next session priorities:"
      const insertPoint = content.indexOf("\n**Previous session");
      if (insertPoint > 0) {
        content = content.slice(0, insertPoint) +
          `\n**Session ${today} summary:**\n${sessionSummary}\n` +
          content.slice(insertPoint);
      } else {
        // If no "Previous session" section, add after "Next session priorities:"
        const nextPrioritiesMatch = content.match(/\*\*Next session priorities:\*\*[\s\S]*?(?=\n## |\n---|\n$)/);
        if (nextPrioritiesMatch) {
          const insertIdx = nextPrioritiesMatch.index! + nextPrioritiesMatch[0].length;
          content = content.slice(0, insertIdx) +
            `\n\n**Session ${today} summary:**\n${sessionSummary}\n` +
            content.slice(insertIdx);
        }
      }
    }
  }

  // 7. Trim to MAX_LINES if needed
  content = trimToMaxLines(content);

  writeFileSync(PROJECT_STATE, content, "utf-8");

  console.log(`✅ Updated PROJECT-STATE.md`);
  if (testCounts && !skipTests) {
    console.log(`   Tests: ${testCounts.pass} pass, ${testCounts.fail} fail, ${testCounts.skip} skip, ${testCounts.todo} todo`);
  }

  const completed = Object.values(scStatus).filter(v => v).length;
  const total = Object.keys(scStatus).length;
  console.log(`   SCs: ${completed} completed, ${total - completed} open`);
}

/**
 * Generate session summary with git commits and SC progress
 */
function generateSessionSummary(scStatus: SCStatus): string {
  const lines: string[] = [];

  // Get today's commits
  try {
    const commits = execSync("git log --oneline --since='8 hours ago'", {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();

    if (commits) {
      const commitLines = commits.split("\n").filter(line => line.trim());
      if (commitLines.length > 0) {
        commitLines.forEach(commit => {
          lines.push(`- ${commit}`);
        });
      } else {
        lines.push("- No commits in last 8 hours");
      }
    } else {
      lines.push("- No commits in last 8 hours");
    }
  } catch (error) {
    // No commits or git error
    lines.push("- No commits in last 8 hours");
  }

  return lines.join("\n");
}

/**
 * Archive previous session to docs/session-log/{date}.md
 * Returns true if session was archived
 */
function archivePreviousSession(content: string): { content: string; archived: boolean } {
  // Extract previous session section
  const sessionRegex = /\*\*Session (\d{4}-\d{2}-\d{2}).*?summary:\*\*\n([\s\S]*?)(?=\n\*\*(?:Previous session|Uncommitted)|---|\n## |$)/;
  const match = content.match(sessionRegex);

  if (!match) {
    return { content, archived: false };
  }

  const [fullMatch, sessionDate, sessionContent] = match;

  // Don't archive today's session
  const today = new Date().toISOString().split("T")[0];
  if (sessionDate === today) {
    return { content, archived: false };
  }

  // Create session log directory
  if (!existsSync(SESSION_LOG_DIR)) {
    mkdirSync(SESSION_LOG_DIR, { recursive: true });
  }

  // Write archived session
  const archiveFile = join(SESSION_LOG_DIR, `${sessionDate}.md`);
  const archiveContent = `# Session ${sessionDate}\n\n${sessionContent.trim()}\n`;
  writeFileSync(archiveFile, archiveContent);

  // Remove old session section from content
  const updatedContent = content.replace(fullMatch, "");

  // Clean up old archives (keep only last N)
  cleanupOldArchives();

  console.log(`   Archived session ${sessionDate} to ${archiveFile}`);

  return { content: updatedContent, archived: true };
}

/**
 * Delete old session archives, keeping only the most recent N files
 */
function cleanupOldArchives(): void {
  if (!existsSync(SESSION_LOG_DIR)) {
    return;
  }

  const files = readdirSync(SESSION_LOG_DIR)
    .filter(f => f.endsWith(".md"))
    .map(f => ({
      name: f,
      path: join(SESSION_LOG_DIR, f),
      mtime: statSync(join(SESSION_LOG_DIR, f)).mtime.getTime()
    }))
    .sort((a, b) => b.mtime - a.mtime); // Newest first

  // Delete files beyond MAX_ARCHIVED_SESSIONS
  if (files.length > MAX_ARCHIVED_SESSIONS) {
    files.slice(MAX_ARCHIVED_SESSIONS).forEach(file => {
      unlinkSync(file.path);
      console.log(`   Deleted old archive: ${file.name}`);
    });
  }
}

/**
 * Trim PROJECT-STATE.md to MAX_LINES if it exceeds the limit
 * Preserves frontmatter and key sections, trims from the bottom
 */
function trimToMaxLines(content: string): string {
  const lines = content.split("\n");

  if (lines.length <= MAX_LINES) {
    return content;
  }

  // Keep frontmatter + first sections, trim from bottom
  // Strategy: keep everything up to "## Live Tracking" or equivalent,
  // then add a note about trimming
  const trimmedLines = lines.slice(0, MAX_LINES - 2);
  trimmedLines.push("");
  trimmedLines.push("_(Content trimmed to 150-line cap — see docs/session-log/ for archived sessions)_");

  console.log(`   Trimmed from ${lines.length} to ${MAX_LINES} lines`);

  return trimmedLines.join("\n");
}

/**
 * Main
 */
function main(): void {
  const args = process.argv.slice(2);
  const skipTests = args.includes("--skip-tests");
  const sessionEnd = args.includes("--session-end");

  let testCounts: TestCounts | null = null;

  if (!skipTests) {
    console.log("Running tests...");
    testCounts = getTestCounts();
  } else {
    console.log("Skipping tests (--skip-tests flag)");
  }

  updateProjectState(testCounts, skipTests, sessionEnd);
}

main();
