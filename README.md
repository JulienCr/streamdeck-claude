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
- The plugin polls that directory once per second, batches a `kill -0 <pid>` check (over `wsl.exe -d Ubuntu` on Windows hosts) to filter out stale files, sorts the live sessions by `startedAt`, and renders an SVG per slot via `setImage`.
- Hook-driven sidecars under `~/.claude/sessions/<sessionId>.<flag>.json` carry the rest of the state. The dispatch table is `hooks/events.json` (read by both `notification.sh` and `notification.ps1`), every matching rule fires:

| Hook event | Sidecar | TTL | Drives |
|---|---|---|---|
| `Notification` | `notify` (drop) | 60 s | `awaiting` |
| `Stop` | `notify` (rm) | – | clears `awaiting` early |
| `PreToolUse[ExitPlanMode]` | `plan` (drop) | 30 min | `awaiting_plan` |
| `PostToolUse[ExitPlanMode]` | `plan` (rm) | – | clears `awaiting_plan` |
| `StopFailure` | `error` (drop) | 60 s | `error` |
| `SubagentStart` | `subagent` (drop) | 30 min | `subagent` |
| `SubagentStop` | `subagent` (rm) | – | clears `subagent` |
| `SessionEnd` | sweep all sidecars | – | safety-net cleanup on Ctrl-C / crash |

  TTLs are safety nets — the explicit `rm` rules clear flags as soon as the matching event fires.

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
- **Windows**: a PowerShell hook command pointing at `hooks/notification.ps1` over the `\\wsl.localhost\<distro>\…` UNC path. **No copy** — both bash and PowerShell sides read the same `hooks/events.json` from the repo, so editing it once propagates to both.

Both hooks behave identically: they read the hook payload from stdin, extract `session_id` + `hook_event_name`, look up the matching rules in `hooks/events.json`, and drop or remove the corresponding `<sessionId>.<flag>.json` next to that side's session JSON files. The plugin reads both directories and renders the appropriate state based on which sidecars are present (and still within their TTL).

`pnpm sd:link` shells through `cmd.exe` to run a real Windows `mklink /D`, with the symlink target as `\\wsl.localhost\Ubuntu\home\julien\dev\streamdeck-claude\com.julien.claudesessions.sdPlugin`. We don't use `streamdeck link` directly because it creates a Linux-style symlink (target = `/home/...`) which the Windows-side Stream Deck app can't follow.

After linking, **quit + relaunch the Stream Deck app** (right-click tray icon → Quit). The "Claude Sessions" category appears in the actions list — drag **Claude Session Slot** onto as many keys as you want to dedicate to live sessions. The plugin orders them by deck position (top-to-bottom, left-to-right) and fills as many as you provide.

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
