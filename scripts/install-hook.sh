#!/usr/bin/env bash
# Idempotently installs the streamdeck-claude Notification + plan-approval
# hooks into Claude Code's user-global settings.json. Runs from WSL; can
# target either the WSL-side Claude install or the Windows-native one.
#
# Same script command is registered for every event the dispatcher reacts to:
#   Notification                            (no matcher)  -> "awaiting permission"
#   PreToolUse   matcher=ExitPlanMode                     -> "awaiting plan approval"
#   PostToolUse  matcher=ExitPlanMode                     -> clear plan-approval flag
#   Stop                                    (no matcher)  -> clear awaiting-permission flag
#   StopFailure                             (no matcher)  -> "errored turn"
#   SubagentStart                           (no matcher)  -> "subagent active"
#   SubagentStop                            (no matcher)  -> clear subagent flag
#   SessionEnd                              (no matcher)  -> sweep all sidecars
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

    # Reference the repo's .ps1 directly over the WSL UNC path, written with
    # FORWARD slashes. PowerShell happily resolves //wsl.localhost/<distro>/…
    # to the equivalent backslash UNC, and a forward-slash path has no `\`
    # characters for Claude Code's Windows hook runner to strip — earlier
    # attempts using `\\wsl.localhost\…` (with or without outer quotes) were
    # mangled by CC's argv parser into either `\wsl.localhost\…` (one
    # backslash short of a UNC) or `wsl.localhostUbuntuhome…` (every `\`
    # eaten), producing
    #   "L'argument «…» du paramètre -File n'existe pas"
    # at runtime. Forward slashes side-step the whole class of bug.
    PS1_UNC="//wsl.localhost/${WSL_DISTRO}${SOURCE_PS1}"
    SETTINGS_PATH="${WIN_HOME}/.claude/settings.json"
    HOOK_CMD="powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${PS1_UNC}"

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

# Strip every previous streamdeck-claude entry across all events. Matches
# anything whose command references our notification.ps1 / notification.sh
# (regardless of quoting, slashes, or which install pattern wrote it). Empty
# matcher arrays are dropped, then empty event keys are dropped — so a clean
# uninstall would leave .hooks itself absent.
PRUNE_FILTER='
  .hooks //= {}
  | .hooks |= with_entries(
      .value |= map(
        .hooks |= map(
          select(
            (.command // "")
            | test("streamdeck-claude.*notification\\.(ps1|sh)") | not
          )
        )
        | select(.hooks | length > 0)
      )
      | select(.value | length > 0)
    )
'

prune_existing() {
  local tmp
  tmp="$(mktemp)"
  jq "$PRUNE_FILTER" "$SETTINGS_PATH" > "$tmp"
  mv "$tmp" "$SETTINGS_PATH"
}

# jq filter that registers our command for one event/matcher pair. Run after
# prune_existing, so duplication is prevented by the prune step rather than
# a per-call check.
JQ_FILTER='
  .hooks //= {}
  | .hooks[$event] //= []
  | .hooks[$event] += [{"matcher": $matcher, "hooks": [{"type": "command", "command": $cmd}]}]
'

merge() {
  local event="$1" matcher="$2" tmp
  tmp="$(mktemp)"
  jq --arg event "$event" --arg matcher "$matcher" --arg cmd "$HOOK_CMD" "$JQ_FILTER" "$SETTINGS_PATH" > "$tmp"
  mv "$tmp" "$SETTINGS_PATH"
}

prune_existing

merge "Notification"  ""
merge "PreToolUse"    "ExitPlanMode"
merge "PostToolUse"   "ExitPlanMode"
merge "Stop"          ""
merge "StopFailure"   ""
merge "SubagentStart" ""
merge "SubagentStop"  ""
merge "SessionEnd"    ""

# --- Final summary ---------------------------------------------------------
echo "Hook command:"
echo "  $HOOK_CMD"
echo "Registered for: Notification, PreToolUse[ExitPlanMode], PostToolUse[ExitPlanMode], Stop, StopFailure, SubagentStart, SubagentStop, SessionEnd"
echo "Settings: $SETTINGS_PATH  (backup at $BACKUP)"
if [ "$TARGET" = "windows" ]; then
  echo
  echo "Done. Restart any open Windows-side 'claude' sessions for the hooks to take effect."
fi
