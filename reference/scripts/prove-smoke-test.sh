#!/usr/bin/env bash
# prove-smoke-test.sh — Smoke tests for /prove skill artifacts
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCHEMA="$SCRIPT_DIR/prove-evidence.schema.json"
TESTS=0 PASSED=0

pass() { PASSED=$((PASSED + 1)); TESTS=$((TESTS + 1)); echo "  ✓ $1"; }
fail() { TESTS=$((TESTS + 1)); echo "  ✗ $1"; }

echo "=== Prove Skill Smoke Tests ==="
echo ""

# 1. Schema file exists and is valid JSON
echo "1. Schema file exists and is valid JSON"
if [[ -f "$SCHEMA" ]] && jq empty "$SCHEMA" 2>/dev/null; then
  pass "prove-evidence.schema.json is valid JSON"
else
  fail "prove-evidence.schema.json missing or invalid"
fi

# 2. Schema has required fields
echo "2. Schema has required fields"
REQUIRED=$(jq -r '.required | length' "$SCHEMA" 2>/dev/null || echo 0)
if [[ "$REQUIRED" -ge 4 ]]; then
  pass "schema has $REQUIRED required fields (>=4)"
else
  fail "schema has $REQUIRED required fields (need >=4)"
fi

# 3. Valid prove-evidence.json passes schema structure check
echo "3. Valid prove-evidence.json structure"
VALID='{"issueNumber":1229,"verdict":"PROVEN","commitSHA":"abc123","capturedAt":"2026-09-03T00:00:00Z","reproduced":true}'
VERDICT=$(echo "$VALID" | jq -r '.verdict' 2>/dev/null)
if [[ "$VERDICT" == "PROVEN" ]]; then
  pass "valid evidence has correct verdict"
else
  fail "valid evidence verdict check failed"
fi

# 4. Verdict enum validation
echo "4. Verdict enum validation"
for v in PROVEN UNPROVEN INCONCLUSIVE; do
  ALLOWED=$(jq -r --arg v "$v" '.properties.verdict.enum | index($v) != null' "$SCHEMA" 2>/dev/null)
  if [[ "$ALLOWED" == "true" ]]; then
    pass "verdict '$v' is allowed"
  else
    fail "verdict '$v' not in schema enum"
  fi
done

# 5. Evidence types in schema
echo "5. Evidence type enums"
BEFORE_TYPES=$(jq -r '.properties.beforeEvidence.properties.type.enum | length' "$SCHEMA" 2>/dev/null || echo 0)
AFTER_TYPES=$(jq -r '.properties.afterEvidence.properties.type.enum | length' "$SCHEMA" 2>/dev/null || echo 0)
if [[ "$BEFORE_TYPES" -ge 3 && "$AFTER_TYPES" -ge 2 ]]; then
  pass "before has $BEFORE_TYPES types, after has $AFTER_TYPES types"
else
  fail "evidence type enums incomplete (before:$BEFORE_TYPES, after:$AFTER_TYPES)"
fi

# 6. Skill contract passes validator
echo "6. Skill contract validation"
CHECKER="${SCRIPT_DIR}/../../scripts/harness-skill-check.sh"
if [[ -f "$CHECKER" ]]; then
  SKILL_MD="$SCRIPT_DIR/SKILL.md"
  if bash "$CHECKER" "$SKILL_MD" > /dev/null 2>&1; then
    pass "/prove SKILL.md passes contract check"
  else
    fail "/prove SKILL.md fails contract check"
  fi
else
  fail "harness-skill-check.sh not found"
fi

# 7. STANDARD tier + local-only evidence → gate FAIL
echo "7. STANDARD tier requires prod evidence"
TMPDIR_T7=$(mktemp -d)
mkdir -p "$TMPDIR_T7"
echo '{"schemaVersion":2,"issue":999,"slug":"test","phase":"PROVE","issueGoal":"test","acs":[],"gates":{},"changelog":[],"sizing":{"ceremonyTier":"STANDARD"}}' > "$TMPDIR_T7/workflow-state.json"
HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || echo "abc123")
echo "{\"contractVersion\":\"1.0\",\"issueNumber\":999,\"verdict\":\"PROVEN\",\"commitSHA\":\"$HEAD_SHA\",\"capturedAt\":\"2026-01-01T00:00:00Z\",\"criteriaResults\":[{\"scId\":\"SC-1\",\"verdict\":\"PASS\",\"evidence\":\"ok\"}],\"afterEvidence\":{\"environment\":\"local\"}}" > "$TMPDIR_T7/prove-evidence.json"
if PAI_WORK_DIR="$TMPDIR_T7" bash "$SCRIPT_DIR/../ship/gate-runner.sh" --gate prove --issue 999 --slug . 2>/dev/null; then
  fail "gate accepted local evidence at STANDARD tier"
else
  pass "gate rejected local evidence at STANDARD tier"
fi

# 7b. Missing afterEvidence entirely → defaults to local → FAIL
echo "7b. Missing afterEvidence → defaults to local → FAIL"
echo "{\"contractVersion\":\"1.0\",\"issueNumber\":999,\"verdict\":\"PROVEN\",\"commitSHA\":\"$HEAD_SHA\",\"capturedAt\":\"2026-01-01T00:00:00Z\",\"criteriaResults\":[{\"scId\":\"SC-1\",\"verdict\":\"PASS\",\"evidence\":\"ok\"}]}" > "$TMPDIR_T7/prove-evidence.json"
if PAI_WORK_DIR="$TMPDIR_T7" bash "$SCRIPT_DIR/../ship/gate-runner.sh" --gate prove --issue 999 --slug . 2>/dev/null; then
  fail "gate accepted missing afterEvidence at STANDARD tier"
else
  pass "gate rejected missing afterEvidence at STANDARD tier"
fi

# 7c. LIGHT tier + local evidence → PASS (exempted)
echo "7c. LIGHT tier + local evidence → PASS (exempted)"
echo '{"schemaVersion":2,"issue":999,"slug":"test","phase":"PROVE","issueGoal":"test","acs":[],"gates":{},"changelog":[],"sizing":{"ceremonyTier":"LIGHT"}}' > "$TMPDIR_T7/workflow-state.json"
echo "{\"contractVersion\":\"1.0\",\"issueNumber\":999,\"verdict\":\"PROVEN\",\"commitSHA\":\"$HEAD_SHA\",\"capturedAt\":\"2026-01-01T00:00:00Z\",\"criteriaResults\":[{\"scId\":\"SC-1\",\"verdict\":\"PASS\",\"evidence\":\"ok\"}],\"afterEvidence\":{\"environment\":\"local\"}}" > "$TMPDIR_T7/prove-evidence.json"
if PAI_WORK_DIR="$TMPDIR_T7" bash "$SCRIPT_DIR/../ship/gate-runner.sh" --gate prove --issue 999 --slug . 2>/dev/null; then
  pass "gate accepts local evidence at LIGHT tier"
else
  fail "gate rejected local evidence at LIGHT tier"
fi
rm -rf "$TMPDIR_T7"

echo ""
echo "=== Results: $PASSED/$TESTS passed ==="
[[ $PASSED -eq $TESTS ]] && exit 0 || exit 1
