#!/usr/bin/env bash
# skill-qc-test.sh — Automated QC tests for ADR-007 skill contracts
# Run: bash scripts/skill-qc-test.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
PASS=0; FAIL=0; TOTAL=0

pass() { echo "  PASS $1"; PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); }
fail() { echo "  FAIL $1" >&2; FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); }

echo "1. Schema prerequisite checks"
[[ $(jq '.properties.successCriteria.minItems' schemas/goal-record.schema.json) -ge 1 ]] && pass "goal-record successCriteria minItems" || fail "goal-record successCriteria minItems"
[[ $(jq '.properties.criteriaResults.minItems' skills/prove/prove-evidence.schema.json) -ge 1 ]] && pass "prove-evidence criteriaResults minItems" || fail "prove-evidence criteriaResults minItems"
[[ $(jq '.properties.gateOut.properties.evidence.minItems' schemas/ship-evidence.schema.json) -ge 1 ]] && pass "ship-evidence gateOut.evidence minItems" || fail "ship-evidence gateOut.evidence minItems"
[[ $(jq '.properties.assets.minItems' schemas/release-proof.schema.json) -ge 1 ]] && pass "release-proof assets minItems" || fail "release-proof assets minItems"

echo "2. contractVersion checks"
jq -e '.required | index("contractVersion")' skills/prove/prove-evidence.schema.json >/dev/null 2>&1 && pass "prove-evidence has contractVersion required" || fail "prove-evidence missing contractVersion"

echo "3. gaps[] schema check"
jq -e '.properties.gaps' skills/prove/prove-evidence.schema.json >/dev/null 2>&1 && pass "prove-evidence has gaps[] schema" || fail "prove-evidence missing gaps[]"

echo "4. Validator \$ref resolution"
# Create a minimal valid GoalRecord and validate it — if $ref fails, this catches it
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
cat > "$TMPDIR/test-goal-record.json" << 'FIXTURE'
{
  "contractVersion": "1.0",
  "id": "test-1",
  "goalStatement": "Test goal",
  "successCriteria": [
    {"id": "SC-1", "assertion": "test passes", "evidenceType": "test-pass", "threshold": {"op": "==", "value": "0", "unit": "failures"}}
  ],
  "scopeBoundary": {"in": ["src/"], "out": ["docs/"]},
  "artifactRef": {"type": "github-issue", "locator": "test/test#1"}
}
FIXTURE
bash scripts/validate-skill-output.sh goal "$TMPDIR/test-goal-record.json" >/dev/null 2>&1 && pass "GoalRecord with evidenceType validates (\$ref works)" || fail "GoalRecord validation failed (\$ref broken)"

echo "5. Validator hard-fail on missing jsonschema"
# Test that the validator script contains exit 1 for missing jsonschema, not exit 0
grep -q "sys.exit(1)" scripts/validate-skill-output.sh && pass "Validator hard-fails on missing jsonschema" || fail "Validator silently passes on missing jsonschema"

echo "6. #1318 prevention tests"
# Test: empty criteriaResults with PROVEN must be rejected
cat > "$TMPDIR/test-false-proven-empty.json" << 'FIXTURE'
{
  "contractVersion": "1.0",
  "issueNumber": 1,
  "verdict": "PROVEN",
  "commitSHA": "abc123",
  "capturedAt": "2026-01-01T00:00:00Z",
  "criteriaResults": []
}
FIXTURE
bash scripts/validate-skill-output.sh prove "$TMPDIR/test-false-proven-empty.json" >/dev/null 2>&1 && fail "PROVEN with empty criteriaResults accepted (should reject)" || pass "PROVEN with empty criteriaResults rejected"

# Test: valid prove-evidence with non-empty criteriaResults should pass
cat > "$TMPDIR/test-valid-prove.json" << 'FIXTURE'
{
  "contractVersion": "1.0",
  "issueNumber": 1,
  "verdict": "PROVEN",
  "commitSHA": "abc123",
  "capturedAt": "2026-01-01T00:00:00Z",
  "criteriaResults": [
    {"scId": "SC-1", "verdict": "PASS", "evidence": "test passed"}
  ]
}
FIXTURE
bash scripts/validate-skill-output.sh prove "$TMPDIR/test-valid-prove.json" >/dev/null 2>&1 && pass "Valid prove-evidence accepted" || fail "Valid prove-evidence rejected"

