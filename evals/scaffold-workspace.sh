#!/usr/bin/env bash
# Scaffold a minimal workspace for eval runs
# Called by case.yaml context.scaffold_script
set -euo pipefail

# Initialize git repo (required for Claude Code)
git init
git config user.email "eval@test.com"
git config user.name "Eval"

# Create minimal project structure with real code to work with
mkdir -p lib test specs .claude/agents .claude/rules

# Copy a real source file for agents to work with
cat > lib/conformity.ts << 'TSEOF'
export function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

export function matchPattern(sc: { id: string; statement: string; specFile: string }, projectRoot?: string): ((root: string) => void) | null {
  // Matches SC statements against a registry of patterns
  // Returns an assertion function if a pattern matches, null otherwise
  const registry = [
    { name: "file-exists", regex: "exists?\\s+`([^`]+)`" },
    { name: "dir-exists", regex: "directory\\s+`([^`]+)`" },
  ];
  for (const entry of registry) {
    const regex = new RegExp(entry.regex, "i");
    if (regex.test(sc.statement)) {
      return (_root: string) => {};
    }
  }
  return null;
}
TSEOF

cat > lib/scanner.ts << 'TSEOF'
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

export interface ProjectScan {
  techStack: string[];
  specs: string[];
  testFiles: string[];
  sourceDirs: string[];
}

export function scanProject(root: string): ProjectScan {
  const specs = existsSync(join(root, "specs"))
    ? readdirSync(join(root, "specs")).filter(f => f.endsWith(".md"))
    : [];
  return {
    techStack: ["typescript", "bun"],
    specs,
    testFiles: [],
    sourceDirs: ["lib"],
  };
}
TSEOF

# Create AGENTS.md
cat > AGENTS.md << 'MDEOF'
# rungate

## Project Identity
Ship harness — conformity tests and agent briefs

## Rules
- Verify before asserting
- Never fake results

## Commands
| Action | Command |
|--------|---------|
| Test | `bun test` |

## Workflow
- **Test:** `bun test`
MDEOF

# Create package.json
cat > package.json << 'JSONEOF'
{
  "name": "eval-workspace",
  "type": "module",
  "scripts": { "test": "bun test" }
}
JSONEOF

git add -A
git commit -m "init eval workspace"
