#!/usr/bin/env bash
# batch-status.sh — Track issue status during AFK batch execution
# Usage:
#   bash batch-status.sh init <batch-id>
#   bash batch-status.sh update <batch-id> <issue> <phase> <status>
#   bash batch-status.sh report <batch-id>
set -euo pipefail

PAI_WORK_DIR="${PAI_WORK_DIR:-$HOME/.pai-work}"
ACTION="${1:?Usage: batch-status.sh <init|update|report> ...}"
BATCH_ID="${2:?Usage: batch-status.sh $ACTION <batch-id> ...}"
STATUS_FILE="$PAI_WORK_DIR/batch-$BATCH_ID/batch-status.json"

case "$ACTION" in
  init)
    mkdir -p "$PAI_WORK_DIR/batch-$BATCH_ID"
    echo '{"batchId":"'"$BATCH_ID"'","startedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","issues":[]}' > "$STATUS_FILE"
    echo "PASS: Initialized batch $BATCH_ID at $STATUS_FILE"
    ;;
  update)
    ISSUE="${3:?Usage: batch-status.sh update <batch-id> <issue> <phase> <status>}"
    PHASE="${4:?Usage: batch-status.sh update <batch-id> <issue> <phase> <status>}"
    STATUS="${5:?Usage: batch-status.sh update <batch-id> <issue> <phase> <status>}"

    if [[ ! -f "$STATUS_FILE" ]]; then
      echo "FAIL: batch $BATCH_ID not initialized" >&2; exit 1
    fi

    TMP_FILE="$STATUS_FILE.tmp.$$"
    python3 -c "
import json, sys
data = json.load(open('$STATUS_FILE'))
issues = data.get('issues', [])
updated = False
for i in issues:
    if i['issue'] == $ISSUE:
        i['phase'] = '$PHASE'
        i['status'] = '$STATUS'
        i['updatedAt'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
        updated = True
        break
if not updated:
    issues.append({'issue': $ISSUE, 'phase': '$PHASE', 'status': '$STATUS', 'updatedAt': '$(date -u +%Y-%m-%dT%H:%M:%SZ)'})
data['issues'] = issues
json.dump(data, open('$TMP_FILE', 'w'), indent=2)
"
    mv "$TMP_FILE" "$STATUS_FILE"
    echo "PASS: Updated issue $ISSUE → $PHASE/$STATUS"
    ;;
  report)
    if [[ ! -f "$STATUS_FILE" ]]; then
      echo "FAIL: batch $BATCH_ID not initialized" >&2; exit 1
    fi
    python3 -c "
import json
data = json.load(open('$STATUS_FILE'))
print(f'Batch: {data[\"batchId\"]} (started {data[\"startedAt\"]})')
for i in data.get('issues', []):
    print(f'  #{i[\"issue\"]}: {i[\"phase\"]}/{i[\"status\"]} (updated {i.get(\"updatedAt\", \"?\")})')
total = len(data.get('issues', []))
done = len([i for i in data.get('issues', []) if i['status'] == 'DONE'])
print(f'Progress: {done}/{total}')
"
    ;;
  *)
    echo "FAIL: unknown action '$ACTION' — use init|update|report" >&2; exit 1
    ;;
esac
