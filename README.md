# streamdeck-claude

A Stream Deck plugin that mirrors the live state of your running Claude Code CLI sessions across however many keys you assign it. Sessions auto-fill the slots in start-time order (oldest at slot 1); excess sessions beyond the slot count are simply not displayed. Each key shows the project name and its current state:

| State | Color | Meaning |
|---|---|---|
| working | amber | Claude is generating / running tools |
| subagent | amber (orbit) | Claude has delegated to a subagent (the parent is waiting) |
| idle | blue | Claude is waiting for your next prompt |
| awaiting | orange (pulsing) | Claude has popped a permission prompt — your turn |
| awaiting_plan | violet (pulsing) | Claude has called `ExitPlanMode` and is waiting for plan approval |
| error | red (pulsing) | The last turn ended in failure (rate limit / auth / server error) |
| finished | green | The session just ended (visible for ~3 s, then drops) |
| empty | dim | No session in this slot |

Pressing a key copies the session's project path (`cwd`) to the clipboard.

Reference SVGs for every state live in [`icons/`](./icons).

## How it works

- Claude Code writes one JSON file per running CLI session under `~/.claude/sessions/<pid>.json`.
- The plugin polls that directory once per second, batches a `kill -0 <pid>` check (over `wsl.exe -d Ubuntu` when running on a Windows host, plain bash on macOS/Linux) to filter out stale files, sorts the live sessions by `startedAt`, and renders an SVG per slot via `setImage`.
- Each registered Claude Code hook event appends one JSON line to `~/.claude/sessions/<sessionId>.events.ndjson`. The plugin reads that log every tick and replays it through a small state machine (`src/session-events.ts`) to derive the icon state.

| Hook event | Effect on state |
|---|---|
| `SessionStart` | truncates the log + resets state |
| `Notification` | sets `awaiting` |
| `Stop` | clears `awaiting` / `awaitingPlan` |
| `PreToolUse[ExitPlanMode]` | sets `awaitingPlan` |
| `PostToolUse[ExitPlanMode]` | clears `awaitingPlan` |
| `StopFailure` | sets `errored` |
| `UserPromptSubmit` | clears `awaiting` / `awaitingPlan` / `errored` |
| `SubagentStart` / `SubagentStop` | bumps `subagentDepth` ±1 |
| `SessionEnd` | unlinks the log |

  Pure event-driven: the log is the source of truth. No mtime heuristics, no per-state files, no race conditions between drop/rm pairs. To add a new state, register the event in `scripts/install-hook.sh` and add a case in `src/session-events.ts`.

## Setup (one-time)

Prereqs: pnpm, jq, perl, Node.js 20+, an Elgato Stream Deck with the SD app installed.

### macOS

```bash
pnpm install
pnpm build
pnpm install:hook    # add hooks to ~/.claude/settings.json
pnpm sd:link         # symlink .sdPlugin into ~/Library/Application Support/com.elgato.StreamDeck/Plugins/
pnpm sd:validate
# Quit + relaunch the Stream Deck app so it picks up the new plugin.
```

No `mklink`, no Developer Mode, no UNC — the macOS branch of each script just uses native `ln -s` and writes the hook directly to `~/.claude/settings.json`.

**Warp tab focus (optional):** pressing a slot copies the session's `cwd` to the clipboard and, on macOS, also tries to focus the matching Warp tab. Warp exposes no public focus API (URL scheme, AppleScript, CLI — all confirmed missing; its AX tree is empty too), so the plugin reads Warp's local SQLite DB (`~/Library/Group Containers/2BBY89MBSN.dev.warp/…/warp.sqlite`, read-only) to map `cwd → (window, tab_index)`, scores by exact match > prefix > token overlap on path components, then sends `Cmd+<digit>` (tabs 1-9) or `Cmd+Option+→/←` cycling (tabs 10+) via System Events. On first click, macOS prompts to allow **Stream Deck** under *System Settings → Privacy & Security → Accessibility*. If you decline, the clipboard copy still works; only the focus attempt is silently skipped.

### WSL + Windows

Extra prereq: Windows Developer Mode enabled (lets `mklink /D` work without admin).

