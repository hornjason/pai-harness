#!/usr/bin/env bash
# decision-reconcile.sh — Verify council decisions are present in target documents
# Usage: decision-reconcile.sh <council-synthesis.json> [--target <file>]
# Without --target: checks ALL decisions against their declared targets
# With --target: checks only decisions targeting that specific file
set -euo pipefail

SYNTHESIS="${1:?Usage: decision-reconcile.sh <council-synthesis.json> [--target <file>]}"
TARGET_FILTER=""
if [[ "${2:-}" == "--target" ]]; then
  TARGET_FILTER="${3:?Usage: decision-reconcile.sh <file> --target <target-file>}"
fi

[[ -f "$SYNTHESIS" ]] || { echo "FAIL: $SYNTHESIS not found" >&2; exit 1; }
jq empty "$SYNTHESIS" 2>/dev/null || { echo "FAIL: $SYNTHESIS is invalid JSON" >&2; exit 1; }

RESULTS=$(python3 -c "
import json, sys, os

data = json.load(open('$SYNTHESIS'))
decisions = data.get('decisions', [])
target_filter = '$TARGET_FILTER'
home = os.path.expanduser('~')

for d in decisions:
    target = d.get('target', {})
    ref = target.get('ref', '')
    if not ref:
        continue
    if target_filter and ref != target_filter:
        continue

    filepath = ref.replace('~', home)

    try:
        with open(filepath) as f:
            content = f.read()
    except FileNotFoundError:
        print(f'MISSING|{d[\"id\"]}|{d[\"statement\"][:60]}|file not found: {ref}')
        continue

    statement = d['statement']
    words = [w for w in statement.split() if len(w) > 3][:5]
    key_phrase = ' '.join(words[:3])

    if key_phrase.lower() in content.lower() or d['id'] in content:
        print(f'FOUND|{d[\"id\"]}|{d[\"statement\"][:60]}')
    else:
        section = target.get('section', '')
        if section and section.lower() in content.lower():
            print(f'FOUND|{d[\"id\"]}|{d[\"statement\"][:60]}|via section match')
        else:
            print(f'MISSING|{d[\"id\"]}|{d[\"statement\"][:60]}|not found in {ref}')
" 2>/dev/null)

TOTAL=0
FOUND=0
MISSING=0

while IFS='|' read -r status id statement detail; do
  [[ -z "$status" ]] && continue
  TOTAL=$((TOTAL + 1))
  if [[ "$status" == "FOUND" ]]; then
    FOUND=$((FOUND + 1))
    echo "  FOUND: $id — $statement"
  else
    MISSING=$((MISSING + 1))
    echo "  MISSING: $id — $statement ($detail)"
  fi
done <<< "$RESULTS"

echo ""
echo "=== Reconcile: $FOUND found, $MISSING missing out of $TOTAL decisions ==="
[[ $MISSING -eq 0 ]] && exit 0 || exit 1
