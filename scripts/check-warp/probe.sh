#!/usr/bin/env bash
# Probes the Warp install for the surfaces we'd need to focus a specific pane
# from the streamdeck-claude plugin. Runs from WSL; reads Windows-side files
# over /mnt/c and invokes warp.exe / powershell.exe via cmd.exe.
#
# Outputs a markdown report on stdout. Exit code:
#   0 = pane-level focus appears achievable (any green check below)
#   1 = nothing critical changed, still gated on Warp issue #8611
#   2 = couldn't probe (Warp not installed / not running / WIN_USER wrong)
#
# Run: bash scripts/check-warp/probe.sh
# Archive: bash scripts/check-warp/probe.sh > docs/warp-surface-$(date +%Y%m%d).md
#
# Baseline (2026-05-09): all critical features ABSENT — see
# docs/warp-focus-research.md.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WIN_USER="${WIN_USER:-julie}"
WIN_HOME="/mnt/c/Users/${WIN_USER}"
WARP_DIR="${WIN_HOME}/AppData/Local/Programs/Warp"
WARP_EXE="${WARP_DIR}/warp.exe"
WARP_EXE_WIN="C:\\Users\\${WIN_USER}\\AppData\\Local\\Programs\\Warp\\warp.exe"

# --- helpers ----------------------------------------------------------------

# Verdict markers used in section headers — let `grep '^### '` give a quick scan.
PASS='✅ PRESENT'
FAIL='❌ ABSENT'
WARN='⚠️  PARTIAL'

# State accumulator. Set to 0 when a critical capability flips to PRESENT.
# Critical = anything that unblocks pane-level focus.
critical_unlocked=1
require_warp_install=2

probe_install() {
  echo "## Install"
  echo
  if [ ! -x "$WARP_EXE" ]; then
    echo "$FAIL — \`$WARP_EXE\` not found. Set WIN_USER=… or install Warp first."
    exit "$require_warp_install"
  fi

  # FileVersion / ProductVersion via PowerShell — most reliable on Windows.
  local ver
  ver="$(powershell.exe -NoProfile -Command \
    "(Get-Item '${WARP_EXE_WIN}').VersionInfo | Select-Object -Property FileVersion,ProductVersion | Format-List | Out-String" \
    2>/dev/null | tr -d '\r' | sed -E 's/^[[:space:]]+//' | grep -E '^(File|Product)Version' || true)"
  if [ -n "$ver" ]; then
    echo '```'
    echo "$ver"
    echo '```'
  else
    echo "(version unreadable)"
  fi
  local mtime
  mtime="$(stat -c '%y' "$WARP_EXE" 2>/dev/null || echo unknown)"
  echo "- exe mtime: \`$mtime\`"
  echo "- install dir: \`$WARP_DIR\`"
  echo
}

probe_uri_scheme() {
  echo "## URI scheme \`warp://\`"
  echo
  local reg
  # Quote the cmd line with double-quotes (cmd.exe doesn't grok single-quotes)
  # and let bash redirect stderr — `2>nul` inside the cmd line gets mangled.
  reg="$(cmd.exe /c "reg query HKEY_CLASSES_ROOT\\warp /s" 2>/dev/null | tr -d '\r' || true)"
  # Note: we don't flip critical_unlocked here. The scheme being registered is
  # the baseline state; what matters is which *verbs* it accepts (next section).
  if echo "$reg" | grep -q 'shell\\open\\command'; then
    echo "$PASS — registered (baseline)."
    echo
    echo '```'
    echo "$reg" | head -10
    echo '```'
  else
    echo "$FAIL — no \`warp\` URI scheme registered in HKCR."
  fi
  echo
}

probe_actions() {
  echo "## URI actions baked into \`warp.exe\`"
  echo
  echo "Strings of \`warp.exe\` matching \`://action/<verb>\`:"
  echo
  echo '```'
  local actions
  actions="$(strings "$WARP_EXE" 2>/dev/null | grep -oE '://action/[a-z_/-]+' | sort -u || true)"
  if [ -z "$actions" ]; then
    echo '(none found)'
  else
    echo "$actions"
  fi
  echo '```'
  echo

  # Critical sub-check: is there ANY focus-related verb?
  if echo "$actions" | grep -qE '/(focus|goto|select|attach)(_|/|$)'; then
    echo "### Focus-related action verbs: $PASS"
    echo
    echo "Found: \`$(echo "$actions" | grep -E '/(focus|goto|select|attach)(_|/|$)' | tr '\n' ' ')\`"
    critical_unlocked=0
  else
    echo "### Focus-related action verbs: $FAIL"
    echo
    echo "Baseline: only \`://action/new_window\` was present on 2026-05-09."
  fi
  echo
}

