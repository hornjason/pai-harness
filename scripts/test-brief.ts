#!/usr/bin/env bun
/**
 * test-brief — compliance test bench for agent briefs
 *
 * Spawns an agent in isolated worktree with a standard task,
 * audits the transcript, reports directive compliance.
 *
 * Usage: bun scripts/test-brief.ts marcus "Add config/test.json with {name: test}"
 */
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, basename } from "path";
import { spawnSync } from "child_process";

const ROOT = join(import.meta.dir, "..");

// ── Parse args ────────────────────────────────────────────
const role = process.argv[2];
const task = process.argv[3];

if (!role || !task) {
  console.error("Usage: bun scripts/test-brief.ts <role> <task>");
  console.error('  bun scripts/test-brief.ts marcus "Add config/test.json with {name: test}"');
  process.exit(1);
}

const briefPath = join(ROOT, ".claude/agents", `${role}.md`);
if (!existsSync(briefPath)) {
  console.error(`Brief not found: ${briefPath}`);
  process.exit(1);
}

// ── Extract directives from brief ─────────────────────────
interface Directive {
  text: string;
  type: "read" | "run" | "never" | "always";
  line: number;
  section: string;
  target?: string;
}

function extractDirectives(briefContent: string): Directive[] {
  const directives: Directive[] = [];
  const lines = briefContent.split("\n");
  let currentSection = "top";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (line.startsWith("## ")) {
      currentSection = line.replace("## ", "").trim();
      continue;
    }

    // Read X patterns — matches "Read `file`", "Read file.md", numbered items with file refs
    const readMatch = line.match(/(?:Read|read)\s+[`"]?([^\s`"]+(?:\.(?:md|ts|json|yml|yaml))?)[`"]?/);
    if (readMatch && !line.startsWith("//") && !line.startsWith("#")) {
      const target = readMatch[1].replace(/[`"]/g, "");
      if (target.includes("/") || target.includes(".")) {
        directives.push({ text: line.trim().replace(/^[-\d.]\s*/, ""), type: "read", line: lineNum, section: currentSection, target });
      }
    }

    // Context section numbered items with file refs — "1. **AGENTS.md** — MANDATORY"
    if (currentSection.toLowerCase().includes("context") && /^\d+\./.test(line.trim())) {
      const fileMatch = line.match(/\*\*([^\s*]+(?:\.(?:md|ts|json)))\*\*/);
      const pathMatch = line.match(/[`]([^\s`]+(?:\.(?:md|ts|json)))[`]/);
      const target = fileMatch?.[1] || pathMatch?.[1];
      if (target) {
        directives.push({ text: line.trim().replace(/^\d+\.\s*/, ""), type: "read", line: lineNum, section: currentSection, target });
      }
    }

    // Run/bun test patterns
    const runMatch = line.match(/(?:Run|run)\s+[`]([^`]+)[`]/);
    if (runMatch) {
      directives.push({ text: line.trim().replace(/^-\s*/, ""), type: "run", line: lineNum, section: currentSection, target: runMatch[1] });
    }

    // Never/No/Don't patterns
    if (currentSection.toLowerCase().includes("never") && line.trim().startsWith("- ")) {
      directives.push({ text: line.trim().replace(/^-\s*/, ""), type: "never", line: lineNum, section: currentSection });
    }

    // Always patterns
    if (currentSection.toLowerCase().includes("always") && line.trim().startsWith("- ")) {
      directives.push({ text: line.trim().replace(/^-\s*/, ""), type: "always", line: lineNum, section: currentSection });
    }
  }

  return directives;
}

// ── Check directive compliance against transcript ─────────
interface ComplianceResult {
  directive: Directive;
  status: "FOLLOWED" | "IGNORED" | "VIOLATED" | "N/A";
  evidence: string;
}

function checkCompliance(directives: Directive[], transcriptPath: string): ComplianceResult[] {
  const content = readFileSync(transcriptPath, "utf-8");
  const toolCalls: Array<{ name: string; input: Record<string, any> }> = [];

  for (const line of content.split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "assistant") {
        const msg = entry.message?.content;
        if (Array.isArray(msg)) {
          for (const block of msg) {
            if (block?.type === "tool_use") {
              toolCalls.push({ name: block.name, input: block.input || {} });
            }
          }
        }
      }
    } catch {}
  }

  const reads = toolCalls.filter((c) => c.name === "Read").map((c) => c.input.file_path || "");
  const bashes = toolCalls.filter((c) => c.name === "Bash").map((c) => c.input.command || "");

  return directives.map((d) => {
    if (d.type === "read" && d.target) {
      const targetBase = basename(d.target);
      const found = reads.some((r) => r.includes(targetBase));
      return {
        directive: d,
        status: found ? "FOLLOWED" as const : "IGNORED" as const,
        evidence: found ? `Read call found for ${targetBase}` : `No Read call for ${targetBase} in ${reads.length} reads`,
      };
    }

    if (d.type === "run" && d.target) {
      if (d.target.includes("bun test")) {
        const testRuns = bashes.filter((b) => /\bbun test\b/.test(b));
        if (testRuns.length === 0) return { directive: d, status: "IGNORED" as const, evidence: "No bun test calls found" };
        if (testRuns.length > 2) return { directive: d, status: "VIOLATED" as const, evidence: `${testRuns.length} bun test runs (expected 1-2)` };
        return { directive: d, status: "FOLLOWED" as const, evidence: `${testRuns.length} bun test run(s)` };
      }
      const found = bashes.some((b) => b.includes(d.target!));
      return { directive: d, status: found ? "FOLLOWED" as const : "IGNORED" as const, evidence: found ? "Command found" : "Command not found" };
    }

    if (d.type === "never") {
      if (d.text.toLowerCase().includes("cat") && d.text.toLowerCase().includes("bash")) {
        const catCalls = bashes.filter((b) => /\bcat\b/.test(b) && !b.includes("<<"));
        return { directive: d, status: catCalls.length === 0 ? "FOLLOWED" as const : "VIOLATED" as const, evidence: `${catCalls.length} cat commands` };
      }
      if (d.text.toLowerCase().includes("pwd") || d.text.toLowerCase().includes("ls -la")) {
        const orientCalls = bashes.filter((b) => /\bpwd\b/.test(b) || /\bls -la\b/.test(b));
        return { directive: d, status: orientCalls.length === 0 ? "FOLLOWED" as const : "VIOLATED" as const, evidence: `${orientCalls.length} orientation calls` };
      }
      if (d.text.toLowerCase().includes("subagent")) {
        const agentCalls = toolCalls.filter((c) => c.name === "Agent");
        return { directive: d, status: agentCalls.length === 0 ? "FOLLOWED" as const : "VIOLATED" as const, evidence: `${agentCalls.length} Agent calls` };
      }
      return { directive: d, status: "N/A" as const, evidence: "Cannot verify mechanically" };
    }

    if (d.type === "always") {
      if (d.text.toLowerCase().includes("agents.md")) {
        const early = reads.slice(0, 5).some((r) => r.includes("AGENTS.md"));
        return { directive: d, status: early ? "FOLLOWED" as const : "IGNORED" as const, evidence: early ? "AGENTS.md in first 5 reads" : "AGENTS.md not in first 5 reads" };
      }
      if (d.text.toLowerCase().includes("bun test")) {
        const testRuns = bashes.filter((b) => /\bbun test\b/.test(b));
        return { directive: d, status: testRuns.length > 0 ? "FOLLOWED" as const : "IGNORED" as const, evidence: `${testRuns.length} test runs` };
      }
      return { directive: d, status: "N/A" as const, evidence: "Cannot verify mechanically" };
    }

    return { directive: d, status: "N/A" as const, evidence: "Unknown directive type" };
  });
}

// ── Run RepoRails on brief ────────────────────────────────
function runRepoRails(filePath: string): number {
  const result = spawnSync("npx", ["@reporails/cli", "check", filePath, "--format", "json"], {
    cwd: ROOT, timeout: 15000, encoding: "utf-8",
  });
  try {
    const data = JSON.parse(result.stdout);
    return data?.findings?.length || data?.length || 0;
  } catch {
    return -1;
  }
}

// ── Format report ─────────────────────────────────────────
function formatReport(role: string, directives: Directive[], results: ComplianceResult[], rrCount: number): string {
  const followed = results.filter((r) => r.status === "FOLLOWED").length;
  const ignored = results.filter((r) => r.status === "IGNORED").length;
  const violated = results.filter((r) => r.status === "VIOLATED").length;
  const checkable = results.filter((r) => r.status !== "N/A").length;
  const score = checkable > 0 ? Math.round((followed / checkable) * 100) : 0;
  const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";

  const lines: string[] = [];
  lines.push(`\n${"═".repeat(60)}`);
  lines.push(`BRIEF COMPLIANCE: ${role} — ${grade} (${score}%)`);
  lines.push(`${"═".repeat(60)}`);
  lines.push(`Directives: ${directives.length} extracted, ${checkable} checkable`);
  lines.push(`Followed: ${followed} | Ignored: ${ignored} | Violated: ${violated}`);
  lines.push(`RepoRails findings: ${rrCount}`);
  lines.push("");

  lines.push("DIRECTIVE                                          | LINE | SECTION         | STATUS");
  lines.push("-".repeat(95));
  for (const r of results) {
    const icon = r.status === "FOLLOWED" ? "✅" : r.status === "IGNORED" ? "❌" : r.status === "VIOLATED" ? "⚠️" : "—";
    const text = r.directive.text.substring(0, 48).padEnd(48);
    const line = `L${r.directive.line}`.padEnd(5);
    const section = r.directive.section.substring(0, 15).padEnd(15);
    lines.push(`${icon} ${text} | ${line}| ${section} | ${r.status}: ${r.evidence}`);
  }

  lines.push("");
  lines.push("RECOMMENDATIONS:");
  const ignoredDirectives = results.filter((r) => r.status === "IGNORED");
  for (const r of ignoredDirectives) {
    const inTop20 = r.directive.line <= 20;
    lines.push(`  → "${r.directive.text.substring(0, 50)}" at L${r.directive.line} (${r.directive.section})`);
    if (!inTop20) lines.push(`    FIX: Move to Context or Always Do section (currently in ${r.directive.section})`);
    else lines.push(`    FIX: Strengthen language — add MANDATORY or BEFORE keyword`);
  }

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────
console.log(`\nExtracting directives from ${role}.md...`);
const briefContent = readFileSync(briefPath, "utf-8");
const directives = extractDirectives(briefContent);
console.log(`Found ${directives.length} directives`);

// Check if we have a transcript to audit (from a previous run)
const transcriptDir = process.argv[4];
if (transcriptDir) {
  const files = readdirSync(transcriptDir).filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"));
  if (files.length === 0) {
    console.error(`No agent transcripts found in ${transcriptDir}`);
    process.exit(1);
  }

  console.log(`\nRunning RepoRails on brief...`);
  const rrCount = runRepoRails(briefPath);

  console.log(`\nChecking ${files.length} agent transcript(s)...`);
  for (const file of files) {
    const metaPath = join(transcriptDir, file.replace(".jsonl", ".meta.json"));
    let label = file;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      label = meta.description || file;
    } catch {}

    if (label.toLowerCase() !== role.toLowerCase() && !label.toLowerCase().includes(role.toLowerCase())) continue;

    const results = checkCompliance(directives, join(transcriptDir, file));
    console.log(formatReport(role, directives, results, rrCount));
  }
} else {
  // Just show extracted directives (dry run)
  console.log("\nExtracted directives:");
  for (const d of directives) {
    console.log(`  L${d.line} [${d.type}] (${d.section}): ${d.text.substring(0, 70)}`);
  }
  console.log(`\nTo audit against a transcript: bun scripts/test-brief.ts ${role} "${task}" <transcript-dir>`);
}