# 6b. #1318 strict mode prevention
cat > "$TMPDIR/proven-with-fail.json" << 'FIXTURE'
{
  "contractVersion": "1.0",
  "issueNumber": 1,
  "verdict": "PROVEN",
  "commitSHA": "abc123",
  "capturedAt": "2026-01-01T00:00:00Z",
  "criteriaResults": [
    {"scId": "SC-1", "verdict": "PASS", "evidence": "ok"},
    {"scId": "SC-2", "verdict": "FAIL", "evidence": "not attempted"}
  ]
}
FIXTURE
bash scripts/validate-skill-output.sh prove "$TMPDIR/proven-with-fail.json" --strict 2>/dev/null && fail "PROVEN+FAIL accepted in strict mode" || pass "PROVEN+FAIL rejected in strict mode"

echo "7. Empty array rejection tests"
# Empty successCriteria
cat > "$TMPDIR/test-empty-sc.json" << 'FIXTURE'
{
  "contractVersion": "1.0",
  "id": "test-1",
  "goalStatement": "Test",
  "successCriteria": [],
  "scopeBoundary": {"in": ["src/"], "out": ["docs/"]},
  "artifactRef": {"type": "github-issue", "locator": "test#1"}
}
FIXTURE
bash scripts/validate-skill-output.sh goal "$TMPDIR/test-empty-sc.json" >/dev/null 2>&1 && fail "Empty successCriteria accepted (should reject)" || pass "Empty successCriteria rejected"

# Empty gateOut.evidence
cat > "$TMPDIR/test-empty-evidence.json" << 'FIXTURE'
{
  "contractVersion": "1.0",
  "issueNumber": 1,
  "gateOut": {"status": "PASS", "evidence": []},
  "mergeCommitSha": "abc123",
  "capturedAt": "2026-01-01T00:00:00Z"
}
FIXTURE
bash scripts/validate-skill-output.sh ship "$TMPDIR/test-empty-evidence.json" >/dev/null 2>&1 && fail "Empty gateOut.evidence accepted (should reject)" || pass "Empty gateOut.evidence rejected"

# Empty assets
cat > "$TMPDIR/test-empty-assets.json" << 'FIXTURE'
{
  "contractVersion": "1.0",
  "version": "1.0.0",
  "gate4Result": "PASS",
  "assets": [],
  "capturedAt": "2026-01-01T00:00:00Z"
}
FIXTURE
bash scripts/validate-skill-output.sh release "$TMPDIR/test-empty-assets.json" >/dev/null 2>&1 && fail "Empty assets accepted (should reject)" || pass "Empty assets rejected"

echo "8. Slug resolver tests"
[[ $(bash scripts/slug-resolver.sh hornjason/pai-config) == "pai" ]] && pass "pai-config -> pai" || fail "pai-config slug wrong"
[[ $(bash scripts/slug-resolver.sh hornjason/asaCommandCenter) == "ddb" ]] && pass "asaCommandCenter -> ddb" || fail "asaCommandCenter slug wrong"
bash scripts/slug-resolver.sh unknown/repo >/dev/null 2>&1 && fail "Unknown repo accepted (should fail)" || pass "Unknown repo rejected"

echo "9. GoalRecord TTL exemption"
# Verify StaleTTLCleanup.hook.sh checks for goal-record
grep -q 'goal-record' hooks/StaleTTLCleanup.hook.sh && pass "TTL exemption for goal-record.json" || fail "TTL exemption missing"

echo "10. Regression — prove smoke tests"
bash skills/prove/prove-smoke-test.sh >/dev/null 2>&1 && pass "prove-smoke-test.sh passes" || fail "prove-smoke-test.sh failed"

echo "11. Batch status tests"
SAVED_RUNGATE_WORK_DIR="${RUNGATE_WORK_DIR:-}"
export RUNGATE_WORK_DIR="$TMPDIR"

bash "$REPO_ROOT/scripts/batch-status.sh" init "test-batch" >/dev/null 2>&1 && \
  [[ -f "$TMPDIR/batch-test-batch/batch-status.json" ]] && pass "batch-status init creates file" || fail "batch-status init"

