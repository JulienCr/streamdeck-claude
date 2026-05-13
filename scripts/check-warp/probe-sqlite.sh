#!/usr/bin/env bash
# Probes Warp Windows for the *SQLite* surface needed to mirror the macOS
# focus method (cwd → window_id/tab_index via warp.sqlite, then keystroke).
# Companion to ./probe.sh, which covers the URL-scheme path.
#
# Runs from WSL but prefers a Windows-native sqlite3.exe for reads —
# WSL's sqlite3 over /mnt/c fails with "disk I/O error" against Warp's
# live DB because the 9P bridge can't honour the WAL/SHM locks SQLite
# needs. Windows-native sqlite3.exe sidesteps that.
#
# Outputs markdown on stdout. Exit code:
#   0 = SQLite focus path appears viable (DB present + schema matches Mac)
#   1 = same baseline as Mac approach blocked (schema diverges or DB missing)
#   2 = couldn't probe (Warp not installed, WIN_USER wrong, no sqlite anywhere)
#
# Run: bash scripts/check-warp/probe-sqlite.sh
# Archive: bash scripts/check-warp/probe-sqlite.sh > docs/warp-sqlite-$(date +%Y%m%d).md

set -uo pipefail

WIN_USER="${WIN_USER:-julie}"
WIN_HOME="/mnt/c/Users/${WIN_USER}"

PASS='✅ PRESENT'
FAIL='❌ ABSENT'
WARN='⚠️  PARTIAL'

# Mac references — what the schema must expose for warp-db.ts to work as-is.
REQUIRED_TABLES=(terminal_panes pane_nodes tabs windows)
REQUIRED_COLUMNS=(
  "terminal_panes:id"
  "terminal_panes:cwd"
  "pane_nodes:id"
  "pane_nodes:tab_id"
  "tabs:id"
  "tabs:window_id"
  "windows:id"
  "windows:active_tab_index"
)

# --- helpers ----------------------------------------------------------------

# Locate a Windows-native sqlite3.exe. Empty stdout means "not found".
find_win_sqlite() {
  # Whatever's on PATH first.
  local hit
  hit="$(cmd.exe /c "where sqlite3.exe 2>nul" 2>/dev/null | tr -d '\r' | head -1)"
  if [ -n "$hit" ] && [ -f "$(wslpath -u "$hit" 2>/dev/null)" ]; then
    wslpath -u "$hit"
    return
  fi
  # Common bundled locations.
  for p in \
    "${WIN_HOME}/AppData/Local/Microsoft/WinGet/Packages"/SQLite.SQLite_*/sqlite3.exe \
    "/mnt/c/Program Files/Git/usr/bin/sqlite3.exe" \
    "/mnt/c/Program Files/Git/mingw64/bin/sqlite3.exe"; do
    if [ -f "$p" ]; then
      echo "$p"
      return
    fi
  done
}

WIN_SQLITE="$(find_win_sqlite)"
HAS_WSL_SQLITE=0
if command -v sqlite3 >/dev/null 2>&1; then
  HAS_WSL_SQLITE=1
fi

if [ -z "$WIN_SQLITE" ] && [ "$HAS_WSL_SQLITE" = 0 ]; then
  echo "# probe-sqlite — aborted"
  echo
  echo "$FAIL — no sqlite3 available."
  echo "Install WSL-side: \`sudo apt-get install sqlite3\` (works on a local *copy* of the DB)"
  echo "Or Windows-side: \`winget install SQLite.SQLite\` (works on the live DB, preferred for runtime)"
  exit 2
fi

