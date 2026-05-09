#!/usr/bin/env bash
# Idempotently installs the streamdeck-claude Notification + plan-approval
# hooks into Claude Code's user-global settings.json. Runs from WSL; can
# target either the WSL-side Claude install or the Windows-native one.
#
# Same script command is registered for three events:
#   Notification                            (no matcher)  -> "awaiting permission"
#   PreToolUse   matcher=ExitPlanMode                     -> "awaiting plan approval"
#   PostToolUse  matcher=ExitPlanMode                     -> clear plan-approval flag
#
# Usage:
#   bash scripts/install-hook.sh                 # default --target=wsl
#   bash scripts/install-hook.sh --target=wsl
#   bash scripts/install-hook.sh --target=windows
#
# For --target=windows: registers a hook command that invokes the repo's
# hooks/notification.ps1 directly over `\\wsl.localhost\<distro>\…` UNC.
# Nothing is copied — the .ps1 reads its sibling events.json from the same
# UNC dir, so a single `events.json` edit applies to both WSL and Windows.
# Override the Windows username with WIN_USER=<name> (default: julie) and
# the WSL distro with WSL_DISTRO_NAME (default: Ubuntu).
#
# Safe to re-run.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="wsl"

for arg in "$@"; do
  case "$arg" in
    --target=wsl|--target=windows)
      TARGET="${arg#--target=}"
      ;;
    *)
      echo "error: unknown argument: $arg" >&2
      echo "usage: $0 [--target=wsl|--target=windows]" >&2
      exit 2
      ;;
  esac
done

# --- Per-target setup: SETTINGS_PATH and HOOK_CMD --------------------------
case "$TARGET" in
  wsl)
    SETTINGS_PATH="${HOME}/.claude/settings.json"
    HOOK_CMD="${ROOT}/hooks/notification.sh"
    if [ ! -x "$HOOK_CMD" ]; then
      chmod +x "$HOOK_CMD"
    fi
    ;;
  windows)
    SOURCE_PS1="${ROOT}/hooks/notification.ps1"
    SOURCE_EVENTS="${ROOT}/hooks/events.json"
    WIN_USER="${WIN_USER:-julie}"
    WIN_HOME="/mnt/c/Users/${WIN_USER}"
    WSL_DISTRO="${WSL_DISTRO_NAME:-Ubuntu}"

    if [ ! -d "$WIN_HOME" ]; then
      echo "error: Windows user dir not found at $WIN_HOME (set WIN_USER env var)" >&2
      exit 1
    fi
    if [ ! -f "$SOURCE_PS1" ]; then
      echo "error: $SOURCE_PS1 missing — run from a checked-out repo" >&2
      exit 1
    fi
    if [ ! -f "$SOURCE_EVENTS" ]; then
      echo "error: $SOURCE_EVENTS missing — run from a checked-out repo" >&2
      exit 1
    fi

    # Reference the repo's .ps1 directly over the WSL UNC path. Same trick
    # the runtime plugin uses for sessions: \\wsl.localhost\<distro>\<linux-path>.
    PS1_UNC="\\\\wsl.localhost\\${WSL_DISTRO}${SOURCE_PS1//\//\\}"
    SETTINGS_PATH="${WIN_HOME}/.claude/settings.json"
    HOOK_CMD="powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"${PS1_UNC}\""

    echo "Hook target (no copy — read live from repo over UNC):"
    echo "  $PS1_UNC"
    ;;
esac

# --- Shared: ensure settings.json exists, back it up, merge hooks ----------
if [ ! -f "$SETTINGS_PATH" ]; then
  echo "{}" > "$SETTINGS_PATH"
fi

BACKUP="${SETTINGS_PATH}.bak.$(date +%Y%m%d)"
[ -f "$BACKUP" ] || cp "$SETTINGS_PATH" "$BACKUP"

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
  jq --arg event "$event" --arg matcher "$matcher" --arg cmd "$HOOK_CMD" "$JQ_FILTER" "$SETTINGS_PATH" > "$tmp"
  mv "$tmp" "$SETTINGS_PATH"
}

merge "Notification" ""
merge "PreToolUse"   "ExitPlanMode"
merge "PostToolUse"  "ExitPlanMode"

# --- Final summary ---------------------------------------------------------
echo "Hook command:"
echo "  $HOOK_CMD"
echo "Registered for: Notification, PreToolUse[ExitPlanMode], PostToolUse[ExitPlanMode]"
echo "Settings: $SETTINGS_PATH  (backup at $BACKUP)"
if [ "$TARGET" = "windows" ]; then
  echo
  echo "Done. Restart any open Windows-side 'claude' sessions for the hooks to take effect."
fi
