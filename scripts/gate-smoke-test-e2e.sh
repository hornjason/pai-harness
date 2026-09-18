#!/usr/bin/env bash
# gate-smoke-test-e2e.sh — Seeded integration tests for the harness gate chain
# Creates workflow-states with KNOWN inputs + violations, runs gates, verifies results.
# Usage: bash scripts/gate-smoke-test-e2e.sh [--verbose]
set -euo pipefail

VERBOSE=false
[[ "${1:-}" == "--verbose" ]] && VERBOSE=true

BASE_DIR="${HOME}/.claude"
WORK_BASE="${RUNGATE_WORK_DIR:-${HOME}/.rungate}/smoke-test"
GATE_RUNNER="$BASE_DIR/skills/ship/gate-runner.sh"
PASS_COUNT=0
FAIL_COUNT=0
TOTAL=0

cleanup() { rm -rf "$WORK_BASE"; }
trap cleanup EXIT
mkdir -p "$WORK_BASE"

run_gate() {
  local slug="$1" gate="$2" issue="$3"
  bash "$GATE_RUNNER" --gate "$gate" --issue "$issue" --slug "smoke-test/$slug" 2>&1
}

assert_check() {
  local output="$1" check_name="$2" expected_result="$3" test_label="$4"
  TOTAL=$((TOTAL + 1))
  local actual=""
  if echo "$output" | grep -q "FAIL: $check_name"; then
    actual="FAIL"
  elif echo "$output" | grep -q "WARN: $check_name"; then
    actual="WARN"
  elif echo "$output" | grep -q "ALL CLEAR\|pass"; then
    # Check wasn't mentioned as FAIL or WARN — it passed
    actual="PASS"
  else
    actual="UNKNOWN"
  fi

  if [[ "$actual" == "$expected_result" ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  ✓ $test_label: $check_name = $expected_result"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "  ✗ $test_label: $check_name expected=$expected_result actual=$actual"
    if [[ "$VERBOSE" == "true" ]]; then
      echo "    --- output ---"
      echo "$output" | grep -E "$check_name|GATE:|CLEAR|BLOCKED" | head -5
      echo "    ---"
    fi
  fi
}

assert_gate_result() {
  local output="$1" expected="$2" test_label="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$output" | grep -q "$expected"; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  ✓ $test_label: gate = $expected"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "  ✗ $test_label: gate expected $expected"
    if [[ "$VERBOSE" == "true" ]]; then
      echo "$output" | tail -3
    fi
  fi
}

# ═══════════════════════════════════════════════════════════════════════════
# TEST 1: HAPPY PATH — valid SCs, proper spec, all thresholds met
# Expected: scope gate ALL CLEAR
# ═══════════════════════════════════════════════════════════════════════════
echo "TEST 1: Happy path — scope gate"
SLUG="happy"
mkdir -p "$WORK_BASE/$SLUG"
cat > "$WORK_BASE/$SLUG/workflow-state.json" << 'SEED'
{
  "schemaVersion": 2,
  "issue": 99901,
  "repo": "hornjason/pai-config",
  "issueRepo": "hornjason/pai-config",
  "projectRoot": "/Users/jhorn/.claude",
  "slug": "smoke-test/happy",
  "phase": "SCOPE",
  "issueGoal": "Test issue — validate happy path through scope gate",
  "acs": [
    {
      "id": "SC-1",
      "type": "CODE",
      "statement": "scripts/lib/gap-emit.sh exists and is executable",
      "threshold": {"op": ">=", "value": "1"},
      "evidenceMethod": {"type": "pattern", "command": "echo 1"}
    },
    {
      "id": "SC-2",
      "type": "CODE",
      "statement": "gate-runner.sh has HMAC computation",
      "threshold": {"op": ">=", "value": "1"},
      "evidenceMethod": {"type": "unit", "command": "echo 1"}
    }
  ],
  "gates": {},
  "changelog": [],
  "sizing": {"predicted": "S", "ceremonyTier": "STANDARD"},
  "sourceSpecs": [{"path": "PAI/specs/harness-automation-matrix.md", "citedInDiscovery": true}],
  "codeCommittedPaths": ["scripts/lib/gap-emit.sh"],
  "iterationCount": 0
}
SEED

OUTPUT=$(run_gate "$SLUG" scope 99901)
assert_gate_result "$OUTPUT" "ALL CLEAR" "T1"
assert_check "$OUTPUT" "acs-exist" "PASS" "T1"
assert_check "$OUTPUT" "acs-have-type" "PASS" "T1"
assert_check "$OUTPUT" "acs-have-threshold" "PASS" "T1"
assert_check "$OUTPUT" "issue-goal-captured" "PASS" "T1"
assert_check "$OUTPUT" "acs-no-behavioral-language" "PASS" "T1"
assert_check "$OUTPUT" "acs-no-skillmd-enforcement" "PASS" "T1"

# ═══════════════════════════════════════════════════════════════════════════
# TEST 2: SPEC VIOLATION — behavioral language + SKILL.md target
# Expected: scope gate WARNs on behavioral language and skillmd enforcement
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "TEST 2: Spec violations — behavioral language + SKILL.md target"
SLUG="specviol"
mkdir -p "$WORK_BASE/$SLUG"
cat > "$WORK_BASE/$SLUG/workflow-state.json" << 'SEED'
{
  "schemaVersion": 2,
  "issue": 99902,
  "repo": "hornjason/pai-config",
  "issueRepo": "hornjason/pai-config",
  "projectRoot": "/Users/jhorn/.claude",
  "slug": "smoke-test/specviol",
  "phase": "SCOPE",
  "issueGoal": "Test issue — seeded spec violations",
  "acs": [
    {
      "id": "SC-1",
      "type": "CODE",
      "statement": "DA should remember to update SKILL.md after changes",
      "threshold": {"op": ">=", "value": "1"},
      "evidenceMethod": {"type": "pattern", "command": "grep -c test SKILL.md"}
    },
    {
      "id": "SC-2",
      "type": "CODE",
      "statement": "Verify the function exists in scripts/lib/",
      "threshold": {"op": ">=", "value": "1"},
      "evidenceMethod": {"type": "pattern", "command": "echo 1"}
    }
  ],
  "gates": {},
  "changelog": [],
  "sizing": {"predicted": "S", "ceremonyTier": "STANDARD"},
  "sourceSpecs": [{"path": "PAI/specs/harness-automation-matrix.md", "citedInDiscovery": true}],
  "codeCommittedPaths": [],
  "iterationCount": 0
}
SEED

OUTPUT=$(run_gate "$SLUG" scope 99902)
assert_check "$OUTPUT" "acs-no-behavioral-language" "WARN" "T2"
assert_check "$OUTPUT" "acs-no-skillmd-enforcement" "WARN" "T2"
assert_check "$OUTPUT" "acs-exist" "PASS" "T2"

# ═══════════════════════════════════════════════════════════════════════════
# TEST 3: EVIDENCE QUALITY — all pattern-type evidence (>50%)
# Expected: verify gate WARNs on evidence-type-ratio
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "TEST 3: Evidence quality — all pattern-type evidence"
SLUG="evqual"
mkdir -p "$WORK_BASE/$SLUG"
cat > "$WORK_BASE/$SLUG/workflow-state.json" << 'SEED'
{
  "schemaVersion": 2,
  "issue": 99903,
  "repo": "hornjason/pai-config",
  "issueRepo": "hornjason/pai-config",
  "projectRoot": "/Users/jhorn/.claude",
  "slug": "smoke-test/evqual",
  "phase": "VERIFY",
  "issueGoal": "Test — evidence quality ratio check",
  "acs": [
    {
      "id": "SC-1",
      "type": "CODE",
      "statement": "Function exists",
      "threshold": {"op": ">=", "value": "1"},
      "evidenceMethod": {"type": "pattern", "command": "echo 1"},
      "verdict": "PASS",
      "evidence": "1"
    },
    {
      "id": "SC-2",
      "type": "CODE",
      "statement": "File contains keyword",
      "threshold": {"op": ">=", "value": "1"},
      "evidenceMethod": {"type": "pattern", "command": "echo 1"},
      "verdict": "PASS",
      "evidence": "1"
    },
    {
      "id": "SC-3",
      "type": "CODE",
      "statement": "Config value present",
      "threshold": {"op": ">=", "value": "1"},
      "evidenceMethod": {"type": "pattern", "command": "echo 1"},
      "verdict": "PASS",
      "evidence": "1"
    }
  ],
  "gates": {"scope": {"result": "PASS"}},
  "changelog": [],
  "sizing": {"predicted": "S", "ceremonyTier": "STANDARD"},
  "environments": {"local": {"api": "SKIP", "ui": "SKIP", "uiSkipReason": "test", "tests": "none"}},
  "sourceSpecs": [{"path": "PAI/specs/harness-automation-matrix.md", "citedInDiscovery": true}],
  "codeCommittedPaths": [],
  "iterationCount": 0
}
SEED

OUTPUT=$(run_gate "$SLUG" verify 99903)
assert_check "$OUTPUT" "evidence-type-ratio" "WARN" "T3"
assert_check "$OUTPUT" "all-acs-pass" "PASS" "T3"

# ═══════════════════════════════════════════════════════════════════════════
# TEST 4: DECISION-ID TRACING — references D-999 (doesn't exist in spec)
# Expected: verify gate WARNs on decision-id-valid
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "TEST 4: Decision-ID tracing — bogus D-999"
SLUG="decid"
mkdir -p "$WORK_BASE/$SLUG"
cat > "$WORK_BASE/$SLUG/workflow-state.json" << 'SEED'
{
  "schemaVersion": 2,
  "issue": 99904,
  "repo": "hornjason/pai-config",
  "issueRepo": "hornjason/pai-config",
  "projectRoot": "/Users/jhorn/.claude",
  "slug": "smoke-test/decid",
  "phase": "VERIFY",
  "issueGoal": "Test — decision ID validation",
  "acs": [
    {
      "id": "SC-1",
      "type": "CODE",
      "statement": "Implements D-999 bogus decision that does not exist",
      "threshold": {"op": ">=", "value": "1"},
      "evidenceMethod": {"type": "unit", "command": "echo 1"},
      "verdict": "PASS",
      "evidence": "1"
    }
  ],
  "gates": {"scope": {"result": "PASS"}},
  "changelog": [],
  "sizing": {"predicted": "S", "ceremonyTier": "STANDARD"},
  "environments": {"local": {"api": "SKIP", "ui": "SKIP", "uiSkipReason": "test", "tests": "none"}},
  "sourceSpecs": [{"path": "PAI/specs/harness-automation-matrix.md", "citedInDiscovery": true}],
  "codeCommittedPaths": [],
  "iterationCount": 0
}
SEED

OUTPUT=$(run_gate "$SLUG" verify 99904)
assert_check "$OUTPUT" "decision-id-valid" "WARN" "T4"

# ═══════════════════════════════════════════════════════════════════════════
# TEST 5: MISSING GATES — ship gate without scope+verify PASS
# Expected: ship gate FAILs on all-gates-pass
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "TEST 5: Missing gates — ship without scope+verify"
SLUG="nogatepre"
mkdir -p "$WORK_BASE/$SLUG"
cat > "$WORK_BASE/$SLUG/workflow-state.json" << 'SEED'
{
  "schemaVersion": 2,
  "issue": 99905,
  "repo": "hornjason/pai-config",
  "issueRepo": "hornjason/pai-config",
  "projectRoot": "/Users/jhorn/.claude",
  "slug": "smoke-test/nogatepre",
  "phase": "SHIP",
  "issueGoal": "Test — missing prerequisite gates",
  "acs": [
    {
      "id": "SC-1",
      "type": "CODE",
      "statement": "Something",
      "threshold": {"op": ">=", "value": "1"},
      "evidenceMethod": {"type": "pattern", "command": "echo 1"},
      "verdict": "PASS",
      "evidence": "1"
    }
  ],
  "gates": {},
  "changelog": [],
  "sizing": {"predicted": "S", "ceremonyTier": "STANDARD"},
  "codeCommittedPaths": [],
  "iterationCount": 0
}
SEED

OUTPUT=$(run_gate "$SLUG" ship 99905 || true)
assert_check "$OUTPUT" "all-gates-pass" "FAIL" "T5"

# ═══════════════════════════════════════════════════════════════════════════
# TEST 6: NO ACs — scope gate should FAIL on acs-exist
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "TEST 6: No ACs — scope gate"
SLUG="noacs"
mkdir -p "$WORK_BASE/$SLUG"
cat > "$WORK_BASE/$SLUG/workflow-state.json" << 'SEED'
{
  "schemaVersion": 2,
  "issue": 99906,
  "repo": "hornjason/pai-config",
  "issueRepo": "hornjason/pai-config",
  "projectRoot": "/Users/jhorn/.claude",
  "slug": "smoke-test/noacs",
  "phase": "SCOPE",
  "issueGoal": "Test — empty ACs should fail",
  "acs": [],
  "gates": {},
  "changelog": [],
  "sizing": {"predicted": "S", "ceremonyTier": "STANDARD"},
  "codeCommittedPaths": [],
  "iterationCount": 0
}
SEED

OUTPUT=$(run_gate "$SLUG" scope 99906 || true)
assert_check "$OUTPUT" "acs-exist" "FAIL" "T6"

# ═══════════════════════════════════════════════════════════════════════════
# TEST 7: MIXED EVIDENCE — 1 pattern + 2 unit (under 50%)
# Expected: evidence-type-ratio PASS
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "TEST 7: Mixed evidence — under 50% pattern"
SLUG="mixedev"
mkdir -p "$WORK_BASE/$SLUG"
cat > "$WORK_BASE/$SLUG/workflow-state.json" << 'SEED'
{
  "schemaVersion": 2,
  "issue": 99907,
  "repo": "hornjason/pai-config",
  "issueRepo": "hornjason/pai-config",
  "projectRoot": "/Users/jhorn/.claude",
  "slug": "smoke-test/mixedev",
  "phase": "VERIFY",
  "issueGoal": "Test — mixed evidence types",
  "acs": [
    {
      "id": "SC-1", "type": "CODE", "statement": "grep check",
      "threshold": {"op": ">=", "value": "1"},
      "evidenceMethod": {"type": "pattern", "command": "echo 1"},
      "verdict": "PASS", "evidence": "1"
    },
    {
      "id": "SC-2", "type": "CODE", "statement": "unit test",
      "threshold": {"op": ">=", "value": "1"},
      "evidenceMethod": {"type": "unit", "command": "echo 1"},
      "verdict": "PASS", "evidence": "1"
    },
    {
      "id": "SC-3", "type": "CODE", "statement": "behavioral test",
      "threshold": {"op": ">=", "value": "1"},
      "evidenceMethod": {"type": "behavioral", "command": "echo 1"},
      "verdict": "PASS", "evidence": "1"
    }
  ],
  "gates": {"scope": {"result": "PASS"}},
  "changelog": [],
  "sizing": {"predicted": "S", "ceremonyTier": "STANDARD"},
  "environments": {"local": {"api": "SKIP", "ui": "SKIP", "uiSkipReason": "test", "tests": "none"}},
  "sourceSpecs": [{"path": "PAI/specs/harness-automation-matrix.md", "citedInDiscovery": true}],
  "codeCommittedPaths": [],
  "iterationCount": 0
}
SEED

OUTPUT=$(run_gate "$SLUG" verify 99907)
assert_check "$OUTPUT" "evidence-type-ratio" "PASS" "T7"

# ═══════════════════════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "════════════════════════════════════════"
echo "  SMOKE TEST RESULTS: $PASS_COUNT pass, $FAIL_COUNT fail (of $TOTAL)"
echo "════════════════════════════════════════"
if [[ $FAIL_COUNT -gt 0 ]]; then
  echo "  ✗ SOME TESTS FAILED — gates are not catching what they should"
  exit 1
else
  echo "  ✓ ALL TESTS PASSED — gates are working correctly"
  exit 0
fi
