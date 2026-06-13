# VS Code window focus

Pressing a slot copies the session's `cwd` to the clipboard. If the session was
launched in a **VS Code integrated terminal** (WSL-remote or native), the plugin
also tries to bring the matching VS Code **window** to the foreground —
best-effort, silent on failure. Window-level only: VS Code exposes no public map
from cwd to a specific integrated-terminal tab, so the plugin can't target the
exact terminal pane (that would require a companion VS Code extension).

## How a session is tagged as "VS Code"

A `SessionStart` hook runs inside the session's shell and stamps a `term` field
into `<sid>.events.ndjson` (`{"ts":…,"event":"SessionStart","term":"vscode"}`), derived from
`$TERM_PROGRAM` (plus `VSCODE_PID`/`VSCODE_GIT_IPC_HANDLE`, which survive tmux
overwriting `TERM_PROGRAM`). The plugin reduces this into `SessionInfo.terminal`
and dispatches the slot-press focus by kind (`src/terminal-focus.ts`). Sessions
started before the hook existed are tagged `unknown` and fall back to a
Warp-then-VS Code attempt.

## Matching algorithm

`src/vscode-window-match.ts` scores each window title against the cwd:

- the cwd basename present as a title token is required to qualify;
- additional cwd path components present add to the score (tie-break);
- a `[WSL]` marker boosts WSL-origin sessions and penalises Windows-origin ones.

Highest score wins; if no window's title carries the basename, the plugin gives
up silently (the clipboard copy still happened). Matching is title-based because
VS Code's default window title contains `${rootName}` (+ `[WSL: <distro>]`); a
user who reshapes `window.title` to drop the folder name will defeat the match.

## Windows

Enumerate via `Get-Process Code,'Code - Insiders' | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle }`
(HWND + title). Raise the chosen HWND with the shared Win32 dance
(`src/win32-raise.ts`): `AttachThreadInput` transfers the foreground lock from
whatever app the deck press came from, then `ShowWindow`/`BringWindowToTop`/
`SetForegroundWindow`. No keystroke (raise only). Prereq: none beyond PowerShell.

## macOS

VS Code exposes an Accessibility tree, so System Events enumerates
`name of windows of process "Code"`, then `set frontmost to true` +
`perform action "AXRaise"` on the window matched by exact name. Requires Stream
Deck.app to hold Accessibility permission (the same grant the Warp path needs).
Insiders ("Code - Insiders") is not handled on macOS — the AXRaise path names only "Code", so Insiders sessions fall through to the clipboard copy.

## Failure modes

All silent — clipboard still works, focus is skipped:

| Reason | What it looks like in logs |
|---|---|
| VS Code not running | `no-vscode-windows` |
| No window title matches the cwd | `no-match (windows=N)` |
| Accessibility denied (macOS) | `raise-failed: …` |
| `window.title` stripped of `${rootName}` | `no-match` |

## Debugging

`pnpm check:vscode "<cwd>" [wsl|windows]` dumps the enumerated window titles and
the chosen match without raising anything.