probe_cli_subcommands() {
  echo "## \`warp.exe\` CLI surface"
  echo
  # We CAN'T just invoke `warp.exe focus --help` to probe — warp.exe always
  # launches the GUI app for unknown args (silently), so "no output" is
  # ambiguous between "command doesn't exist" and "app started fine".
  # Inspect the binary's strings instead: a real subcommand parser would
  # carry usage / help text and the verb literal nearby.
  echo "Help-text strings in \`warp.exe\` (top 20):"
  echo
  echo '```'
  strings "$WARP_EXE" 2>/dev/null \
    | grep -E '^(Usage:|USAGE:|Subcommands?:|Options?:|--[a-z][a-z-]+ [A-Z])' \
    | sort -u | head -20 || echo '(none)'
  echo '```'
  echo
  echo "Subcommand-like verbs (kebab-case, ≥4 chars) baked in:"
  echo
  echo '```'
  local verbs
  verbs="$(strings "$WARP_EXE" 2>/dev/null \
    | grep -oE '^(focus|goto|show|attach|launch|spawn|focus-[a-z]+|select-[a-z]+|switch-[a-z]+|warp-[a-z-]+)$' \
    | sort -u)"
  if [ -n "$verbs" ]; then
    echo "$verbs"
  else
    echo '(none)'
  fi
  echo '```'
  echo

  # Heuristic: a real CLI subcommand has a help-text line shaped like
  # `<verb> <ARG_PLACEHOLDER>` or `--<flag> <ARG>`. Restrict to short lines
  # (< 200 chars) to avoid matching the giant concatenated-strings blob that
  # lives in the binary (locale data, wordlists, …).
  local helptext
  helptext="$(strings -n 8 "$WARP_EXE" 2>/dev/null \
    | awk 'length < 200' \
    | grep -E '^(focus|focus-[a-z]+|select-[a-z]+|switch-[a-z]+|goto)[[:space:]]+<[A-Z]' \
    | head -5)"
  # We deliberately don't flip critical_unlocked on this probe — it's
  # advisory. The decisive signals are the `://action/<verb>` set and the
  # presence of WARP_*_ID env vars (next sections).
  if [ -n "$helptext" ]; then
    echo "### CLI focus surface: $WARN — possible focus help-text found"
    echo
    echo '```'
    echo "$helptext"
    echo '```'
    echo
    echo "Confirm manually that \`warp.exe <verb>\` does something meaningful and doesn't just open the GUI."
  else
    echo "### CLI focus surface: $FAIL"
    echo
    echo "Baseline: bare \`focus\`/\`goto\` strings exist in the binary but only as GUI labels; no help-text line of the form \`focus <PANE_ID>\` etc. \`warp.exe\` opens the GUI silently for unknown args, so absence-of-help is the cleanest signal."
  fi
  echo
}

