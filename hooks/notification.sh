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
# notification_type is set by CC on Notification events (permission_prompt,
# idle_prompt, elicitation_dialog, auth_success). Empty for non-Notification.
NOTIF_TYPE="$(printf '%s' "$INPUT" | jq -r '.notification_type // empty' 2>/dev/null || true)"
# source is set by CC on SessionStart (startup/resume/clear/compact/fork).
SOURCE="$(printf '%s' "$INPUT" | jq -r '.source // empty' 2>/dev/null || true)"
# error_type is set by CC on StopFailure (rate_limit, overloaded, server_error, ...).
ERROR_TYPE="$(printf '%s' "$INPUT" | jq -r '.error_type // empty' 2>/dev/null || true)"
# agent_id/agent_type are set when this event fired inside a subagent (logged
# under the parent session_id regardless). permission_mode rides every event.
AGENT_ID="$(printf '%s' "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null || true)"
AGENT_TYPE="$(printf '%s' "$INPUT" | jq -r '.agent_type // empty' 2>/dev/null || true)"
MODE="$(printf '%s' "$INPUT" | jq -r '.permission_mode // empty' 2>/dev/null || true)"

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
# Except source=compact: auto-compaction can fire mid-turn, and wiping the log
# would reset inTurn/awaiting state the reducer needs to keep tracking the turn.
if [ "$EVENT" = "SessionStart" ] && [ "$SOURCE" != "compact" ]; then
  : > "$TARGET"
fi

# jq -nc builds the JSON so embedded quotes/backslashes in tool names can't
# corrupt the line. Atomic single-write append (line is well under PIPE_BUF).
# Perl (rather than `date +%s%3N`) because BSD date on macOS doesn't grok %N
# and emits a literal "3N" suffix — perl is present on both macOS and Ubuntu.
TS_MS="$(perl -MTime::HiRes -e 'printf "%d", Time::HiRes::time()*1000')"

# For TodoWrite we also snapshot the list's statuses so the plugin can draw a
# progress column. Project tool_input.todos[*].status into a JSON array; on
# any parse failure fall back to null (= don't emit the field).
TODOS_JSON='null'
if [ "$TOOL_NAME" = "TodoWrite" ]; then
  TODOS_JSON="$(printf '%s' "$INPUT" | jq -c '[(.tool_input.todos // [])[] | .status]' 2>/dev/null || echo 'null')"
  [ -z "$TODOS_JSON" ] && TODOS_JSON='null'
fi

# background_tasks is CC's authoritative list of still-running background work
# (subagents, possibly shells) — count entries with status "running", only
# when Stop/SubagentStop actually carries the field (absent ⇒ null, dropped).
BG_RUNNING_JSON='null'
if [ "$EVENT" = "Stop" ] || [ "$EVENT" = "SubagentStop" ]; then
  BG_RUNNING_JSON="$(printf '%s' "$INPUT" | jq -c 'if has("background_tasks") then ([.background_tasks[] | select(.status == "running")] | length) else null end' 2>/dev/null || echo 'null')"
  [ -z "$BG_RUNNING_JSON" ] && BG_RUNNING_JSON='null'
fi

jq -nc \
  --argjson ts "$TS_MS" \
  --arg event "$EVENT" \
  --arg tool "$TOOL_NAME" \
  --arg notifType "$NOTIF_TYPE" \
  --arg source "$SOURCE" \
  --arg errorType "$ERROR_TYPE" \
  --arg agentId "$AGENT_ID" \
  --arg agentType "$AGENT_TYPE" \
  --arg mode "$MODE" \
  --argjson todos "$TODOS_JSON" \
  --argjson bgRunning "$BG_RUNNING_JSON" \
  '{ts: $ts, event: $event}
   | (if $tool      != ""   then . + {tool:      $tool}      else . end)
   | (if $notifType != ""   then . + {notifType: $notifType} else . end)
   | (if $source    != ""   then . + {source:    $source}    else . end)
   | (if $errorType != ""   then . + {errorType: $errorType} else . end)
   | (if $agentId   != ""   then . + {agentId:   $agentId}   else . end)
   | (if $agentType != ""   then . + {agentType: $agentType} else . end)
   | (if $mode      != ""   then . + {mode:      $mode}      else . end)
   | (if $todos     != null then . + {todos:     $todos}     else . end)
   | (if $bgRunning != null then . + {bgRunning: $bgRunning} else . end)' \
  >> "$TARGET"

echo '{}'
