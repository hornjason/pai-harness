#!/bin/bash
# harness-init.sh — Scaffold Bun gate harness into any project
# Usage: bash ~/.claude/scripts/harness-init.sh [project-root]
#
# Creates: gates/, .claude/agents/, wires SubagentStop hook
# Idempotent — safe to re-run (skips existing files)

set -euo pipefail

PROJECT_ROOT="${1:-.}"
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"
TEMPLATE_DIR="$HOME/.claude/gates"

echo "═══ Harness v3 Init ═══"
echo "Project: $PROJECT_ROOT"
echo ""

# ── gates/ ──────────────────────────────────────────────────
mkdir -p "$PROJECT_ROOT/gates"

for f in schema.ts workflow.test.ts e2e-smoke.test.ts chain.test.ts prove.test.ts preload.ts bunfig.toml; do
  src="$TEMPLATE_DIR/$f"
  dst="$PROJECT_ROOT/gates/$f"
  if [[ -f "$dst" ]]; then
    echo "  SKIP gates/$f (exists)"
  elif [[ -f "$src" ]]; then
    cp "$src" "$dst"
    echo "  CREATE gates/$f"
  else
    echo "  MISS gates/$f (template not found at $src)"
  fi
done

# No executables to chmod — all Bun files

# ── .claude/agents/ ─────────────────────────────────────────
mkdir -p "$PROJECT_ROOT/.claude/agents"

for agent in marcus quinn rook aditi serena; do
  dst="$PROJECT_ROOT/.claude/agents/$agent.md"
  src="$HOME/.claude/templates/harness-v3/agents/$agent.md"
  if [[ -f "$dst" ]]; then
    echo "  SKIP .claude/agents/$agent.md (exists)"
  elif [[ -f "$src" ]]; then
    cp "$src" "$dst"
    echo "  CREATE .claude/agents/$agent.md"
  else
    echo "  STUB .claude/agents/$agent.md"
    printf -- "---\nname: %s\nmode: bypassPermissions\n---\n\nRead project docs before starting work.\n" "$agent" > "$dst"
  fi
done

# ── .claude/settings.json (SubagentStop hook) ───────────────
SETTINGS="$PROJECT_ROOT/.claude/settings.json"
if [[ -f "$SETTINGS" ]]; then
  if grep -q 'SubagentStop' "$SETTINGS"; then
    echo "  SKIP SubagentStop hook (already wired)"
  else
    echo "  NOTE: .claude/settings.json exists but no SubagentStop hook."
    echo "        Add manually:"
    echo '        "SubagentStop": [{"type":"command","command":"cd \"$CLAUDE_PROJECT_DIR\" && bun test --bail --config gates/bunfig.toml gates/ 2>&1 || true"}]'
  fi
else
  echo "  CREATE .claude/settings.json"
  cat > "$SETTINGS" << 'SETTINGSEOF'
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "hooks": {
    "SubagentStop": [
      {
        "type": "command",
        "command": "cd \"$CLAUDE_PROJECT_DIR\" && bun test --bail --config gates/bunfig.toml gates/workflow.test.ts gates/e2e-smoke.test.ts 2>&1 || true"
      }
    ]
  },
  "permissions": {
    "allow": [
      "Bash", "Read", "Write", "Edit", "Agent", "Skill",
      "TaskCreate", "TaskUpdate", "TaskList", "SendMessage",
      "WebFetch", "WebSearch", "mcp__*"
    ],
    "deny": [],
    "defaultMode": "bypassPermissions"
  }
}
SETTINGSEOF
fi

# ── Verify zod dependency ──────────────────────────────────
if [[ -f "$PROJECT_ROOT/package.json" ]]; then
  if ! grep -q '"zod"' "$PROJECT_ROOT/package.json"; then
    echo ""
    echo "  ⚠  zod not in package.json — run: cd $PROJECT_ROOT && bun add -d zod"
  fi
else
  echo ""
  echo "  ⚠  No package.json — run: cd $PROJECT_ROOT && bun init -y && bun add -d zod"
fi

# ── Summary ────────────────────────────────────────────────
echo ""
echo "═══ Done ═══"
echo ""
echo "Files:"
find "$PROJECT_ROOT/gates" -type f | sort | while read f; do echo "  ${f#$PROJECT_ROOT/}"; done
find "$PROJECT_ROOT/.claude/agents" -type f | sort | while read f; do echo "  ${f#$PROJECT_ROOT/}"; done
echo "  .claude/settings.json"
echo ""
echo "Verify: cd $PROJECT_ROOT && bun test gates/workflow.test.ts"
echo ""
echo "Next: create a workflow-state.json in ~/.pai-work/{slug}/ and run gates."