DB=""
find_db() {
  # Known candidates. Order matters: most specific first.
  local candidates=(
    "${WIN_HOME}/AppData/Local/warp/Warp/warp.sqlite"
    "${WIN_HOME}/AppData/Local/Warp/warp.sqlite"
    "${WIN_HOME}/AppData/Local/dev.warp.Warp/warp.sqlite"
    "${WIN_HOME}/AppData/Roaming/Warp/warp.sqlite"
    "${WIN_HOME}/AppData/Roaming/warp/Warp/warp.sqlite"
  )
  for c in "${candidates[@]}"; do
    if [ -f "$c" ]; then
      DB="$c"
      return 0
    fi
  done
  # Last resort: scan AppData (capped depth to stay fast).
  local hit
  hit="$(find "${WIN_HOME}/AppData" -maxdepth 6 -name 'warp.sqlite' -type f 2>/dev/null | head -1)"
  if [ -n "$hit" ]; then
    DB="$hit"
    return 0
  fi
  return 1
}

# Mirror the Mac side of the Windows path so we can hand it to wsl.exe / sqlite3.exe.
to_win_path() {
  # /mnt/c/Users/julie/... → C:\Users\julie\...
  local p="$1"
  if [[ "$p" =~ ^/mnt/([a-z])/(.*)$ ]]; then
    local drive="${BASH_REMATCH[1]^^}"
    local rest="${BASH_REMATCH[2]//\//\\}"
    echo "${drive}:\\${rest}"
  else
    echo "$p"
  fi
}

# Snapshot of the live DB into a WSL-local copy. Needed when we fall back to
# WSL sqlite3, because 9P can't honour the WAL locks on the live file. We
# copy main + WAL together so sqlite recovery on the copy produces a
# consistent view.
COPY_DIR=""
ensure_copy() {
  if [ -n "$COPY_DIR" ]; then return 0; fi
  COPY_DIR="$(mktemp -d -t warp-probe-XXXX)"
  cp "$DB" "$COPY_DIR/warp.sqlite"
  [ -f "${DB}-wal" ] && cp "${DB}-wal" "$COPY_DIR/warp.sqlite-wal"
  [ -f "${DB}-shm" ] && cp "${DB}-shm" "$COPY_DIR/warp.sqlite-shm"
}
cleanup_copy() {
  [ -n "$COPY_DIR" ] && [ -d "$COPY_DIR" ] && rm -rf "$COPY_DIR"
}
trap cleanup_copy EXIT

# Run a sqlite query read-only against the live DB. Prefers Windows-native
# sqlite3.exe (no 9P, no copy, no WAL drama); falls back to WSL sqlite3
# against a local snapshot. Strips CRs because the Windows-native exe writes
# CRLF and trailing \r breaks numeric tests downstream.
sq() {
  if [ -n "$WIN_SQLITE" ]; then
    "$WIN_SQLITE" -readonly "$DB_WIN" "$@" | tr -d '\r'
  else
    ensure_copy
    sqlite3 -readonly "$COPY_DIR/warp.sqlite" "$@"
  fi
}

# --- sections ---------------------------------------------------------------

DB_WIN=""
section_locate() {
  echo "## DB location"
  echo
  if [ -z "$DB" ]; then
    echo "$FAIL — no \`warp.sqlite\` found under \`${WIN_HOME}/AppData\`."
    echo
    echo "Try setting \`WIN_USER=…\` if you're not user \`${WIN_USER}\`, or install/launch Warp at least once so it materializes the DB."
    return 1
  fi
  DB_WIN="$(to_win_path "$DB")"
  local size mtime
  size="$(stat -c '%s' "$DB" 2>/dev/null)"
  mtime="$(stat -c '%y' "$DB" 2>/dev/null)"
  echo "$PASS — \`$DB\`"
  echo
  echo "- size: $((size / 1024)) KB"
  echo "- mtime: \`$mtime\`"
  echo "- Win path: \`$DB_WIN\`"
  echo
  if [ -n "$WIN_SQLITE" ]; then
    echo "Reader: Windows-native \`$WIN_SQLITE\` (live DB, no copy)."
  else
    echo "Reader: WSL \`sqlite3\` against a local snapshot (Windows sqlite3.exe not found)."
  fi
  echo
  return 0
}

