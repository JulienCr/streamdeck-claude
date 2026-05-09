#!/usr/bin/env bash
# Claude Code Notification hook.
# Triggered when Claude needs the user's attention (permission prompt, idle prompt, etc.).
# Writes a small file the streamdeck-claude plugin polls to flip a slot to the
# "awaiting" state.
#
# Wired up via: ~/.claude/settings.json -> hooks.Notification

set -euo pipefail

SESSIONS_DIR="${HOME}/.claude/sessions"
INPUT="$(cat)"

SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)"
if [ -z "${SESSION_ID:-}" ]; then
  # Nothing to record — pass through silently.
  echo '{}'
  exit 0
fi

mkdir -p "$SESSIONS_DIR"
NOTIFY_FILE="${SESSIONS_DIR}/${SESSION_ID}.notify.json"

# `mtime` lets the plugin TTL out the entry (60s); the touch on every prompt
# refreshes it.
TS_MS="$(date +%s%3N)"
printf '{"sessionId":"%s","reason":"awaiting","mtime":%s}\n' "$SESSION_ID" "$TS_MS" > "$NOTIFY_FILE"

echo '{}'
