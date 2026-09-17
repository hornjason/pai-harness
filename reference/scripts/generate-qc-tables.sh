#!/usr/bin/env bash
# generate-qc-tables.sh — Generate QC spec tables from skill-qc-checks.json
# Usage: bash scripts/generate-qc-tables.sh [--skill SKILL]
# Output goes to stdout. Redirect to update spec:
#   bash scripts/generate-qc-tables.sh --skill prove > /tmp/prove-table.md
set -euo pipefail

CONFIG="$(cd "$(dirname "$0")/.." && pwd)/schemas/skill-qc-checks.json"
[[ -f "$CONFIG" ]] || { echo "ERROR: $CONFIG not found" >&2; exit 1; }

SKILL_FILTER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skill) SKILL_FILTER="$2"; shift 2 ;;
    *) echo "Usage: $0 [--skill SKILL]" >&2; exit 1 ;;
  esac
done

# Validate skill filter if provided
if [[ -n "$SKILL_FILTER" ]]; then
  if ! jq -e --arg s "$SKILL_FILTER" '[.checks[].skill] | unique | index($s)' "$CONFIG" > /dev/null 2>&1; then
    echo "ERROR: Unknown skill '$SKILL_FILTER'. Available: $(jq -r '[.checks[].skill] | unique | join(", ")' "$CONFIG")" >&2
    exit 1
  fi
  SKILLS="$SKILL_FILTER"
else
  SKILLS=$(jq -r '[.checks[].skill] | unique | .[]' "$CONFIG")
fi

# jq program in temp file — avoids shell quoting issues with single quotes
JQ_PROG=$(mktemp)
trap 'rm -f "$JQ_PROG"' EXIT

cat > "$JQ_PROG" << 'JQEOF'
def expect_text:
  if .expect == null then ""
  elif .expect.op == ">=" then " >= \(.expect.value)"
  elif .expect.op == "==" then " == \(.expect.value)"
  elif .expect.op == "exit-0" then " exits 0"
  elif .expect.op == "non-empty" then " returns non-empty"
  elif .expect.op == "contains" then " contains \(.expect.value)"
  elif .expect.op == "not-null" then " returns non-null"
  elif .expect.op == "length-gte" then " length >= \(.expect.value)"
  else ""
  end;

def verify_col:
  if .type == "command" then
    ("`" + .command + "`" + expect_text)
  elif .type == "jq" then
    ("`jq '" + .query + "' " + .source + "`" + expect_text)
  elif .type == "jq-count" then
    ("`jq '" + .query + " | length' " + .source + "`" + expect_text)
  elif .type == "jq-each" then
    ("Each `" + .query + "` " + (.test // "validates")
     + if .enum then " [" + (.enum | join(", ")) + "]" else "" end)
  elif .type == "computed" then
    ("`" + .jq_test + "`")
  else
    "see check definition"
  end;

.checks[] | select(.skill == $skill) |
[.id, .description, verify_col, (.severity // "FAIL")] | @tsv
JQEOF

for skill in $SKILLS; do
  echo ""
  echo "## /$skill"
  echo ""

  if [[ "$skill" == "prove" ]]; then
    echo "| # | Criterion | Verify | Severity |"
    echo "|---|---|---|---|"
  else
    echo "| # | Criterion | Verify |"
    echo "|---|---|---|"
  fi

  # Generate rows: jq outputs TSV, bash formats as markdown
  jq -r --arg skill "$skill" -f "$JQ_PROG" "$CONFIG" | while IFS=$'\t' read -r id desc verify severity; do
    # Escape pipes in verify column for markdown table compatibility
    verify="${verify//|/\\|}"
    if [[ "$skill" == "prove" ]]; then
      printf '| %s | %s | %s | %s |\n' "$id" "$desc" "$verify" "$severity"
    else
      printf '| %s | %s | %s |\n' "$id" "$desc" "$verify"
    fi
  done

  echo ""
done
