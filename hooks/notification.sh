#!/usr/bin/env bash
# Claude Code hook bridge for the streamdeck-claude plugin.
#
# Wired up via ~/.claude/settings.json — the same script handles every event
# listed in hooks/events.json (sibling file). Rules are evaluated top-to-bottom;
# first match wins. Each rule routes a hook event (and optional tool_name) to
# either:
#   - drop  <sessionId>.<file>.json (awaiting flag, with reason+mtime)
#   - rm    <sessionId>.<file>.json (clear flag)
#
# The plugin polls those files; presence + recent mtime drives the icon state.
# To add a new event: edit hooks/events.json — both this script and the
# PowerShell sibling read the same table.

set -euo pipefail

SESSIONS_DIR="${HOME}/.claude/sessions"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EVENTS_FILE="${SCRIPT_DIR}/events.json"

INPUT="$(cat)"

SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)"
EVENT="$(printf '%s' "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null || true)"
TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)"

if [ -z "${SESSION_ID:-}" ]; then
  echo '{}'
  exit 0
fi

# Find the first rule whose event matches and (if specified) tool_name matches.
# Note: `(has("tool_name") | not)` is parenthesized — jq's `|` binds tighter
# than `or`, so without the parens the boolean from `has` would be piped into
# the next clauses and crash on "Cannot index boolean".
MATCH="$(jq -c --arg e "$EVENT" --arg t "$TOOL_NAME" '
  [ .events[] | select(
      .event == $e
      and ((has("tool_name") | not) or .tool_name == null or .tool_name == "" or .tool_name == $t)
    ) ][0] // empty
' "$EVENTS_FILE" 2>/dev/null || true)"

if [ -z "$MATCH" ]; then
  echo '{}'
  exit 0
fi

ACTION="$(printf '%s' "$MATCH" | jq -r '.action')"
FILE="$(printf '%s' "$MATCH" | jq -r '.file')"
REASON="$(printf '%s' "$MATCH" | jq -r '.reason // ""')"

mkdir -p "$SESSIONS_DIR"
TARGET="${SESSIONS_DIR}/${SESSION_ID}.${FILE}.json"

case "$ACTION" in
  drop)
    TS_MS="$(date +%s%3N)"
    printf '{"sessionId":"%s","reason":"%s","mtime":%s}\n' "$SESSION_ID" "$REASON" "$TS_MS" > "$TARGET"
    ;;
  rm)
    rm -f "$TARGET"
    ;;
esac

echo '{}'
