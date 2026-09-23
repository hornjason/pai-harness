import { readFileSync } from "fs";
import { basename, join } from "path";

export type RuleTier = "identity" | "reinforcement" | "mechanical";
type RuleType = "never" | "always" | "read" | "run";

export interface Rule {
  id: string;
  text: string;
  type: RuleType;
  tier: RuleTier;
  section: string;
  source: string;
  line: number;
}

interface TierMap {
  reinforcement?: string[];
  mechanical?: string[];
}

function parseTierMap(content: string): TierMap {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return {};
  const fm = fmMatch[1];
  const tiersMatch = fm.match(/tiers:\n((?:\s+\w+:.*\n?)*)/);
  if (!tiersMatch) return {};
  const result: TierMap = {};
  for (const line of tiersMatch[1].split("\n")) {
    const m = line.match(/^\s+(reinforcement|mechanical):\s*\[([^\]]*)\]/);
    if (m) {
      const key = m[1] as keyof TierMap;
      result[key] = m[2].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
    }
  }
  return result;
}

function classifyTier(section: string, tierMap: TierMap): RuleTier {
  const s = section.toLowerCase();
  for (const name of tierMap.reinforcement || []) {
    if (s.startsWith(name.toLowerCase())) return "reinforcement";
  }
  for (const name of tierMap.mechanical || []) {
    if (s.startsWith(name.toLowerCase())) return "mechanical";
  }
  return "identity";
}

export function loadRules(briefPath: string): Rule[] {
  const content = readFileSync(briefPath, "utf-8");
  const tierMap = parseTierMap(content);
  const lines = content.split("\n");
  const rules: Rule[] = [];
  const sourceFile = basename(briefPath);
  let currentSection = "top";
  let ruleCounter = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (line.startsWith("## ")) {
      currentSection = line.replace("## ", "").trim();
      continue;
    }
    if (line.startsWith("//") || line.startsWith("#") || !line.trim()) continue;

    const sectionLower = currentSection.toLowerCase();
    const trimmedLine = line.trim().replace(/^[-\d.]+\s*/, "");
    let ruleType: RuleType | null = null;

    if (/^(?:\*{0,2})(?:never|do not|don't)\b/i.test(trimmedLine)) {
      ruleType = "never";
    } else if (
      (sectionLower.includes("never") || sectionLower.includes("additional never")) &&
      line.trim().startsWith("- ")
    ) {
      ruleType = "never";
    } else if (sectionLower.includes("always") && line.trim().startsWith("- ")) {
      ruleType = "always";
    } else if (sectionLower.includes("core principles") && line.trim().startsWith("- ")) {
      ruleType = "always";
    } else if (sectionLower === "rules" && line.trim().startsWith("- ")) {
      ruleType = "always";
    } else if (
      /(?:Read|read|Check|check)\s+[`"*]*([^\s`"*]+(?:\.(?:md|ts|json|yml|yaml|js|toml|sh)))[`"*]*/i.test(
        line
      )
    ) {
      ruleType = "read";
    } else if (sectionLower.includes("context") && /^\d+\./.test(line.trim())) {
      ruleType = "read";
    } else if (/(?:Run|run)\s+[`]([^`]+)[`]/.test(line)) {
      ruleType = "run";
    } else if (/`(bun test[^`]*)`/.test(line)) {
      ruleType = "run";
    } else if (/`(bunx? tsc[^`]*)`/.test(line)) {
      ruleType = "run";
    }

    if (ruleType) {
      ruleCounter++;
      rules.push({
        id: `${sourceFile.replace(".md", "")}-rule-${ruleCounter}`,
        text: trimmedLine,
        type: ruleType,
        tier: classifyTier(currentSection, tierMap),
        section: currentSection,
        source: sourceFile,
        line: lineNum,
      });
    }
  }
  return rules;
}

export function getRulesForRole(role: string): Rule[] {
  const projectRoot = join(import.meta.dir, "..");
  const briefPath = join(projectRoot, ".claude/agents", `${role}.md`);
  return loadRules(briefPath);
}

export function getRulesForTier(role: string, tier: RuleTier): Rule[] {
  return getRulesForRole(role).filter((r) => r.tier === tier);
}