```bash
pnpm install
pnpm sd:dev                  # enable Stream Deck developer mode (one-time)
pnpm build
pnpm install:hook            # add Notification hook to WSL ~/.claude/settings.json
pnpm install:hook:windows    # add Notification hook to Windows %USERPROFILE%\.claude\settings.json
pnpm sd:link                 # symlink the .sdPlugin folder into the Windows Plugins dir
pnpm sd:validate             # sanity-check manifest + assets
```

The two `install:hook` scripts are idempotent — re-run any time. They install:
- **WSL**: a Bash hook (`hooks/notification.sh`) referenced by an absolute WSL path.
- **Windows**: a PowerShell hook command pointing at `hooks/notification.ps1` over the `\\wsl.localhost\<distro>\…` UNC path. **No copy** — both bash and PowerShell sides read the same `hooks/events.json` from the repo, so editing it once propagates to both.

Both hooks behave identically: they read the hook payload from stdin, extract `session_id` + `hook_event_name` (+ optional `tool_name`), and append a single JSON line to `<sessionId>.events.ndjson` next to that side's session JSON files. The plugin reads both directories and replays each log through `src/session-events.ts` to derive state.

`pnpm sd:link` shells through `cmd.exe` to run a real Windows `mklink /D`, with the symlink target as `\\wsl.localhost\Ubuntu\home\julien\dev\streamdeck-claude\com.julien.claudesessions.sdPlugin`. We don't use `streamdeck link` directly because it creates a Linux-style symlink (target = `/home/...`) which the Windows-side Stream Deck app can't follow.

After linking, **quit + relaunch the Stream Deck app** (right-click tray icon → Quit). The "Claude Sessions" category appears in the actions list — drag **Claude Session Slot** onto as many keys as you want to dedicate to live sessions. The plugin orders them by deck position (top-to-bottom, left-to-right) and fills as many as you provide.

**Warp tab focus (optional):** as on macOS, pressing a slot also tries to focus the matching Warp tab. The Windows port reads the same SQLite schema (under `%LOCALAPPDATA%\warp\Warp\data\warp.sqlite`) but the cwd values are Windows-shaped even for WSL shells — UNC (`\\WSL$\<distro>\…`, `\\wsl.localhost\<distro>\…`) or user-mapped drives (`W:\…`) — so the plugin normalizes those back to Linux form before scoring. Keystroke goes via Win32 `SendInput` with `Ctrl+VK_NUMPAD<n>` (tabs 1-9) or `Ctrl+PageDown/PageUp` cycle (tabs 10+) — Warp Windows only binds numpad digits, not top-row. Cross-process focus raise uses `AttachThreadInput` + `SetForegroundWindow` so the keystroke lands on Warp even when another app (Chrome, VS Code, …) is foreground when you press the deck key. Requires `sqlite3.exe` on PATH or under a known install dir (WinGet, Git for Windows) — `winget install SQLite.SQLite` if missing. No accessibility prompt.

## Available pnpm scripts

| Script | What it does |
|---|---|
| `pnpm build` | Rollup → `com.julien.claudesessions.sdPlugin/bin/plugin.js` |
| `pnpm watch` | `rollup -w`; quit + relaunch the SD app to pick up changes |
| `pnpm sd:link` / `pnpm sd:unlink` | (re)create / remove the Windows symlink |
| `pnpm sd:validate` | Run `streamdeck validate` |
| `pnpm sd:pack` | Bundle `dist/com.julien.claudesessions.streamDeckPlugin` for distribution |
| `pnpm sd:dev` | Enable Stream Deck developer mode |
| `pnpm sd:reload` | Reload **just** this plugin in ~1 s without quitting the SD app |
| `pnpm install:hook` | Idempotently merge the Notification hook into WSL `~/.claude/settings.json` |
| `pnpm install:hook:windows` | Same for Windows `%USERPROFILE%\.claude\settings.json` (registers the PowerShell hook over the WSL UNC path; no copy) |
| `pnpm icons:render` | Re-render `icons/*.svg` reference assets from `src/icons/` |
| `pnpm icons:static` | Re-render manifest PNG assets from `assets/svg/` via @resvg/resvg-js |

