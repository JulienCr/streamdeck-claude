#!/usr/bin/env bash
# Claude Code hook bridge for the streamdeck-claude plugin.
#
# Wired up via ~/.claude/settings.json — the same script handles three events,
# routed by `hook_event_name` (and, for tool events, `tool_name`):
#
#   Notification                       -> drop  <sessionId>.notify.json (awaiting permission)
#   PreToolUse  matcher=ExitPlanMode   -> drop  <sessionId>.plan.json   (awaiting plan approval)
#   PostToolUse matcher=ExitPlanMode   -> rm    <sessionId>.plan.json   (plan was answered)
#
# The plugin polls those files; presence + recent mtime drives the icon state.

set -euo pipefail

SESSIONS_DIR="${HOME}/.claude/sessions"
INPUT="$(cat)"

EVENT="$(printf '%s' "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null || true)"
SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)"
TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)"

if [ -z "${SESSION_ID:-}" ]; then
  echo '{}'
  exit 0
fi

mkdir -p "$SESSIONS_DIR"
TS_MS="$(date +%s%3N)"

case "$EVENT" in
  Notification)
    NOTIFY="${SESSIONS_DIR}/${SESSION_ID}.notify.json"
    printf '{"sessionId":"%s","reason":"awaiting","mtime":%s}\n' "$SESSION_ID" "$TS_MS" > "$NOTIFY"
    ;;
  PreToolUse)
    if [ "$TOOL_NAME" = "ExitPlanMode" ]; then
      PLAN="${SESSIONS_DIR}/${SESSION_ID}.plan.json"
      printf '{"sessionId":"%s","reason":"plan","mtime":%s}\n' "$SESSION_ID" "$TS_MS" > "$PLAN"
    fi
    ;;
  PostToolUse)
    if [ "$TOOL_NAME" = "ExitPlanMode" ]; then
      rm -f "${SESSIONS_DIR}/${SESSION_ID}.plan.json"
    fi
    ;;
esac

echo '{}'