probe_warp_session_id_envvar() {
  echo "## \`WARP_SESSION_ID\` in claude env"
  echo
  echo "If Warp now exports \`WARP_SESSION_ID\` *and* it propagates into Claude (including across \`wsl.exe\`), we can map a session to a pane."
  echo
  local found_any=0
  local found_lines=""
  for jf in ~/.claude/sessions/*.json; do
    [ -e "$jf" ] || continue
    local pid
    pid="$(basename "$jf" .json)"
    case "$pid" in
      ''|*[!0-9]*) continue ;;
    esac
    [ -d "/proc/$pid" ] || continue
    local hit
    hit="$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -E '^WARP_(SESSION|PANE|TAB|WINDOW)_ID=' || true)"
    if [ -n "$hit" ]; then
      found_any=1
      found_lines+=$'\n'"  pid=$pid: $hit"
    else
      found_lines+=$'\n'"  pid=$pid: (no WARP_*_ID)"
    fi
  done
  if [ -z "$found_lines" ]; then
    echo "(no live claude sessions to inspect — start one and re-run)"
    echo
    return
  fi
  echo '```'
  echo "$found_lines" | sed 's/^$//'
  echo '```'
  echo
  if [ "$found_any" = 1 ]; then
    echo "### Per-pane env var: $PASS"
    echo
    echo "→ A child process can identify its pane. This unlocks deterministic focus IF a focus verb also exists."
    critical_unlocked=0
  else
    echo "### Per-pane env var: $FAIL"
    echo
    echo "Baseline: no WARP_*_ID variable on 2026-05-09 (Warp doesn't add it to WSLENV)."
  fi
  echo
}

probe_windows() {
  echo "## Warp windows (HWND × PID × title)"
  echo
  local out
  out="$(powershell.exe -NoProfile -ExecutionPolicy Bypass -File \
    "$(wslpath -w "${SCRIPT_DIR}/probe-windows.ps1")" 2>&1 | tr -d '\r' || true)"
  if [ -z "$out" ] || echo "$out" | grep -q '^warp not running$'; then
    echo "(warp not running — start Warp and re-run)"
    echo
    return
  fi
  echo '```'
  echo "$out"
  echo '```'
  echo
  # The summary line "warp_windows=N distinct_pids=K" is on stderr → we
  # captured both via 2>&1. Parse it out for the verdict.
  local nwin npid
  nwin="$(echo "$out" | sed -nE 's/^warp_windows=([0-9]+).*$/\1/p' | tail -1)"
  npid="$(echo "$out" | sed -nE 's/.*distinct_pids=([0-9]+).*$/\1/p' | tail -1)"
  if [ -n "$nwin" ] && [ "$nwin" -gt 1 ] && [ -n "$npid" ] && [ "$npid" -gt 1 ]; then
    echo "### Per-window distinct PIDs: $PASS"
    echo
    echo "→ ${nwin} windows over ${npid} distinct PIDs. PID-walk from a child process can land on a unique window."
    critical_unlocked=0
  elif [ -n "$nwin" ] && [ "$nwin" -gt 1 ]; then
    echo "### Per-window distinct PIDs: $FAIL"
    echo
    echo "Baseline: ${nwin} windows all share the same PID. PID-walk cannot distinguish."
  else
    echo "### Per-window distinct PIDs: $WARN"
    echo
    echo "Only ${nwin:-?} window visible — open ≥2 to test."
  fi
  echo
}

probe_osc_focus_codes() {
  echo "## OSC codes used by Warp"
  echo
  echo "Distinct \`92xx\` OSC numbers referenced in \`warp.exe\` strings:"
  echo
  echo '```'
  # OSC numbers appear as raw "9277", "9278" etc. in the binary, sometimes with
  # an `;` after. Avoid matching the literal port number 9278 in unrelated
  # contexts by requiring the surrounding shape `]9277`, `9277;`, etc.
  strings "$WARP_EXE" 2>/dev/null \
    | grep -oE '\]92[0-9]{2}|92[0-9]{2};[A-D]?' \
    | grep -oE '92[0-9]{2}' \
    | sort -u || echo '(none)'
  echo '```'
  echo
  echo "Hooks / message types referenced (shell→Warp):"
  echo
  echo '```'
  strings "$WARP_EXE" 2>/dev/null \
    | grep -oE '"hook":[[:space:]]*"[A-Za-z]+"' \
    | sort -u | head -15 || echo '(none)'
  echo '```'
  echo
  echo "Baseline 2026-05-09: OSC \`9277/9278/9279/9280\` only (output / hooks / reset / autocomplete) — all shell→Warp. No focus OSC observed."
  echo
}

verdict() {
  echo "## Verdict"
  echo
  if [ "$critical_unlocked" = 0 ]; then
    echo "### 🟢 At least one critical surface flipped to PRESENT since baseline."
    echo
    echo "Re-read the sections above marked $PASS to identify which path is now viable, and update \`docs/warp-focus-research.md\`."
    return 0
  else
    echo "### 🔴 Same as baseline — pane-level focus still gated on upstream."
    echo
    echo "All of these would need to flip:"
    echo "- \`://action/<focus-verb>\` baked into \`warp.exe\`, OR"
    echo "- a \`warp.exe <verb>\` CLI sub-command that targets an existing pane, OR"
    echo "- a \`WARP_*_ID\` env var inherited by Claude inside WSL."
    echo
    echo "Track <https://github.com/warpdotdev/Warp/issues/8611> and <https://github.com/warpdotdev/Warp/issues/9083>."
    return 1
  fi
}

# --- run --------------------------------------------------------------------

echo "# Warp surface probe — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo
echo "Host: $(uname -srm) — WSL distro \`${WSL_DISTRO_NAME:-?}\` — WIN_USER=\`${WIN_USER}\`"
echo

probe_install
probe_uri_scheme
probe_actions
probe_cli_subcommands
probe_warp_session_id_envvar
probe_windows
probe_osc_focus_codes
verdict
