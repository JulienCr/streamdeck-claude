#!/usr/bin/env bash
# Idempotently merges the streamdeck-claude Notification hook into the
# user-global ~/.claude/settings.json. Safe to re-run.
set -euo pipefail

SETTINGS="${HOME}/.claude/settings.json"
HOOK_CMD="$(cd "$(dirname "$0")/.." && pwd)/hooks/notification.sh"

if [ ! -x "$HOOK_CMD" ]; then
  chmod +x "$HOOK_CMD"
fi

if [ ! -f "$SETTINGS" ]; then
  echo "{}" > "$SETTINGS"
fi

# Backup once per day.
BACKUP="${SETTINGS}.bak.$(date +%Y%m%d)"
[ -f "$BACKUP" ] || cp "$SETTINGS" "$BACKUP"

# Merge: ensure .hooks.Notification contains an entry whose .hooks[].command == HOOK_CMD.
TMP="$(mktemp)"
jq --arg cmd "$HOOK_CMD" '
  .hooks //= {}
  | .hooks.Notification //= []
  | if any(.hooks.Notification[]?; (.hooks // []) | any(.command == $cmd))
    then .
    else .hooks.Notification += [{
      "matcher": "",
      "hooks": [{"type": "command", "command": $cmd}]
    }]
    end
' "$SETTINGS" > "$TMP"

mv "$TMP" "$SETTINGS"
echo "Notification hook installed:"
echo "  $HOOK_CMD"
echo "Settings file: $SETTINGS (backup at $BACKUP)"
