#!/usr/bin/env bash
# gap-emit.sh — Read gate-runs.jsonl and produce gap summary (D-036)
# Thin normalizer: PAI emits, AgentGrit analyzes (D-039)
# --file mode: create GitHub issues from gaps (D-035)
set -euo pipefail

AFK_GAP_CAP="${AFK_GAP_CAP:-5}"
FILE_MODE=false
ISSUE_REPO=""
SOURCE_ISSUE=0

# Parse flags
case "${1:-}" in
  --file)
    FILE_MODE=true
    WORK_DIR="${2:?Usage: gap-emit.sh --file <work-dir> [repo] [source-issue]}"
    ISSUE_REPO="${3:-hornjason/pai-config}"
    SOURCE_ISSUE="${4:-0}"
    ;;
  *)
    WORK_DIR="${1:?Usage: gap-emit.sh [--file] <work-dir> [repo] [source-issue]}"
    ISSUE_REPO="${2:-hornjason/pai-config}"
    SOURCE_ISSUE="${3:-0}"
    ;;
esac

GATE_RUNS="$WORK_DIR/gate-runs.jsonl"

[[ -f "$GATE_RUNS" ]] || { echo "No gaps detected"; exit 0; }

gap_count=$(wc -l < "$GATE_RUNS" | tr -d ' ')
fail_count=$(grep -c '"FAIL"' "$GATE_RUNS" 2>/dev/null || echo 0)
warn_count=$(grep -c '"WARN"' "$GATE_RUNS" 2>/dev/null || echo 0)
top_types=$(jq -r '.gap_type' "$GATE_RUNS" 2>/dev/null | sort | uniq -c | sort -rn | head -5 | awk '{print $2}' | paste -sd, -)

echo "Gaps: $gap_count total ($fail_count FAIL, $warn_count WARN)"
echo "Top types: ${top_types:-none}"
echo "AFK auto-file cap: $AFK_GAP_CAP per cycle"

# --file mode: create GitHub issues from gaps (D-035)
if [[ "$FILE_MODE" == "true" ]]; then
  if [[ "${PAI_AFK:-}" == "1" ]] || ! test -t 0; then
    # AFK or non-interactive: auto-file up to AFK_GAP_CAP issues
    filed=0
    while IFS= read -r gap_line && [ "$filed" -lt "$AFK_GAP_CAP" ]; do
      gap_type=$(echo "$gap_line" | jq -r '.gap_type')
      detail=$(echo "$gap_line" | jq -r '.detail')
      check=$(echo "$gap_line" | jq -r '.check')

      gh issue create --repo "$ISSUE_REPO" --title "Gap: $check — $detail" \
        --label "needs-triage" \
        --body "Auto-filed by learning loop (D-035).

Source: #$SOURCE_ISSUE
Gap type: $gap_type
Check: $check
Detail: $detail" 2>/dev/null && filed=$((filed + 1))
    done < <(jq -c '.' "$GATE_RUNS" 2>/dev/null | head -"$AFK_GAP_CAP")

    echo "  Filed $filed gap issues (cap: $AFK_GAP_CAP)"
  else
    # Interactive: just output summary — DA decides what to file
    echo "  Interactive mode — review gaps above, file manually if needed"
  fi
fi
