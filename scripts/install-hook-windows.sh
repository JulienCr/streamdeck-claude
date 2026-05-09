#!/usr/bin/env bash
# Idempotently installs the Notification hook for Windows-native Claude Code.
#
# Copies hooks/notification.ps1 to %USERPROFILE%\.claude\hooks\ and merges the
# corresponding hook entry into %USERPROFILE%\.claude\settings.json.
# Works from WSL — both targets are accessible through /mnt/c.
#
# Re-run is safe; the merge is idempotent on the exact command string.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_PS1="${ROOT}/hooks/notification.ps1"
WIN_USER="${WIN_USER:-julie}"
WIN_HOME="/mnt/c/Users/${WIN_USER}"

if [ ! -d "$WIN_HOME" ]; then
  echo "error: Windows user dir not found at $WIN_HOME (set WIN_USER env var)" >&2
  exit 1
fi
if [ ! -f "$SOURCE_PS1" ]; then
  echo "error: $SOURCE_PS1 missing — run from a checked-out repo" >&2
  exit 1
fi

WIN_HOOKS_DIR="${WIN_HOME}/.claude/hooks"
WIN_HOOK_FILE="${WIN_HOOKS_DIR}/streamdeck-claude-notification.ps1"
WIN_SETTINGS="${WIN_HOME}/.claude/settings.json"
HOOK_CMD="powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"C:\\Users\\${WIN_USER}\\.claude\\hooks\\streamdeck-claude-notification.ps1\""

mkdir -p "$WIN_HOOKS_DIR"
# Use `command cp` to bypass any `cp -i` alias the user has in their shell.
command cp -f "$SOURCE_PS1" "$WIN_HOOK_FILE"
echo "Copied hook script:"
echo "  $WIN_HOOK_FILE"

# Settings file might not exist yet on a fresh install.
[ -f "$WIN_SETTINGS" ] || echo "{}" > "$WIN_SETTINGS"

BACKUP="${WIN_SETTINGS}.bak.$(date +%Y%m%d)"
[ -f "$BACKUP" ] || cp "$WIN_SETTINGS" "$BACKUP"

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
' "$WIN_SETTINGS" > "$TMP"
mv "$TMP" "$WIN_SETTINGS"

echo "Merged Notification hook into Windows settings:"
echo "  $WIN_SETTINGS  (backup at $BACKUP)"
echo
echo "Done. Restart any open Windows-side 'claude' sessions for the hook to take effect."
