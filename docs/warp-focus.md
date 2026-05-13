# Warp tab focus

Pressing a slot copies the session's `cwd` to the clipboard. On macOS and Windows the plugin **also** tries to focus the matching Warp terminal tab — best-effort, silent on failure.

## Why it's "best-effort"

Warp exposes no public API for tab focus on either platform: no AppleScript dictionary ([warpdotdev/Warp#3364](https://github.com/warpdotdev/Warp/issues/3364)), no URL action verb yet ([warpdotdev/Warp#8611](https://github.com/warpdotdev/Warp/issues/8611)), no CLI subcommand. Its accessibility tree is empty too. So the plugin reads Warp's local SQLite DB to map `cwd → (window_id, tab_index)`, then synthesises a per-tab keystroke (`Cmd+<digit>` / `Ctrl+Numpad<digit>`) to land on the right tab.

This works for ~95 % of single-window setups. Multi-window setups are best-effort: the keystroke goes to whichever Warp window the OS raises first.

If Warp's URL scheme adds a session-focus verb upstream, the plugin will switch to that — see [`warp-pane-focus.md`](./warp-pane-focus.md) for the planned migration.

## Matching algorithm

Same on both platforms. For each pane row in the DB, score it against the requested `cwd`:

- exact match → highest priority
- `cwd` is a prefix of `paneCwd` → next
- shared path components → fallback (token overlap)

The highest-scoring pane wins. If no row scores above zero, the plugin gives up silently — the clipboard copy still happens.

Implementation: `src/warp-db.ts` (read + score), `src/warp-focus.ts` (platform dispatcher).

## macOS

**DB path:** `~/Library/Group Containers/2BBY89MBSN.dev.warp/Data/Library/Application Support/dev.warp.Warp-Stable/warp.sqlite` (read-only via `sqlite3` CLI).

**Tab keystroke:**
- Tabs 1–9: `Cmd+<digit>` via `osascript` + System Events.
- Tabs 10+: `Cmd+Option+→` / `Cmd+Option+←` cycling, computing the shorter direction from the currently active tab.

**Permissions:** macOS prompts on the first call to allow **Stream Deck** under *System Settings → Privacy & Security → Accessibility*. If you decline, the clipboard copy still works; only the focus attempt is silently skipped.

## Windows

**DB path:** `%LOCALAPPDATA%\warp\Warp\data\warp.sqlite`.

The cwd values stored by Warp are Windows-shaped even for WSL shells — UNC (`\\WSL$\<distro>\…`, `\\wsl.localhost\<distro>\…`) or user-mapped drives (`W:\…`). The plugin normalises those back to Linux form before scoring (see `src/warp-cwd.ts`) so a session running in `~/dev/foo` matches the corresponding `\\wsl.localhost\<distro>\home\<user>\dev\foo` entry.

**Tab keystroke:**
- Tabs 1–9: `Ctrl+VK_NUMPAD<n>` via Win32 `SendInput`. Warp Windows only binds numpad digits, not top-row.
- Tabs 10+: `Ctrl+PageDown` / `Ctrl+PageUp` cycling.

**Cross-process foreground:** the plugin runs as a Stream Deck child process and doesn't own the foreground lock when a deck key is pressed (some other app does — Chrome, VS Code, …). A bare `SetForegroundWindow` is silently refused. The plugin uses the `AttachThreadInput` trick: attach our thread's input queue to the current foreground's, transferring the lock long enough to raise Warp and inject the keystroke.

**Prereq:** `sqlite3.exe` on PATH (or under a known WinGet / Git for Windows install dir). `winget install SQLite.SQLite` if missing. No accessibility prompt.

## Failure modes

All of the following are silent — clipboard still works, focus is just skipped:

| Reason | What it looks like in logs |
|---|---|
| Warp not running | `db-empty` or `warp-not-running` |
| `sqlite3` missing (Windows) | `db-read-failed: spawn sqlite3.exe ENOENT` |
| Accessibility denied (macOS) | `keystroke-failed: …(-1719)` |
| No matching pane | `no-match (rows=N)` |
| Multi-window, tab > 9 | succeeds but may target the wrong window — the plugin warns in the log |
