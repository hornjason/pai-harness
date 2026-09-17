#!/bin/bash
SALT_FILE="$HOME/.claude/hooks/lib/.gate-salt"
if [ ! -f "$SALT_FILE" ]; then
  echo "No salt file found. Generating new salt."
  SALT=$(openssl rand -hex 32)
else
  SALT=$(cat "$SALT_FILE")
fi
security add-generic-password -s "pai-gate-salt" -a "pai" -w "$SALT" -U 2>/dev/null || \
  security add-generic-password -s "pai-gate-salt" -a "pai" -w "$SALT"
echo "Salt stored in macOS Keychain as 'pai-gate-salt'"
echo "You can now delete $SALT_FILE"