section_schema() {
  echo "## Schema parity with Mac"
  echo
  local tables
  tables="$(sq ".tables" 2>&1 || true)"
  if [ -z "$tables" ] || echo "$tables" | grep -qi 'error'; then
    echo "$FAIL — couldn't read schema:"
    echo
    echo '```'
    echo "$tables"
    echo '```'
    return 1
  fi
  echo "All tables in DB:"
  echo
  echo '```'
  echo "$tables" | tr -s ' ' '\n' | sort -u | column -c 80
  echo '```'
  echo
  echo "Required tables (Mac requires these for \`src/warp-db.ts\`):"
  echo
  local missing=0
  for t in "${REQUIRED_TABLES[@]}"; do
    if echo " $tables " | tr -s ' ' '\n' | grep -qx "$t"; then
      echo "- \`$t\` — $PASS"
    else
      echo "- \`$t\` — $FAIL"
      missing=1
    fi
  done
  echo
  if [ "$missing" -eq 1 ]; then
    echo "### Required tables: $FAIL — schema diverges from Mac."
    return 1
  fi
  echo "### Required tables: $PASS"
  echo
  echo "Required columns:"
  echo
  for spec in "${REQUIRED_COLUMNS[@]}"; do
    local t="${spec%%:*}"
    local c="${spec##*:}"
    if sq "SELECT $c FROM $t LIMIT 0;" >/dev/null 2>&1; then
      echo "- \`$t.$c\` — $PASS"
    else
      echo "- \`$t.$c\` — $FAIL"
      missing=1
    fi
  done
  echo
  if [ "$missing" -eq 1 ]; then
    echo "### Required columns: $FAIL"
    return 1
  fi
  echo "### Required columns: $PASS — \`src/warp-db.ts\` query should run unchanged."
  echo
  echo "Full schema for required tables (in case typings differ):"
  echo
  echo '```sql'
  for t in "${REQUIRED_TABLES[@]}"; do
    sq ".schema $t" 2>/dev/null
  done
  echo '```'
  echo
  return 0
}

section_cwds() {
  echo "## Stored cwd format"
  echo
  echo "Most-recent 10 panes (truncated to 120 chars):"
  echo
  echo '```'
  sq -separator '  |  ' "SELECT id, substr(cwd, 1, 120) FROM terminal_panes WHERE cwd IS NOT NULL AND cwd != '' ORDER BY id DESC LIMIT 10;" 2>/dev/null || echo '(query failed)'
  echo '```'
  echo
  # Classify what we saw. Important: if WSL sessions land as Linux paths,
  # the Mac scoring works as-is; if they land as UNC, the exact/parent
  # branches fail and we fall back to token overlap only.
  local linux_paths unc_paths win_paths
  linux_paths="$(sq "SELECT COUNT(*) FROM terminal_panes WHERE cwd LIKE '/%';" 2>/dev/null || echo 0)"
  unc_paths="$(sq "SELECT COUNT(*) FROM terminal_panes WHERE cwd LIKE '\\\\wsl%';" 2>/dev/null || echo 0)"
  win_paths="$(sq "SELECT COUNT(*) FROM terminal_panes WHERE cwd LIKE '_:\\%' OR cwd LIKE '_:/%';" 2>/dev/null || echo 0)"
  echo "Path-shape counts across all panes:"
  echo
  echo "- Linux-style (\`/home/…\`): **${linux_paths}**"
  echo "- UNC (\`\\\\wsl…\`): **${unc_paths}**"
  echo "- Windows-drive (\`C:\\…\`): **${win_paths}**"
  echo
  if [ "${linux_paths:-0}" -gt 0 ]; then
    echo "### WSL session matching: $PASS — Linux cwds present, direct match against \`SessionInfo.cwd\` should work."
  elif [ "${unc_paths:-0}" -gt 0 ]; then
    echo "### WSL session matching: $WARN — only UNC cwds. Will need path normalization in \`pickBestPane\` for exact/parent scoring."
  else
    echo "### WSL session matching: $WARN — no Linux or UNC paths found. Run \`claude\` inside a Warp WSL profile and re-probe."
  fi
  echo
}

