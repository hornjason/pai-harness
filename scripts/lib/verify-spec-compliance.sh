#!/usr/bin/env bash
# verify-spec-compliance.sh — Minimal spec compliance checker
# Replaces 41 bash check functions with config-driven rules.
#
# Usage: verify-spec-compliance.sh <work-dir> [--changed-only]
# Reads: goal-record.json → governingSpec.path → {spec}.rules.json
# Outputs: structured JSON results to stdout
set -euo pipefail

WORK_DIR="${1:?Usage: verify-spec-compliance.sh <work-dir> [--changed-only]}"
CHANGED_ONLY="${2:-}"
GOAL_RECORD="$WORK_DIR/goal-record.json"
RESULTS="[]"
PASS=0 FAIL=0 WARN=0

# ── Find governing spec + rules ────────────────────────────
if [[ ! -f "$GOAL_RECORD" ]]; then
  echo '{"error":"no goal-record.json","results":[]}'; exit 0
fi

SPEC_PATH=$(jq -r '.governingSpec.path // empty' "$GOAL_RECORD" 2>/dev/null)
if [[ -z "$SPEC_PATH" ]]; then
  echo '{"error":"no governing spec","results":[]}'; exit 0
fi

# Resolve absolute path
[[ "$SPEC_PATH" == /* ]] || SPEC_PATH="$HOME/.claude/$SPEC_PATH"
RULES_FILE="${SPEC_PATH%.md}.rules.json"

if [[ ! -f "$RULES_FILE" ]]; then
  echo "{\"error\":\"no rules file at $RULES_FILE\",\"results\":[]}"; exit 0
fi

# ── Get changed files ──────────────────────────────────────
if [[ "$CHANGED_ONLY" == "--changed-only" ]]; then
  CHANGED=$(git diff --name-only HEAD~1 2>/dev/null || echo "")
else
  CHANGED=$(jq -r '.codeCommittedPaths // [] | .[]' "$WORK_DIR/workflow-state.json" 2>/dev/null || echo "")
fi

# ── Run pattern rules ──────────────────────────────────────
RULE_COUNT=$(jq '.pattern_rules | length' "$RULES_FILE" 2>/dev/null || echo 0)
for i in $(seq 0 $((RULE_COUNT - 1))); do
  RULE_ID=$(jq -r ".pattern_rules[$i].id" "$RULES_FILE")
  PATTERN=$(jq -r ".pattern_rules[$i].pattern" "$RULES_FILE")
  SEVERITY=$(jq -r ".pattern_rules[$i].severity // \"WARN\"" "$RULES_FILE")
  MESSAGE=$(jq -r ".pattern_rules[$i].message // \"\"" "$RULES_FILE")
  SCOPE=$(jq -r ".pattern_rules[$i].scope // \"changed\"" "$RULES_FILE")
  MAX=$(jq -r ".pattern_rules[$i].max_occurrences // \"0\"" "$RULES_FILE")

  HITS=0
  FILES_HIT=""
  TARGET_FILES="$CHANGED"
  [[ "$SCOPE" == "all-bash" ]] && TARGET_FILES=$(find . -name "*.sh" -not -path "./.claude/worktrees/*" | head -50)

  for f in $TARGET_FILES; do
    [[ -f "$f" ]] || continue
    COUNT=$(grep -cE "$PATTERN" "$f" 2>/dev/null || echo 0)
    if [[ "$COUNT" -gt 0 ]]; then
      HITS=$((HITS + COUNT))
      FILES_HIT="${FILES_HIT:+$FILES_HIT, }$f:$COUNT"
    fi
  done

  if [[ "$MAX" != "0" && "$HITS" -gt "$MAX" ]]; then
    RESULT="$SEVERITY"
  elif [[ "$MAX" == "0" && "$HITS" -gt 0 ]]; then
    RESULT="$SEVERITY"
  else
    RESULT="PASS"
  fi

  case "$RESULT" in PASS) PASS=$((PASS+1));; FAIL) FAIL=$((FAIL+1));; WARN) WARN=$((WARN+1));; esac
  RESULTS=$(echo "$RESULTS" | jq --arg id "$RULE_ID" --arg r "$RESULT" --arg d "$FILES_HIT" --arg m "$MESSAGE" \
    '. + [{"rule": $id, "result": $r, "detail": $d, "message": $m}]')
done

# ── Run behavior rules (commands that must succeed) ────────
BEHAV_COUNT=$(jq '.behavior_rules | length' "$RULES_FILE" 2>/dev/null || echo 0)
for i in $(seq 0 $((BEHAV_COUNT - 1))); do
  RULE_ID=$(jq -r ".behavior_rules[$i].id" "$RULES_FILE")
  CMD=$(jq -r ".behavior_rules[$i].command" "$RULES_FILE")
  EXPECT=$(jq -r ".behavior_rules[$i].expect // \"0\"" "$RULES_FILE")
  MESSAGE=$(jq -r ".behavior_rules[$i].message // \"\"" "$RULES_FILE")

  OUTPUT=$(bash -c "$CMD" 2>/dev/null || echo "COMMAND_FAILED")
  OUTPUT=$(echo "$OUTPUT" | tail -1 | tr -d ' ')

  if [[ "$OUTPUT" == "$EXPECT" ]]; then
    RESULT="PASS"; PASS=$((PASS+1))
  else
    RESULT="FAIL"; FAIL=$((FAIL+1))
  fi

  RESULTS=$(echo "$RESULTS" | jq --arg id "$RULE_ID" --arg r "$RESULT" --arg d "got:$OUTPUT expected:$EXPECT" --arg m "$MESSAGE" \
    '. + [{"rule": $id, "result": $r, "detail": $d, "message": $m}]')
done

# ── Output ─────────────────────────────────────────────────
jq -n --argjson results "$RESULTS" --arg spec "$SPEC_PATH" \
  --argjson pass "$PASS" --argjson fail "$FAIL" --argjson warn "$WARN" \
  '{spec: $spec, pass: $pass, fail: $fail, warn: $warn, results: $results}'
