#!/usr/bin/env bun
/**
 * Retroactive re-grading of historical compliance data.
 *
 * Since transcripts don't persist in work dirs, this script recalculates
 * scores from existing compliance-grade.json files by applying grader
 * fixes to the saved evidence strings:
 *
 * - COMP-13: IGNORED → N/A when evidence contains "No test files written"
 *   or "No source files written" (grader false positive for non-code tasks)
 * - COMP-8: Flags as UNVERIFIABLE when verdict was IGNORED (can't determine
 *   injection from saved data — only fixable going forward)
 *
 * Usage: bun scripts/regrade-historical.ts [--apply]
 *   Without --apply: dry-run showing before/after comparison
 *   With --apply: overwrites compliance-grade.json files with corrected scores
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join, basename } from "path";

interface RuleResult {
  id: string;
  rule: string;
  verdict: string;
  evidence: string;
  category?: string;
}

interface GradeEntry {
  role: string;
  total: number;
  followed: number;
  rules: RuleResult[];
  flagged?: string[];
  efficiency?: Record<string, number>;
}

interface GradeFile {
  grades: GradeEntry[];
  timing?: { role: string; durationSeconds: number }[];
  canary?: { total: number; triggered: number; results: unknown[] };
}

interface RegradeResult {
  dir: string;
  issue: string;
  role: string;
  oldScore: { followed: number; total: number; pct: number };
  newScore: { followed: number; total: number; pct: number };
  changes: { ruleId: string; oldVerdict: string; newVerdict: string; evidence: string }[];
}

function findGradeFiles(rootDir: string): string[] {
  const results: string[] = [];

  function scan(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("ddb-")) {
        const gradeFile = join(dir, entry.name, "compliance-grade.json");
        if (existsSync(gradeFile)) results.push(gradeFile);
      }
    }
  }

  scan(rootDir);
  scan(join(rootDir, ".archive"));
  return results.sort();
}

function regradeEntry(entry: GradeEntry): { entry: GradeEntry; changes: RegradeResult["changes"] } {
  const changes: RegradeResult["changes"] = [];
  if (!entry.rules || !Array.isArray(entry.rules)) {
    return { entry, changes };
  }
  const newRules = entry.rules.map(rule => {
    // COMP-13: NO_TESTS/NO_SOURCE should be N/A, not IGNORED
    if (rule.id === "COMP-13" && rule.verdict === "IGNORED") {
      if (rule.evidence.includes("No test files written") || rule.evidence.includes("No source files written")) {
        changes.push({ ruleId: rule.id, oldVerdict: "IGNORED", newVerdict: "N/A", evidence: rule.evidence });
        return { ...rule, verdict: "N/A" };
      }
    }
    return rule;
  });

  const checkable = newRules.filter(r => r.verdict !== "N/A");
  const followed = checkable.filter(r => r.verdict === "FOLLOWED").length;
  const total = checkable.length;

  const newFlagged = (entry.flagged || []).filter(f => {
    if (f.startsWith("TDD_SEQUENCE_VIOLATED:") && (f.includes("No test files written") || f.includes("No source files written"))) {
      return false;
    }
    return true;
  });

  return {
    entry: {
      ...entry,
      rules: newRules,
      total,
      followed,
      ...(newFlagged.length > 0 ? { flagged: newFlagged } : {}),
    },
    changes,
  };
}

function main() {
  const apply = process.argv.includes("--apply");
  const rungatePath = join(process.env.HOME || "~", ".rungate");
  const gradeFiles = findGradeFiles(rungatePath);

  console.log(`Found ${gradeFiles.length} compliance-grade.json files\n`);

  const allResults: RegradeResult[] = [];
  let filesChanged = 0;

  for (const filepath of gradeFiles) {
    const dirName = basename(join(filepath, ".."));
    const issue = dirName.replace(/^ddb-/, "#").replace(/-.*$/, "");
    let gradeData: GradeFile;
    try {
      gradeData = JSON.parse(readFileSync(filepath, "utf-8"));
    } catch {
      console.error(`Skipping ${dirName}: invalid JSON`);
      continue;
    }

    if (!gradeData.grades || gradeData.grades.length === 0) continue;

    let fileHasChanges = false;
    const newGrades: GradeEntry[] = [];

    for (const grade of gradeData.grades) {
      const { entry: newEntry, changes } = regradeEntry(grade);
      newGrades.push(newEntry);

      if (changes.length > 0) {
        fileHasChanges = true;
        const oldPct = grade.total > 0 ? Math.round((grade.followed / grade.total) * 100) : 0;
        const newPct = newEntry.total > 0 ? Math.round((newEntry.followed / newEntry.total) * 100) : 0;
        allResults.push({
          dir: dirName,
          issue,
          role: grade.role,
          oldScore: { followed: grade.followed, total: grade.total, pct: oldPct },
          newScore: { followed: newEntry.followed, total: newEntry.total, pct: newPct },
          changes,
        });
      }
    }

    if (fileHasChanges && apply) {
      writeFileSync(filepath, JSON.stringify({ ...gradeData, grades: newGrades }, null, 2));
      filesChanged++;
    }
  }

  // Print results
  if (allResults.length === 0) {
    console.log("No changes needed — all grades are already accurate.");
    return;
  }

  console.log(`${"═".repeat(70)}`);
  console.log(`RETROACTIVE RE-GRADE REPORT${apply ? " (APPLIED)" : " (DRY RUN)"}`);
  console.log(`${"═".repeat(70)}\n`);

  console.log("Per-run changes:\n");
  console.log(`${"Issue".padEnd(12)} ${"Role".padEnd(12)} ${"Old".padEnd(10)} ${"New".padEnd(10)} ${"Δ".padEnd(6)} Changes`);
  console.log("-".repeat(70));

  for (const r of allResults) {
    const delta = r.newScore.pct - r.oldScore.pct;
    const deltaStr = delta > 0 ? `+${delta}%` : `${delta}%`;
    const changeDesc = r.changes.map(c => `${c.ruleId}: ${c.oldVerdict}→${c.newVerdict}`).join(", ");
    console.log(
      `${r.issue.padEnd(12)} ${r.role.padEnd(12)} ${`${r.oldScore.followed}/${r.oldScore.total} (${r.oldScore.pct}%)`.padEnd(10)} ${`${r.newScore.followed}/${r.newScore.total} (${r.newScore.pct}%)`.padEnd(10)} ${deltaStr.padEnd(6)} ${changeDesc}`
    );
  }

  // Aggregate stats
  const totalOldPct = allResults.reduce((s, r) => s + r.oldScore.pct, 0) / allResults.length;
  const totalNewPct = allResults.reduce((s, r) => s + r.newScore.pct, 0) / allResults.length;
  const comp13Changes = allResults.reduce((s, r) => s + r.changes.filter(c => c.ruleId === "COMP-13").length, 0);

  console.log(`\n${"═".repeat(70)}`);
  console.log(`SUMMARY`);
  console.log(`${"═".repeat(70)}`);
  console.log(`Runs affected: ${allResults.length} of ${gradeFiles.length} grade files`);
  console.log(`COMP-13 reclassifications: ${comp13Changes} (IGNORED → N/A)`);
  console.log(`Average score change: ${totalOldPct.toFixed(1)}% → ${totalNewPct.toFixed(1)}% (Δ +${(totalNewPct - totalOldPct).toFixed(1)}%)`);
  if (apply) {
    console.log(`Files updated: ${filesChanged}`);
  } else {
    console.log(`\nRun with --apply to update the grade files.`);
  }

  // Write report
  const reportPath = join(rungatePath, "regrade-report.json");
  writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    applied: apply,
    totalFiles: gradeFiles.length,
    affectedRuns: allResults.length,
    comp13Reclassifications: comp13Changes,
    averageOldPct: Math.round(totalOldPct * 10) / 10,
    averageNewPct: Math.round(totalNewPct * 10) / 10,
    results: allResults,
  }, null, 2));
  console.log(`\nReport written to ${reportPath}`);
}

main();
