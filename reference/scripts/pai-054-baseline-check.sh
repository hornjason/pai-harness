#!/bin/bash
# PAI-054 Baseline Review — runs 2026-04-29
# Checks sessions.jsonl for sufficient baseline data before PAI-060 ships
# Scheduled by: PAI sprint 2026-04-23

SESSIONS_FILE="$HOME/.claude/MEMORY/LEARNING/SIGNALS/sessions.jsonl"
PENDING_FILE="$HOME/.claude/MEMORY/LEARNING/PENDING-RULES.md"

if [ ! -f "$SESSIONS_FILE" ]; then
  echo "[PAI-054-check] sessions.jsonl not found — hook may not have fired yet" >> "$HOME/.claude/scripts/baseline-check.log"
  # Write notification to pending file
  cat >> "$PENDING_FILE" << 'EOF'

## PAI-054 Baseline Review — 2026-04-29
**Status:** FAIL — sessions.jsonl missing. SentimentScorer hook may not have fired.
**Action:** Check if SentimentScorer.hook.ts is wired in settings.json. Run a test session and verify sessions.jsonl appears.
EOF
  exit 0
fi

ROW_COUNT=$(wc -l < "$SESSIONS_FILE" | tr -d ' ')
FIRST_DATE=$(head -1 "$SESSIONS_FILE" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('timestamp','?')[:10])" 2>/dev/null)
LAST_DATE=$(tail -1 "$SESSIONS_FILE" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('timestamp','?')[:10])" 2>/dev/null)

echo "[PAI-054-check] rows=$ROW_COUNT first=$FIRST_DATE last=$LAST_DATE" >> "$HOME/.claude/scripts/baseline-check.log"

# Write review summary to PENDING-RULES.md for next session pickup
cat >> "$PENDING_FILE" << EOF

## PAI-054 Baseline Review — $(date +%Y-%m-%d)
**Status:** $ROW_COUNT sessions collected | $FIRST_DATE → $LAST_DATE
**Threshold:** 5+ days, 10+ sessions for migration review gate
**Action needed:** If threshold met — run schema migration review, then clear PAI-060 to ship.
  Run: \`tail -5 ~/.claude/MEMORY/LEARNING/SIGNALS/sessions.jsonl\` to inspect recent records.
EOF

# macOS notification
osascript -e "display notification \"PAI-054 baseline: $ROW_COUNT sessions ($FIRST_DATE → $LAST_DATE). Check PENDING-RULES.md.\" with title \"PAI Sprint Review\"" 2>/dev/null || true

exit 0
