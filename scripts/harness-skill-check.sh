#!/usr/bin/env bash
# harness-skill-check.sh — Validate a skill's SKILL.md meets the harness contract
# Usage: harness-skill-check.sh skills/{name}/SKILL.md
set -euo pipefail

if [[ -z "${1:-}" ]]; then
  echo "Usage: harness-skill-check.sh skills/<name>/SKILL.md"
  exit 1
fi
SKILL_FILE="$1"

if [[ ! -f "$SKILL_FILE" ]]; then
  echo "FAIL: $SKILL_FILE not found"
  exit 1
fi

PASSES=0 FAILS=0
check() {
  local name=$1 pattern=$2
  if grep -q "$pattern" "$SKILL_FILE" 2>/dev/null; then
    echo "  ✓ $name"
    PASSES=$((PASSES + 1))
  else
    echo "  ✗ $name — missing"
    FAILS=$((FAILS + 1))
  fi
}

SKILL_NAME=$(basename "$(dirname "$SKILL_FILE")")
echo "Checking skill: $SKILL_NAME"
echo "File: $SKILL_FILE"
echo "---"

# YAML frontmatter exists
check "YAML frontmatter" "^---"

# Required contract fields
check "contract.input" "input:"
check "contract.gateIn" "gateIn:"
check "contract.gateOut" "gateOut:"
check "contract.artifact" "artifact:"
check "contract.telemetry" "telemetry:"
check "contract.errorRecovery" "errorRecovery:"

# Required sections
check "Trigger conditions" "## Trigger"
check "Workflow section" "## Workflow"
check "Error handling" "[Ee]rror"

echo "---"
echo "=== Results: $PASSES pass, $FAILS fail ==="
[[ $FAILS -eq 0 ]] && exit 0 || exit 1
