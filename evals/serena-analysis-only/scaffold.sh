#!/usr/bin/env bash
# Scaffold a minimal workspace for eval runs
# Called by case.yaml context.scaffold_script
set -euo pipefail

# Initialize git repo (required for Claude Code)
# Refuse to scaffold into an existing checkout. The identity writes below are
# repo-scoped, so running this from a real repo rewrites that repo's author
# (#84 — rungate's own commits were attributed to a test identity for months).
if git rev-parse --git-dir >/dev/null 2>&1; then
  echo "scaffold.sh: refusing to run inside an existing git repo: $PWD" >&2
  exit 1
fi
git init
WORKSPACE="$PWD"
git -C "$WORKSPACE" config user.email "eval@test.com"
git -C "$WORKSPACE" config user.name "Eval"

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