bash "$REPO_ROOT/scripts/batch-status.sh" update "test-batch" 123 "SHIP" "IN_PROGRESS" >/dev/null 2>&1 || true
ISSUE_COUNT=$(python3 -c "import json; print(len(json.load(open('$TMPDIR/batch-test-batch/batch-status.json')).get('issues',[])))" 2>/dev/null || echo "0")
[[ "$ISSUE_COUNT" == "1" ]] && pass "batch-status update adds issue" || fail "batch-status update issue count ($ISSUE_COUNT)"

bash "$REPO_ROOT/scripts/batch-status.sh" update "test-batch" 123 "PROVE" "DONE" >/dev/null 2>&1 || true
PHASE=$(python3 -c "import json; print(json.load(open('$TMPDIR/batch-test-batch/batch-status.json'))['issues'][0]['phase'])" 2>/dev/null || echo "?")
[[ "$PHASE" == "PROVE" ]] && pass "batch-status atomic update" || fail "batch-status atomic update ($PHASE)"

if [[ -n "$SAVED_RUNGATE_WORK_DIR" ]]; then export RUNGATE_WORK_DIR="$SAVED_RUNGATE_WORK_DIR"; else unset RUNGATE_WORK_DIR; fi

echo "12. Chain detection documentation tests"
grep -q "Chain Detection" "$REPO_ROOT/skills/ship/SKILL.md" && pass "ship has Chain Detection section" || fail "ship missing Chain Detection"
grep -q "Chain Detection" "$REPO_ROOT/skills/prove/SKILL.md" && pass "prove has Chain Detection section" || fail "prove missing Chain Detection"
grep -q "Chain Detection" "$REPO_ROOT/skills/release/SKILL.md" && pass "release has Chain Detection section" || fail "release missing Chain Detection"
grep -q "test -f" "$REPO_ROOT/skills/ship/SKILL.md" && pass "ship uses file-presence detection" || fail "ship missing file-presence"
grep -q "test -f" "$REPO_ROOT/skills/prove/SKILL.md" && pass "prove uses file-presence detection" || fail "prove missing file-presence"
grep -q "test -f" "$REPO_ROOT/skills/release/SKILL.md" && pass "release uses file-presence detection" || fail "release missing file-presence"

echo "13. Council synthesis schema tests"
python3 -c "import json; json.load(open('$REPO_ROOT/schemas/council-synthesis.schema.json'))" 2>/dev/null && \
  pass "council-synthesis.schema.json is valid JSON" || fail "council-synthesis.schema.json invalid"

cat > "$TMPDIR/test-council-synthesis.json" << 'FIXTURE'
{
  "contractVersion": "1.0",
  "topic": "Test topic",
  "decisions": [
    {"id": "D-001", "statement": "Use file presence", "disposition": "ACCEPTED", "target": {"type": "adr", "ref": "test.md"}}
  ],
  "convergencePoints": ["all agree"],
  "recommendation": "do it",
  "capturedAt": "2026-01-01T00:00:00Z"
}
FIXTURE
bash "$REPO_ROOT/scripts/validate-skill-output.sh" council "$TMPDIR/test-council-synthesis.json" >/dev/null 2>&1 && \
  pass "Council synthesis validates against schema" || fail "Council synthesis validation failed"

echo "14. Chain compatibility tests"
bash "$REPO_ROOT/scripts/chain-compat-check.sh" >/dev/null 2>&1 && \
  pass "L3 chain compatibility check passes" || fail "L3 chain compatibility check failed"

echo "15. Chain state schema test"
python3 -c "import json; json.load(open('$REPO_ROOT/schemas/chain-state.schema.json'))" 2>/dev/null && \
  pass "chain-state.schema.json is valid JSON" || fail "chain-state.schema.json invalid"

echo "16. Goal routing tests"
# Verify goal-record schema has artifactRef.type enum
python3 -c "
import json
schema = json.load(open('$REPO_ROOT/schemas/goal-record.schema.json'))
art_type = schema['properties']['artifactRef']['properties']['type']
assert 'enum' in art_type, 'artifactRef.type missing enum'
assert 'github-issue' in art_type['enum'], 'missing github-issue'
assert 'adr' in art_type['enum'], 'missing adr'
assert 'research-brief' in art_type['enum'], 'missing research-brief'
print('OK')
" 2>/dev/null && pass "artifactRef.type has 5-value enum" || fail "artifactRef.type enum missing"

