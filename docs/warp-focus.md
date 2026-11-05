# Warp tab focus

Pressing a slot copies the session's `cwd` to the clipboard, then tries to focus the Warp pane that hosts the session. Focus is best-effort and silent on failure.

## Primary path: session deep link

Warp injects `WARP_FOCUS_URL` (`<scheme>://session/<uuid>`) into every pane's shell. Opening that URL makes Warp find the pane across all windows, show the window, switch tab and focus the pane. Env vars, URL format and channels are documented in [`warp-pane-focus.md`](./warp-pane-focus.md).

How the plugin gets and uses it:

1. The hooks (`hooks/notification.sh` / `.ps1`) add a `warp` field carrying `WARP_FOCUS_URL` to **every** event line in `<sid>.events.ndjson` (not only `SessionStart`, so a "Refresh States" wipe recovers on the next event). No hook reinstall is needed: the registered command points at the repo script.
2. `parseEventLog` keeps the value only if it matches `^warp[a-z]*://session/[0-9a-f]{32}$`. This is a security gate: the value is passed to `open` / `Start-Process`. `reduceEvents` latches the last valid one as `DerivedState.warpFocusUrl`.
3. On key press, after the clipboard copy:
   - macOS: `/usr/bin/open <url>`. No `osascript`, no Accessibility permission on this path.
   - Windows: one PowerShell run that borrows the foreground lock (`AttachThreadInput` to the foreground thread + `AllowSetForegroundWindow(ASFW_ANY)`), then `Start-Process <url>`. **Untested so far.**

Verified on macOS (Warp 0.2026.09.30.08.29.01): `open "$WARP_FOCUS_URL"` exits 0 in about 200 ms, and `~/Library/Logs/warp.log` shows `received url` then `dispatching action for "root_view:handle_pane_navigation_event"`.

## Fallback: cwd heuristic

Used only when no valid URL is known for the session (session started before the hook update, older Warp, tmux/ssh, not running in Warp) or when opening the URL fails. The plugin reads Warp's local SQLite DB to map `cwd -> (window_id, tab_index)`, then synthesises a per-tab keystroke (`Cmd+<digit>` / `Ctrl+Numpad<digit>`).

Caveats:

- **Lazy DB persistence:** Warp writes its SQLite snapshot lazily. After a deep-link tab switch, `windows.active_tab_index` was still unchanged 2 s later. The DB can therefore lag behind the real tab layout, which is the likely cause of the heuristic landing on the wrong tab after a drag-reorder. Do not assume `tab_index` always matches the visual strip.
- **Same dir in several tabs is ambiguous:** the DB has no link between an OS process and a pane, so cwd is the only join key. With a dir open in 2+ tabs the plugin picks the leftmost.
- **Multi-window is best-effort:** the keystroke goes to whichever Warp window the OS raises first.
- **macOS:** the first call prompts to allow **Stream Deck** under *System Settings -> Privacy & Security -> Accessibility*. If declined, only the focus attempt is skipped.
- **Windows:** needs `sqlite3.exe` on PATH (or under a known WinGet / Git for Windows dir); `winget install SQLite.SQLite` if missing.

### Matching algorithm

Same on both platforms. For each pane row in the DB, score it against the requested `cwd`:

- exact match -> highest priority
- `cwd` is a prefix of `paneCwd` -> next
- shared path components -> fallback (token overlap)

The highest-scoring pane wins. Ties at the **exact (1000)** and **prefix/parent (500)** levels resolve deterministically to the lowest `(window_id, tab_index)`, i.e. the leftmost matching tab, rather than giving up. (This matters for monorepo subdirs: when a session sits in `.../repo/sub` but Warp hasn't flushed that pane's exact cwd, only the parent `.../repo` may be in the DB, open in several tabs; refusing there caused intermittent silent no-ops.) Only pure token-overlap ties have no canonical winner and are dropped silently. If nothing scores above zero, the plugin gives up silently.

Implementation: `src/warp-db.ts` (read + score), `src/warp-focus.ts` (platform dispatcher).

### macOS

**DB path:** `~/Library/Group Containers/2BBY89MBSN.dev.warp/Data/Library/Application Support/dev.warp.Warp-Stable/warp.sqlite` (read-only via `sqlite3` CLI).

**Tab keystroke:**
- Tabs 1-9: `Cmd+<digit>` via `osascript` + System Events.
- Tabs 10+: `Cmd+Option+Right` / `Cmd+Option+Left` cycling, computing the shorter direction from the currently active tab.

### Windows

**DB path:** `%LOCALAPPDATA%\warp\Warp\data\warp.sqlite`.

The cwd values stored by Warp are Windows-shaped even for WSL shells: UNC (`\\WSL$\<distro>\...`, `\\wsl.localhost\<distro>\...`) or user-mapped drives (`W:\...`). The plugin normalises those back to Linux form before scoring (see `src/warp-cwd.ts`).

**Tab keystroke:**
- Tabs 1-9: `Ctrl+VK_NUMPAD<n>` via Win32 `SendInput`. Warp Windows only binds numpad digits, not top-row.
- Tabs 10+: `Ctrl+PageDown` / `Ctrl+PageUp` cycling.

**Cross-process foreground:** the plugin runs as a Stream Deck child process and doesn't own the foreground lock when a key is pressed. A bare `SetForegroundWindow` is silently refused, so the fallback uses the same `AttachThreadInput` trick as the deep-link path.

## Failure modes

All silent: the clipboard copy still works, focus is just skipped. When the deep link fails, the plugin falls back to the heuristic and the log reason includes both outcomes.

| Reason | What it looks like in logs |
|---|---|
| Deep link failed, then fallback result | deep-link reason followed by the fallback reason below |
| No URL known for the session | straight to the fallback path |
| Warp not running | `db-empty` or `warp-not-running` |
| `sqlite3` missing (Windows) | `db-read-failed: spawn sqlite3.exe ENOENT` |
| Accessibility denied (macOS, fallback only) | `keystroke-failed: ...(-1719)` |
| No matching pane | `no-match (rows=N, top=[w1t2@500:"...", ...])`: best-scoring panes + scores, to diagnose ties / stale cwds |
| Multi-window, tab > 9 | succeeds but may target the wrong window; the plugin warns in the log |
