#!/usr/bin/env bash
# Idempotently merges the streamdeck-claude hook into the user-global
# ~/.claude/settings.json. Same script command is registered for three events:
#   Notification                            (no matcher)  -> "awaiting permission"
#   PreToolUse   matcher=ExitPlanMode                     -> "awaiting plan approval"
#   PostToolUse  matcher=ExitPlanMode                     -> clear plan-approval flag
#
# Safe to re-run.

set -euo pipefail

SETTINGS="${HOME}/.claude/settings.json"
HOOK_CMD="$(cd "$(dirname "$0")/.." && pwd)/hooks/notification.sh"

if [ ! -x "$HOOK_CMD" ]; then
  chmod +x "$HOOK_CMD"
fi

if [ ! -f "$SETTINGS" ]; then
  echo "{}" > "$SETTINGS"
fi

BACKUP="${SETTINGS}.bak.$(date +%Y%m%d)"
[ -f "$BACKUP" ] || cp "$SETTINGS" "$BACKUP"

# jq filter that idempotently registers our command for one event/matcher pair.
JQ_FILTER='
  .hooks //= {}
  | .hooks[$event] //= []
  | if any(.hooks[$event][]?; (.matcher // "") == $matcher and ((.hooks // []) | any(.command == $cmd)))
    then .
    else .hooks[$event] += [{"matcher": $matcher, "hooks": [{"type": "command", "command": $cmd}]}]
    end
'

merge() {
  local event="$1" matcher="$2" tmp
  tmp="$(mktemp)"
  jq --arg event "$event" --arg matcher "$matcher" --arg cmd "$HOOK_CMD" "$JQ_FILTER" "$SETTINGS" > "$tmp"
  mv "$tmp" "$SETTINGS"
}

merge "Notification" ""
merge "PreToolUse"   "ExitPlanMode"
merge "PostToolUse"  "ExitPlanMode"

echo "Hook command:"
echo "  $HOOK_CMD"
echo "Registered for: Notification, PreToolUse[ExitPlanMode], PostToolUse[ExitPlanMode]"
echo "Settings: $SETTINGS  (backup at $BACKUP)"
