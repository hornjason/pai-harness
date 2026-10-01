/**
 * Bridge plugin eval results to hill-climb system.
 * 
 * Reads eval aggregate-result.json, maps grader pass/fail to COMP dimensions,
 * and produces hill-climb recommendations for failing dimensions.
 * 
 * Usage: bun scripts/eval-to-hillclimb.ts [results-dir]
 * Default: reads latest evals/results/*/aggregate-result.json
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { COMPLIANCE_FACTORS, buildIteration, isTargetReached } from "../lib/hill-climb.js";

const ROOT = import.meta.dir + "/..";
const EVALS_DIR = join(ROOT, "evals", "results");

// Map eval case tags to COMP dimensions
const TAG_TO_COMP: Record<string, string> = {
  "comp-7": "COMP-7: Use Read tool, not cat/head/tail",
  "comp-9": "COMP-9: Surgical changes only",
  "comp-12": "COMP-12: Read before edit",
  "comp-13": "COMP-13: TDD order (test first)",
};

function findLatestResults(): string | null {
  if (!existsSync(EVALS_DIR)) return null;
  const dirs = readdirSync(EVALS_DIR).filter(d => d.match(/^\d{4}-/)).sort().reverse();
  if (dirs.length === 0) return null;
  return join(EVALS_DIR, dirs[0], "aggregate-result.json");
}

function main() {
  const resultsPath = process.argv[2] 
    ? join(process.argv[2], "aggregate-result.json")
    : findLatestResults();
  
  if (!resultsPath || !existsSync(resultsPath)) {
    console.error("No eval results found. Run: claude plugin eval . --scaffold --trust-plugin --allow-tools Write Edit Bash");
    process.exit(1);
  }

  const results = JSON.parse(readFileSync(resultsPath, "utf-8"));
  
  console.log("=== Plugin Eval → Hill Climb Bridge ===\n");
  console.log(`Results: ${resultsPath}`);
  console.log(`Cases: ${results.cases?.length || 0}`);
  console.log(`Suite score: ${results.suiteScore?.toFixed(2) || "N/A"}`);
  
  if (results.ablationDelta !== undefined) {
    console.log(`Δ (plugin effect): ${results.ablationDelta > 0 ? "+" : ""}${results.ablationDelta.toFixed(2)}`);
  }

  console.log("\n--- Per-case results ---\n");

  const failing: { case: string; comp: string; score: number; graders: string[] }[] = [];

  for (const c of results.cases || []) {
    const tags = c.tags || [];
    const compTag = tags.find((t: string) => t.startsWith("comp-"));
    const comp = compTag ? TAG_TO_COMP[compTag] || compTag : "behavioral";
    const score = c.withScore ?? c.score ?? 0;
    const passed = score >= 0.8;
    
    const failedGraders = (c.runs || []).flatMap((r: any) => 
      (r.graders || []).filter((g: any) => !g.passed).map((g: any) => g.name)
    );

    console.log(`${passed ? "✓" : "✗"} ${c.name}: ${score.toFixed(2)} ${comp}${failedGraders.length > 0 ? ` (failed: ${failedGraders.join(", ")})` : ""}`);
    
    if (!passed) {
      failing.push({ case: c.name, comp, score, graders: failedGraders });
    }
  }

  console.log(`\n--- Hill Climb Recommendations ---\n`);

  if (failing.length === 0) {
    console.log("All cases pass at ≥80%. No hill-climb needed.");
    console.log("Next: run with --runs 3 for statistical significance.");
  } else {
    console.log(`${failing.length} case(s) below 80% threshold:\n`);
    for (const f of failing) {
      console.log(`  ${f.case} (${f.score.toFixed(2)}): ${f.comp}`);
      console.log(`    Failed graders: ${f.graders.join(", ")}`);
      console.log(`    Recommendations:`);
      console.log(`      - Move ${f.comp} directive higher in agent brief`);
      console.log(`      - Strengthen language (MUST, NEVER, BEFORE)`);
      console.log(`      - Add specific example of correct behavior`);
      console.log(`      - Consider mechanical enforcement (hook or disallowedTools)`);
      console.log("");
    }
  }

  // Summary
  const totalCases = results.cases?.length || 0;
  const passingCases = totalCases - failing.length;
  console.log(`\nSummary: ${passingCases}/${totalCases} cases pass (${((passingCases / totalCases) * 100).toFixed(0)}%)`);
  
  if (results.ablationDelta !== undefined) {
    if (results.ablationDelta > 0) {
      console.log(`Plugin effect: +${results.ablationDelta.toFixed(2)} — briefs ARE helping`);
    } else if (results.ablationDelta === 0) {
      console.log(`Plugin effect: 0.00 — briefs have no measurable effect (Claude does this anyway)`);
    } else {
      console.log(`Plugin effect: ${results.ablationDelta.toFixed(2)} — briefs are HURTING (regression!)`);
    }
  }
}

main();