# Verify goal SKILL.md has classification decision tree
grep -q "classifyGoalType\|Goal Type Classification" "$REPO_ROOT/skills/goal/SKILL.md" && \
  pass "goal SKILL.md has type classification" || fail "goal SKILL.md missing classification"

# Validate GoalRecord with adr type
cat > "$TMPDIR/test-goal-adr.json" << 'FIXTURE'
{
  "contractVersion": "1.0",
  "id": "adr-007",
  "goalStatement": "Design universal skill contract",
  "successCriteria": [{"id": "SC-1", "assertion": "10-field contract defined", "evidenceType": "grep", "threshold": {"op": "==", "value": "10", "unit": "fields"}}],
  "scopeBoundary": {"in": ["PAI/ADR/"], "out": ["src/"]},
  "artifactRef": {"type": "adr", "locator": "PAI/ADR/ADR-007-universal-skill-contract.md"}
}
FIXTURE
bash "$REPO_ROOT/scripts/validate-skill-output.sh" goal "$TMPDIR/test-goal-adr.json" >/dev/null 2>&1 && \
  pass "GoalRecord with adr type validates" || fail "GoalRecord with adr type rejected"

echo "17. Skill runner tests"
# Test pre-phase with goal skill
mkdir -p "$TMPDIR/runner-test"
echo '{"schemaVersion":2,"issue":999,"slug":"test","phase":"GOAL","issueGoal":"test","acs":[],"gates":{},"changelog":[]}' > "$TMPDIR/runner-test/workflow-state.json"
RUNGATE_WORK_DIR="$TMPDIR" bash "$REPO_ROOT/scripts/skill-runner.sh" --phase pre --skill goal --issue 999 --slug runner-test >/dev/null 2>&1 && \
  pass "runner pre-phase goal passes" || fail "runner pre-phase goal failed"

# Test post-phase with valid artifact
cat > "$TMPDIR/runner-test/goal-record.json" << 'FIXTURE'
{"contractVersion":"1.0","id":"test","goalStatement":"test","successCriteria":[{"id":"SC-1","assertion":"test","evidenceType":"grep","threshold":{"op":"==","value":"0","unit":"matches"}}],"scopeBoundary":{"in":["test"],"out":["test"]},"artifactRef":{"type":"github-issue","locator":"hornjason/pai-config#999"}}
FIXTURE
RUNGATE_WORK_DIR="$TMPDIR" bash "$REPO_ROOT/scripts/skill-runner.sh" --phase post --skill goal --issue 999 --slug runner-test --artifact "$TMPDIR/runner-test/goal-record.json" >/dev/null 2>&1 && \
  pass "runner post-phase goal passes" || fail "runner post-phase goal failed"

# Test chain-state.json was created
[[ -f "$TMPDIR/runner-test/chain-state.json" ]] && pass "runner creates chain-state.json" || fail "runner missing chain-state.json"

# Test post-phase catches missing artifact (Assert)
RUNGATE_WORK_DIR="$TMPDIR" bash "$REPO_ROOT/scripts/skill-runner.sh" --phase post --skill ship --issue 999 --slug runner-test 2>/dev/null && \
  fail "runner should fail on missing ship artifact" || pass "runner Assert fails on missing artifact"

echo "18. Runner Assert/Suggest classification"
# Verify runner uses assert_fail for hard errors
grep -q "assert_fail" "$REPO_ROOT/scripts/skill-runner.sh" && pass "runner has assert_fail" || fail "runner missing assert_fail"
grep -q "suggest_warn" "$REPO_ROOT/scripts/skill-runner.sh" && pass "runner has suggest_warn" || fail "runner missing suggest_warn"

echo "19. Audit skill tests"
[[ -f "$REPO_ROOT/skills/audit/SKILL.md" ]] && pass "audit SKILL.md exists" || fail "audit SKILL.md missing"
grep -q "outputSchema:" "$REPO_ROOT/skills/audit/SKILL.md" && pass "audit has outputSchema" || fail "audit missing outputSchema"

python3 -c "import json; json.load(open('$REPO_ROOT/schemas/audit-report.schema.json'))" 2>/dev/null && \
  pass "audit-report.schema.json valid JSON" || fail "audit-report.schema.json invalid"