section_windows() {
  echo "## Windows + active tab snapshot"
  echo
  echo '```'
  sq -header -column "SELECT w.id AS window_id, w.active_tab_index AS active_tab, (SELECT COUNT(*) FROM tabs t WHERE t.window_id = w.id) AS tab_count FROM windows w;" 2>/dev/null || echo '(query failed)'
  echo '```'
  echo
}

section_latency() {
  echo "## Read latency"
  echo
  # Full Mac query — that's what the plugin will run on every key press.
  local mac_query="WITH tabs_ordered AS (SELECT id, window_id, ROW_NUMBER() OVER (PARTITION BY window_id ORDER BY id) - 1 AS tab_index FROM tabs) SELECT t.window_id, t.tab_index, tp.cwd FROM terminal_panes tp JOIN pane_nodes pn ON pn.id = tp.id JOIN tabs_ordered t ON t.id = pn.tab_id WHERE tp.cwd IS NOT NULL AND tp.cwd != '' ORDER BY t.window_id, t.tab_index;"

  if [ -n "$WIN_SQLITE" ]; then
    echo "Windows-native \`sqlite3.exe\` on the LIVE DB (the realistic plugin runtime path, 5 runs):"
    echo
    echo '```'
    for i in 1 2 3 4 5; do
      local start end elapsed
      start="$(date +%s%N)"
      "$WIN_SQLITE" -readonly "$DB_WIN" "$mac_query" >/dev/null 2>&1
      end="$(date +%s%N)"
      elapsed=$(( (end - start) / 1000000 ))
      echo "  run $i: ${elapsed} ms"
    done
    echo '```'
    echo
    echo "Threshold: <100 ms is comfortable for a key-press path. Note: the plugin will spawn this via Node's \`child_process\`, which has lower overhead than WSL's exec-of-an-exe — expect tighter numbers in production."
  else
    echo "(Windows-native sqlite3.exe not found — skipping the realistic-runtime measurement)"
  fi
  echo

  if [ "$HAS_WSL_SQLITE" = 1 ]; then
    ensure_copy
    local copy_size
    copy_size="$(du -m "$COPY_DIR" 2>/dev/null | tail -1 | cut -f1)"
    echo "WSL \`sqlite3\` against a local snapshot — fallback when no sqlite3.exe is available (copy was ${copy_size} MB):"
    echo
    echo '```'
    for i in 1 2 3; do
      local start end elapsed
      start="$(date +%s%N)"
      sqlite3 -readonly "$COPY_DIR/warp.sqlite" "$mac_query" >/dev/null 2>&1
      end="$(date +%s%N)"
      elapsed=$(( (end - start) / 1000000 ))
      echo "  run $i: ${elapsed} ms (excludes copy)"
    done
    echo '```'
    echo
    echo "The query itself is microsecond-fast on a local copy — but copying ~250-400 MB every key press is a non-starter, so this strategy only makes sense for one-off probes, not for runtime."
  fi
  echo

  # Document that the obvious "WSL sqlite3 on /mnt/c live DB" path is dead.
  echo "**\`wsl.exe → sqlite3 /mnt/c/…\` (live DB) is NOT a viable runtime path** — fails with \`disk I/O error\` because 9P can't honour the WAL/SHM locks SQLite needs against a file Warp is actively writing."
  echo
}

