# streamdeck-claude

A Stream Deck plugin that mirrors the live state of your running Claude Code CLI sessions on up to 5 keys. Sessions auto-fill the slots in start-time order (oldest at slot 1). Each key shows the project name and its current state:

| State | Color | Meaning |
|---|---|---|
| working | amber | Claude is generating / running tools |
| idle | blue | Claude is waiting for your next prompt |
| awaiting | orange (pulsing) | Claude has popped a permission prompt — your turn |
| awaiting_plan | violet (pulsing) | Claude has called `ExitPlanMode` and is waiting for plan approval |
| finished | green | The session just ended (visible for ~3 s, then drops) |
| empty | dim | No session in this slot |

Pressing a key copies the session's project path (`cwd`) to the clipboard.

Reference SVGs of the five states live in [`icons/`](./icons).

## How it works

- Claude Code writes one JSON file per running CLI session under `~/.claude/sessions/<pid>.json`.
- The plugin polls that directory once per second, batches a `kill -0 <pid>` check (over `wsl.exe -d Ubuntu` on Windows hosts) to filter out stale files, sorts the live sessions by `startedAt`, and renders an SVG per slot via `setImage`.
- The "awaiting permission" state is fed by a Claude Code `Notification` hook that drops `~/.claude/sessions/<sessionId>.notify.json` whenever Claude needs the user's attention. The plugin treats `status=idle` + recent (<60 s mtime) notify file as `awaiting`.
- The "awaiting plan approval" state is fed by `PreToolUse` and `PostToolUse` hooks scoped to the `ExitPlanMode` tool. The pre-hook drops `<sessionId>.plan.json`, the post-hook removes it. While the file exists and the session is idle, the slot shows the violet pulsing "plan" icon.

## Setup (one-time)

Prereqs: pnpm, jq, Node.js 20+, an Elgato Stream Deck connected to a Windows host with the Stream Deck app installed and Windows Developer Mode enabled (lets `mklink /D` work without admin).

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
- **Windows**: a PowerShell hook (`hooks/notification.ps1`) copied to `%USERPROFILE%\.claude\hooks\streamdeck-claude-notification.ps1` and invoked via `powershell.exe -File ...`. We use a copy rather than a `\\wsl.localhost\…` reference so the hook keeps working even if WSL is suspended.

Both hooks behave identically: they read the Notification event from stdin, extract `session_id`, and drop `<sessionId>.notify.json` next to that side's session JSON files. The plugin reads both directories and treats a fresh notify file (mtime <60 s) on an idle session as the orange "awaiting" state.

`pnpm sd:link` shells through `cmd.exe` to run a real Windows `mklink /D`, with the symlink target as `\\wsl.localhost\Ubuntu\home\julien\dev\streamdeck-claude\com.julien.claudesessions.sdPlugin`. We don't use `streamdeck link` directly because it creates a Linux-style symlink (target = `/home/...`) which the Windows-side Stream Deck app can't follow.

After linking, **quit + relaunch the Stream Deck app** (right-click tray icon → Quit). The "Claude Sessions" category appears in the actions list — drag **Claude Session Slot** onto five keys.

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
| `pnpm install:hook:windows` | Same for Windows `%USERPROFILE%\.claude\settings.json` (copies a PowerShell hook) |
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

- **Different WSL distro**: set the `WSL_DISTRO_NAME` env var. Auto-detected by `link-plugin.sh` and read at runtime via `src/env.ts`.
- **Different Windows username / home path**: `USERPROFILE` is set by Windows and used directly. For a different WSL home, set `HOME` before launching the plugin. All path resolution lives in `src/env.ts`.
- **More than 5 keys**: just drop more `Claude Session Slot` actions; the plugin orders them by deck position (top-to-bottom, left-to-right) and renders as many as you give it. Sessions in excess of available keys are not displayed.
- **Different icon designs**: edit `src/icons/`, then `pnpm icons:render` to refresh the reference SVGs in `icons/`.

## Verification checklist

1. `pnpm build` produces `com.julien.claudesessions.sdPlugin/bin/plugin.js`.
2. `pnpm sd:validate` reports "Validation successful".
3. `pnpm install:hook` — `jq '.hooks.Notification' ~/.claude/settings.json` shows the new hook.
4. `pnpm sd:link` — output contains "✓ symlink resolves through Windows".
5. Quit + relaunch the Stream Deck app. Drag **Claude Session Slot** onto 5 keys.
6. In a terminal, run `claude` here. Slot 1 fills with `streamdeck-claude` in green while it works, blue while idle.
7. Trigger a permission prompt → slot flips to orange within ~1 s.
8. Open `claude` in another `cwd` → slot 2 lights up.
9. Exit one session → it shows gray "finished" briefly, then empties.
10. Press a key → paste in any Windows app: confirm the project path appears.
