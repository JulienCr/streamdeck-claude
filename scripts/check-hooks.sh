#!/usr/bin/env bash
# Verify that the streamdeck-claude hook is registered in both WSL and Windows
# Claude Code settings.json — every event the state machine cares about, with
# the right matcher, pointing at the right script. Run after `pnpm install:hook`
# (and `:windows`) to confirm the install actually took.
#
# Exit code: 0 if everything is wired up, 1 otherwise.
#
# Usage:
#   bash scripts/check-hooks.sh
#   WIN_USER=alice WSL_DISTRO_NAME=Ubuntu-22.04 bash scripts/check-hooks.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WIN_USER="${WIN_USER:-julie}"
WIN_HOME="/mnt/c/Users/${WIN_USER}"
WSL_DISTRO="${WSL_DISTRO_NAME:-Ubuntu}"

# event|matcher pairs — must stay in sync with scripts/install-hook.sh
EXPECTED_EVENTS=(
  "SessionStart|"
  "Notification|"
  "PreToolUse|"
  "PostToolUse|"
  "Stop|"
  "StopFailure|"
  "UserPromptSubmit|"
  "SubagentStart|"
  "SubagentStop|"
  "SessionEnd|"
)

WSL_HOOK="${ROOT}/hooks/notification.sh"
WIN_HOOK="${ROOT}/hooks/notification.ps1"
WSL_HOOK_REGEX="streamdeck-claude.*notification\\.sh"
WIN_HOOK_REGEX="streamdeck-claude.*notification\\.ps1"

if [ -t 1 ]; then
  GREEN=$'\e[32m'; RED=$'\e[31m'; YELLOW=$'\e[33m'; DIM=$'\e[2m'; BOLD=$'\e[1m'; RESET=$'\e[0m'
else
  GREEN=""; RED=""; YELLOW=""; DIM=""; BOLD=""; RESET=""
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "${RED}error:${RESET} jq is required" >&2
  exit 2
fi

ALL_OK=1
ok()   { echo "  ${GREEN}✓${RESET} $1"; }
fail() { echo "  ${RED}✗${RESET} $1"; ALL_OK=0; }
warn() { echo "  ${YELLOW}!${RESET} $1"; }

check_settings() {
  local label="$1" settings="$2" hook_regex="$3"
  echo
  echo "${BOLD}${label}${RESET} ${DIM}— ${settings}${RESET}"

  if [ ! -f "$settings" ]; then
    fail "settings.json missing — run the matching install:hook script"
    return
  fi
  if ! jq empty "$settings" 2>/dev/null; then
    fail "settings.json is not valid JSON"
    return
  fi

  for entry in "${EXPECTED_EVENTS[@]}"; do
    local event="${entry%%|*}"
    local matcher="${entry#*|}"
    local label_matcher="${matcher:-no matcher}"

    # Find every streamdeck-claude command registered for (event, matcher).
    # Treat empty/missing matcher as "" — install-hook.sh writes "" explicitly.
    local cmds
    cmds="$(jq -r --arg e "$event" --arg m "$matcher" --arg re "$hook_regex" '
      .hooks[$e] // []
      | map(select((.matcher // "") == $m))
      | map(.hooks[]?.command // empty)
      | map(select(test($re)))
      | .[]
    ' "$settings" 2>/dev/null || true)"

    if [ -z "$cmds" ]; then
      fail "${event}[${label_matcher}] — not registered"
    else
      local count
      count="$(printf '%s\n' "$cmds" | wc -l)"
      if [ "$count" -gt 1 ]; then
        warn "${event}[${label_matcher}] — registered ${count}× (duplicate); first: $(printf '%s\n' "$cmds" | head -1)"
      else
        ok "${event}[${label_matcher}]"
      fi
    fi
  done
}

# --- Hook scripts on disk -------------------------------------------------
echo "${BOLD}Hook scripts${RESET}"
if [ -f "$WSL_HOOK" ] && [ -x "$WSL_HOOK" ]; then
  ok "$WSL_HOOK (executable)"
else
  fail "$WSL_HOOK (missing or not executable)"
fi
# notification.ps1 is irrelevant on macOS; only check it elsewhere.
if [ "$(uname -s)" != "Darwin" ]; then
  if [ -f "$WIN_HOOK" ]; then
    ok "$WIN_HOOK"
  else
    fail "$WIN_HOOK (missing)"
  fi
fi

# --- Local POSIX settings (WSL on Windows, macOS native) ------------------
check_settings "Local hooks (${USER:-?})" "${HOME}/.claude/settings.json" "$WSL_HOOK_REGEX"

# --- Windows settings (skipped on macOS — no WSL/Windows split here) ------
if [ "$(uname -s)" != "Darwin" ]; then
  if [ -d "$WIN_HOME" ]; then
    check_settings "Windows hooks (${WIN_USER})" "${WIN_HOME}/.claude/settings.json" "$WIN_HOOK_REGEX"
  else
    echo
    echo "${BOLD}Windows hooks (${WIN_USER})${RESET}"
    warn "Windows home not found at ${WIN_HOME} — set WIN_USER=<name> if your account is different"
  fi
fi

# --- Summary --------------------------------------------------------------
echo
if [ "$ALL_OK" -eq 1 ]; then
  echo "${GREEN}${BOLD}All hooks verified.${RESET}"
  exit 0
else
  echo "${RED}${BOLD}Some hooks are missing or misconfigured.${RESET} Re-run pnpm install:hook[:windows]."
  exit 1
fi