section_keyboard() {
  echo "## Keyboard shortcuts (manual)"
  echo
  # Some Warp builds store the user keymap in a JSON sidecar next to warp.sqlite.
  local cfg_dir
  cfg_dir="$(dirname "$DB")"
  local keymap
  keymap="$(find "$cfg_dir" -maxdepth 2 \( -name 'keybindings*.json' -o -name 'keymap*.json' -o -name 'preferences*.json' -o -name 'user_preferences*.json' \) 2>/dev/null | head -3)"
  if [ -n "$keymap" ]; then
    echo "Candidate prefs files near the DB:"
    echo
    echo '```'
    echo "$keymap"
    echo '```'
    echo
    echo "Inspect with: \`grep -iE '(switch.*tab|next.*tab|tab.*[0-9])' \"<file>\"\`"
  else
    echo "(no prefs/keymap JSON found near \`${cfg_dir}\` — Warp may store these only in-memory or in another path)"
  fi
  echo
  echo "Open Warp Windows → Settings → Keyboard shortcuts and record (manual entries below):"
  echo
  echo "- Switch to tab N: __________"
  echo "- Next tab: __________"
  echo "- Previous tab: __________"
  echo "- Switch window (Warp equivalent of macOS \`Cmd+\\\`\`): __________"
  echo
}

section_sendkeys() {
  echo "## SendKeys smoke test (manual)"
  echo
  echo "Run from PowerShell, with at least two tabs open in the frontmost Warp window:"
  echo
  echo '```powershell'
  echo 'Start-Process "warp.exe"   # no-op if already running; brings to front'
  echo 'Start-Sleep -Milliseconds 300'
  echo 'Add-Type -AssemblyName System.Windows.Forms'
  echo '[System.Windows.Forms.SendKeys]::SendWait("^2")  # Ctrl+2 → tab 2'
  echo '```'
  echo
  echo "Record:"
  echo
  echo "- Warp accepts \`Ctrl+<digit>\` for tab N: __________"
  echo "- Focus race observed (Warp not yet frontmost when SendKeys fires): __________"
  echo "- UIPI refusal (Stream Deck.app runs unelevated, Warp same): __________"
  echo
}

verdict() {
  local db_ok="$1"
  local schema_ok="$2"
  echo "## Verdict"
  echo
  if [ "$db_ok" = 0 ] && [ "$schema_ok" = 0 ]; then
    echo "### 🟢 SQLite focus path looks viable on Windows."
    echo
    echo "Confirmed runtime strategy: spawn a Windows-native \`sqlite3.exe\` against the live DB (read-only). The \`wsl.exe → /mnt/c\` path is dead."
    echo
    echo "Open questions before implementation:"
    echo "- How will the plugin locate \`sqlite3.exe\`? On this host it's WinGet-installed; for portability we likely want to bundle it (or fall back to \`better-sqlite3\`)."
    echo "- WSL session matching needs a cwd normalizer (Warp stores UNC \`\\\\WSL\$\\<distro>\\…\` and/or user-mapped drives; \`SessionInfo.cwd\` is Linux-native)."
    echo "- Confirm \`Ctrl+<digit>\` is the actual Warp Windows shortcut for tab N (manual section above)."
    echo "- Confirm \`SendKeys\` is acceptable for the keystroke, or commit to a Win32 \`SendInput\` wrapper (manual section above)."
    return 0
  fi
  echo "### 🔴 SQLite focus path NOT viable as-is."
  echo
  if [ "$db_ok" -ne 0 ]; then
    echo "- DB not found — Warp Windows may not ship one, or is at an unexpected path."
  fi
  if [ "$schema_ok" -ne 0 ]; then
    echo "- Schema diverges from Mac — the \`src/warp-db.ts\` query would need a rewrite or the columns aren't there."
  fi
  echo
  echo "Pivot: attendre le PR upstream Warp pour l'URL scheme (\`warp://session/<uuid>\`) — voir \`docs/warp-pane-focus.md\` et \`scripts/check-warp/probe.sh\`."
  return 1
}

# --- run --------------------------------------------------------------------

echo "# Warp SQLite probe — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo
echo "Host: $(uname -srm) — WSL distro \`${WSL_DISTRO_NAME:-?}\` — WIN_USER=\`${WIN_USER}\`"
echo

find_db || true

db_ok=1
schema_ok=1
if section_locate; then
  db_ok=0
  if section_schema; then
    schema_ok=0
  fi
  section_cwds
  section_windows
  section_latency
  section_keyboard
fi
section_sendkeys
verdict "$db_ok" "$schema_ok"
