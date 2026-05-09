#!/usr/bin/env bash
# Claude Code hook bridge for the streamdeck-claude plugin.
#
# Wired up via ~/.claude/settings.json — the same script handles every event
# listed in hooks/events.json (sibling file). Every rule whose event (and
# optional tool_name) matches the incoming hook fires, in declaration order,
# so one event can target multiple sidecar files (e.g. SessionEnd cleans up
# notify/plan/error/subagent in one pass). Each rule routes to either:
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

# Emit every rule whose event matches and (if specified) tool_name matches —
# one compact JSON object per line. We run *all* matching rules so a single
# event (e.g. SessionEnd) can clear several sidecar files in one go.
# Note: `(has("tool_name") | not)` is parenthesized — jq's `|` binds tighter
# than `or`, so without the parens the boolean from `has` would be piped into
# the next clauses and crash on "Cannot index boolean".
MATCHES="$(jq -c --arg e "$EVENT" --arg t "$TOOL_NAME" '
  .events[] | select(
    .event == $e
    and ((has("tool_name") | not) or .tool_name == null or .tool_name == "" or .tool_name == $t)
  )
' "$EVENTS_FILE" 2>/dev/null || true)"

if [ -z "$MATCHES" ]; then
  echo '{}'
  exit 0
fi

mkdir -p "$SESSIONS_DIR"
TS_MS="$(date +%s%3N)"

while IFS= read -r MATCH; do
  [ -z "$MATCH" ] && continue
  ACTION="$(printf '%s' "$MATCH" | jq -r '.action')"
  FILE="$(printf '%s' "$MATCH" | jq -r '.file')"
  REASON="$(printf '%s' "$MATCH" | jq -r '.reason // ""')"
  TARGET="${SESSIONS_DIR}/${SESSION_ID}.${FILE}.json"
  case "$ACTION" in
    drop)
      printf '{"sessionId":"%s","reason":"%s","mtime":%s}\n' "$SESSION_ID" "$REASON" "$TS_MS" > "$TARGET"
      ;;
    rm)
      rm -f "$TARGET"
      ;;
  esac
done <<< "$MATCHES"

echo '{}'