cat > "$TMPDIR/test-audit-report.json" << 'FIXTURE'
{
  "contractVersion": "1.0",
  "scope": {"topic": "test"},
  "findings": [{"id": "F-001", "severity": "MEDIUM", "description": "test finding", "status": "OPEN"}],
  "summary": {"totalFindings": 1, "openCount": 1, "resolvedCount": 0},
  "capturedAt": "2026-01-01T00:00:00Z"
}
FIXTURE
bash "$REPO_ROOT/scripts/validate-skill-output.sh" audit "$TMPDIR/test-audit-report.json" >/dev/null 2>&1 && \
  pass "audit report validates against schema" || fail "audit report validation failed"

echo "20. Research output schema tests"
python3 -c "import json; json.load(open('$REPO_ROOT/schemas/research-output.schema.json'))" 2>/dev/null && \
  pass "research-output.schema.json valid JSON" || fail "research-output.schema.json invalid"

cat > "$TMPDIR/test-research-output.json" << 'FIXTURE'
{
  "contractVersion": "1.0",
  "query": "What frameworks handle chain state?",
  "findings": [{"claim": "Temporal uses event sourcing", "confidence": "HIGH", "source": "temporal.io docs"}],
  "sources": [{"name": "Temporal Docs", "type": "documentation"}],
  "capturedAt": "2026-01-01T00:00:00Z"
}
FIXTURE
python3 -c "
from jsonschema import validate
import json
schema = json.load(open('$REPO_ROOT/schemas/research-output.schema.json'))
data = json.load(open('$TMPDIR/test-research-output.json'))
validate(instance=data, schema=schema)
print('PASS')
" 2>/dev/null && pass "research output validates against schema" || fail "research output validation failed"

echo "21. Learn signal schema tests"
python3 -c "import json; json.load(open('$REPO_ROOT/schemas/learn-signal.schema.json'))" 2>/dev/null && \
  pass "learn-signal.schema.json valid JSON" || fail "learn-signal.schema.json invalid"

cat > "$TMPDIR/test-learn-signal.json" << 'FIXTURE'
{
  "signalType": "skill-learn",
  "schemaVersion": "1.0",
  "ts": "2026-01-01T00:00:00Z",
  "skill": "prove",
  "issue": 290,
  "slug": "pai/290",
  "mode": "chain",
  "duration_ms": 1234,
  "metrics": {"criteriaCount": 5, "criteriaPass": 4, "gapCount": 1}
}
FIXTURE
python3 -c "
from jsonschema import validate
import json
schema = json.load(open('$REPO_ROOT/schemas/learn-signal.schema.json'))
data = json.load(open('$TMPDIR/test-learn-signal.json'))
validate(instance=data, schema=schema)
print('PASS')
" 2>/dev/null && pass "learn signal validates against schema" || fail "learn signal validation failed"

echo "22. Performance profile schema tests"
python3 -c "import json; json.load(open('$REPO_ROOT/schemas/performance-profile.schema.json'))" 2>/dev/null && \
  pass "performance-profile.schema.json valid JSON" || fail "performance-profile.schema.json invalid"

# Validate a sample profile
cat > "$TMPDIR/test-profile.json" << 'FIXTURE'
{
  "skill": "prove",
  "executions": 47,
  "avgCriteriaHitRate": 0.82,
  "avgIterations": 1.3,
  "gapRate": 0.18,
  "topGapTypes": ["UI AC never verified", "before-state not captured"],
  "trend": "improving",
  "generatedAt": "2026-01-01T00:00:00Z"
}
FIXTURE
python3 -c "
from jsonschema import validate
import json
schema = json.load(open('$REPO_ROOT/schemas/performance-profile.schema.json'))
data = json.load(open('$TMPDIR/test-profile.json'))
validate(instance=data, schema=schema)
print('PASS')
" 2>/dev/null && pass "performance profile validates" || fail "performance profile validation failed"

echo "23. Feedback loop documentation tests"
grep -q "Performance Profile\|performance profile" "$REPO_ROOT/skills/audit/SKILL.md" && \
  pass "audit SKILL.md documents profile consumption" || fail "audit missing profile docs"
grep -q "Research Mode\|performance profile\|Performance Data" "$REPO_ROOT/skills/council/SKILL.md" && \
  pass "council SKILL.md documents research mode" || fail "council missing research mode docs"

echo ""
echo "=== Results: $PASS/$TOTAL passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
