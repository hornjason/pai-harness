#!/usr/bin/env bash
# chain-compat-check.sh — L3 cross-skill compatibility checking
# Verifies output of skill N matches input expectations of skill N+1
# Usage: chain-compat-check.sh [chain-yaml]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== L3 Chain Compatibility Check ==="

# Format: upstream_skill:upstream_artifact:downstream_skill:expected_field
HANDOFFS=(
  "goal:goal-record.json:ship:successCriteria"
  "goal:goal-record.json:prove:successCriteria"
  "ship:ship-evidence.json:prove:mergeCommitSha"
  "prove:prove-evidence.json:release:verdict"
  "prove:prove-evidence.json:release:commitSHA"
)

PASSES=0
FAILS=0

for handoff in "${HANDOFFS[@]}"; do
  IFS=':' read -r upstream artifact downstream field <<< "$handoff"

  SCHEMA_FILE=""
  case "$artifact" in
    goal-record.json)     SCHEMA_FILE="$REPO_ROOT/schemas/goal-record.schema.json" ;;
    ship-evidence.json)   SCHEMA_FILE="$REPO_ROOT/schemas/ship-evidence.schema.json" ;;
    prove-evidence.json)  SCHEMA_FILE="$REPO_ROOT/skills/prove/prove-evidence.schema.json" ;;
    release-proof.json)   SCHEMA_FILE="$REPO_ROOT/schemas/release-proof.schema.json" ;;
  esac

  if [[ ! -f "$SCHEMA_FILE" ]]; then
    echo "  FAIL ${upstream}->${downstream}: schema $SCHEMA_FILE not found"
    FAILS=$((FAILS + 1))
    continue
  fi

  HAS_FIELD=$(python3 -c "
import json
schema = json.load(open('$SCHEMA_FILE'))
props = schema.get('properties', {})
if '$field' in props:
    print('YES')
else:
    for prop_name, prop_def in props.items():
        if isinstance(prop_def, dict) and 'properties' in prop_def:
            if '$field' in prop_def['properties']:
                print('YES')
                break
    else:
        print('NO')
" 2>/dev/null || echo "ERROR")

  if [[ "$HAS_FIELD" == "YES" ]]; then
    echo "  PASS ${upstream}->${downstream}: '$field' exists in $artifact schema"
    PASSES=$((PASSES + 1))
  else
    echo "  FAIL ${upstream}->${downstream}: '$field' NOT in $artifact schema"
    FAILS=$((FAILS + 1))
  fi
done

echo ""
echo "=== Compatibility: $PASSES pass, $FAILS fail ==="
[[ $FAILS -eq 0 ]] && exit 0 || exit 1
