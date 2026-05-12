#!/usr/bin/env bash
# Claude Code hook bridge for the streamdeck-claude plugin.
#
# Appends one JSON line per hook fire to <sid>.events.ndjson. The plugin
# reads the file each tick and replays the event stream through a state
# machine in src/session-events.ts to derive the icon state. To add a new
# event: register it in scripts/install-hook.sh + handle it in
# session-events.ts. No mapping table here.
#
# SessionStart truncates the log (clean reset). SessionEnd unlinks it.

set -euo pipefail

SESSIONS_DIR="${HOME}/.claude/sessions"
INPUT="$(cat)"

SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)"
EVENT="$(printf '%s' "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null || true)"
TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)"

if [ -z "${SESSION_ID:-}" ] || [ -z "${EVENT:-}" ]; then
  echo '{}'
  exit 0
fi

mkdir -p "$SESSIONS_DIR"
TARGET="${SESSIONS_DIR}/${SESSION_ID}.events.ndjson"

# SessionEnd: drop the log entirely, no need to record anything.
if [ "$EVENT" = "SessionEnd" ]; then
  rm -f "$TARGET"
  echo '{}'
  exit 0
fi

# SessionStart: truncate before appending so the file always begins with the
# matching SessionStart entry — bounds long-lived sessions from growing forever.
if [ "$EVENT" = "SessionStart" ]; then
  : > "$TARGET"
fi

# jq -nc builds the JSON so embedded quotes/backslashes in tool names can't
# corrupt the line. Atomic single-write append (line is well under PIPE_BUF).
# Perl (rather than `date +%s%3N`) because BSD date on macOS doesn't grok %N
# and emits a literal "3N" suffix — perl is present on both macOS and Ubuntu.
TS_MS="$(perl -MTime::HiRes -e 'printf "%d", Time::HiRes::time()*1000')"
jq -nc \
  --argjson ts "$TS_MS" \
  --arg event "$EVENT" \
  --arg tool "$TOOL_NAME" \
  'if $tool == "" then {ts: $ts, event: $event} else {ts: $ts, event: $event, tool: $tool} end' \
  >> "$TARGET"

echo '{}'