> **Reload flow.** The plugin watches `~/.claude/.streamdeck-claude.reload`; whenever its mtime changes, the plugin calls `process.exit(0)` and the Stream Deck app respawns it (this is the SD app's normal behaviour for plugin crashes). `pnpm sd:reload` just `touch`es the file. `pnpm watch` triggers it automatically on each rebuild.
>
> The Elgato `streamdeck restart`/`list` commands don't work from WSL when our plugin is symlinked to `/home/julien/...`: those commands try to `readlink` the Windows-side symlink (whose target is a `\\wsl.localhost` UNC), and the WSL filesystem driver returns `EIO`. The reload trigger sidesteps all of that.
>
> The first time after building, you still need to quit + relaunch the SD app once (since the *currently-running* bundle doesn't yet know how to self-reload). After that, `pnpm sd:reload` is enough.

Plugin logs land at `%APPDATA%\Elgato\StreamDeck\Plugins\com.julien.claudesessions.sdPlugin\logs\`.

## Project layout

```
.
├── com.julien.claudesessions.sdPlugin/   # the canonical Elgato plugin folder
│   ├── manifest.json
│   ├── bin/plugin.js                     # built bundle
│   └── imgs/                             # static manifest icons
├── src/
│   ├── plugin.ts                         # entry, polling loop
│   ├── slot-action.ts                    # SingletonAction, key handlers
│   ├── sessions.ts                       # reads ~/.claude/sessions/
│   ├── live-pids.ts                      # batched kill -0 over wsl.exe
│   ├── warp-db.ts                        # read-only sqlite3 -> (window, tab_index) for a cwd
│   ├── warp-cwd.ts                       # Win UNC / drive normalizer for WSL paths
│   ├── warp-focus.ts                     # platform dispatcher
│   ├── warp-focus-mac.ts                 # osascript activate + Cmd+digit / cycle keystroke
│   ├── warp-focus-win.ts                 # powershell.exe + AttachThreadInput + SendInput
│   └── icons/                            # renderIcon(state, slot, label) -> SVG; theme, motifs, states, render — split per concern
├── icons/                                # standalone reference SVGs (one per state)
├── hooks/
│   ├── notification.sh                   # WSL-side Notification hook (Bash)
│   └── notification.ps1                  # Windows-side Notification hook (PowerShell)
└── scripts/
    ├── install-hook.sh                   # merge hook into WSL ~/.claude/settings.json (also `--target=windows` to copy + merge into %USERPROFILE%\.claude\settings.json)
    ├── link-plugin.sh                    # mklinks the .sdPlugin into Windows Plugins dir
    ├── unlink-plugin.sh                  # removes the symlink
    ├── reload-plugin.sh                  # touches the reload trigger to respawn the plugin
    ├── render-icons.mjs                  # regenerates icons/*.svg from src/icons/
    └── render-static-pngs.mjs            # rasterizes assets/svg/*.svg into manifest PNGs (@resvg/resvg-js)
```

## Tweaks

- **Different WSL distro**: set the `WSL_DISTRO_NAME` env var. Auto-detected by `link-plugin.sh` and `install-hook.sh`; baked into the bundle at `pnpm build` time so the SD-launched plugin (which doesn't see WSL env vars) still resolves the right UNC path.
- **Different Windows username / home path**: `USERPROFILE` is set by Windows and used directly. For a different WSL home, just `pnpm build` from that home — `HOME` at build time is captured by rollup and baked into the bundle. All path resolution lives in `src/env.ts`.
- **Different icon designs**: edit `src/icons/`, then `pnpm icons:render` to refresh the reference SVGs in `icons/`.

## Verification checklist

1. `pnpm build` produces `com.julien.claudesessions.sdPlugin/bin/plugin.js`.
2. `pnpm sd:validate` reports "Validation successful".
3. `pnpm install:hook` — `jq '.hooks.Notification' ~/.claude/settings.json` shows the new hook.
4. `pnpm sd:link` — output contains "✓ symlink resolves through Windows".
5. Quit + relaunch the Stream Deck app. Drag **Claude Session Slot** onto whatever keys you want to dedicate to live sessions.
6. In a terminal, run `claude` here. Slot 1 fills with `streamdeck-claude` in green while it works, blue while idle.
7. Trigger a permission prompt → slot flips to orange within ~1 s.
8. Open `claude` in another `cwd` → slot 2 lights up.
9. Exit one session → it shows gray "finished" briefly, then empties.
10. Press a key → paste in any Windows app: confirm the project path appears.
