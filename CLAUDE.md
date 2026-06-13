# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Stream Deck plugin that mirrors live Claude Code CLI session state on up to N keys. The runtime is a single Node process (`com.julien.claudesessions.sdPlugin/bin/plugin.js`) launched by the host Stream Deck app. Supported hosts: **Windows (with optional WSL sessions)** and **macOS**. On WSL/Windows the SD app reads the plugin folder over a `\\wsl.localhost\<distro>\…` symlink; on macOS it's a native symlink into `~/Library/Application Support/com.elgato.StreamDeck/Plugins/`. README.md covers setup and the user-visible behaviour — read it before changing anything in `scripts/` or `hooks/`.

## Common commands

Use **pnpm** (not npm/npx) — see global memory.

```bash
pnpm build              # rollup → com.julien.claudesessions.sdPlugin/bin/plugin.js (terser in prod, sourcemaps in watch)
pnpm watch              # rollup -w + auto-touches the reload trigger after each rebuild
pnpm sd:reload          # touch ~/.claude/.streamdeck-claude.reload → plugin self-exits → SD app respawns it (~1s)
pnpm sd:validate        # @elgato/cli validate manifest + assets (sd-cli.sh pins HOME=/mnt/c/Users/$WIN_USER on WSL; native HOME on macOS)
pnpm sd:link / sd:unlink           # (re)create the Windows-side mklink /D into Plugins/
pnpm install:hook                  # register every event feeding reduceEvents into WSL ~/.claude/settings.json
pnpm install:hook:windows          # same for Windows %USERPROFILE%\.claude\settings.json (no copy — registers the .ps1 over UNC)
pnpm check:hooks                   # diff installed hook config against what install-hook.sh would write
pnpm check:vscode                  # enumerate VS Code windows + show which one matches a given cwd (debug)
pnpm icons:render       # regenerate icons/*.svg reference assets from src/icons/
pnpm icons:static       # rasterize manifest PNGs from assets/svg/ via @resvg/resvg-js
```

There is **no test suite and no lint script**. Verify by `pnpm build && pnpm sd:validate && pnpm sd:reload`, then watch logs at `%APPDATA%\Elgato\StreamDeck\Plugins\com.julien.claudesessions.sdPlugin\logs\`.

The Elgato `streamdeck restart` / `streamdeck list` commands fail from WSL with `EIO` because they `readlink` a UNC-targeted symlink — use `pnpm sd:reload` instead. First time after building, you still need to quit + relaunch the SD app once so the new bundle picks up the reload-watcher.

## Architecture

### Dual-origin sessions (the core asymmetry)

Claude Code drops `~/.claude/sessions/<pid>.json` per running CLI session. On Windows the plugin may see two namespaces at once: PIDs from a WSL `claude` and PIDs from a Windows-native `claude.exe` — liveness must be checked separately. On macOS there's only the native namespace (no WSL), so the WSL branch is dormant.

- `src/sessions.ts` reads both `WSL_SESSIONS_DIR_FROM_WIN` (UNC) and `WIN_SESSIONS_DIR` when running on `win32`, only the WSL dir on Linux. Each `SessionInfo` carries an `origin: "wsl" | "windows"` tag that follows it through the pipeline.
- `src/live-pids.ts` checks `wsl` PIDs via `wsl.exe -d <distro> -- kill -0 <pid>` (batched as one bash command), and `windows` PIDs via a single `tasklist.exe /NH /FO CSV` dump that we intersect ourselves. (Multiple `/FI "PID eq N"` filters AND together in tasklist — they don't OR — so per-PID filtering is impossible; one big dump is cheaper than N spawns.) Both checks run in parallel and have a 10s `CACHE_FALLBACK_MS` to absorb transient empty/errored spawns without flickering all keys to "finished".

Touching anything PID- or path-related almost always means touching both branches.

### Path / environment resolution (`src/env.ts`)

The plugin runs inside the Stream Deck app on Windows where neither `HOME` nor `WSL_DISTRO_NAME` is set. Rollup's `inject-build-env` plugin (in `rollup.config.mjs`) replaces two sentinels (`__BUILD_WSL_HOME__`, `__BUILD_WSL_DISTRO__`) at build time with whatever was live in the WSL build shell. At runtime, real env vars take precedence; the baked values are the fallback. `assertResolved` throws if a sentinel survived (e.g. running an unbuilt module). **All path/UNC math lives in `env.ts`** — don't re-derive UNC paths inline elsewhere.

### Tick loop (`src/plugin.ts`)

Two intervals share the same `state-tracker.ts` instance:

- **Slow tick (1s):** `tracker.tick()` re-reads sessions + liveness + notify/plan files, computes the sorted `DisplayEntry[]`, and `renderAll()`s every slot. Re-entrancy guarded by `slowTickRunning`.
- **Animation tick (120ms):** advances `frame`, then renders only if `tracker.needsAnimation()` is true (any animated motif OR a marquee-overflowing label). Same guard pattern.

`createStateTracker()` owns the cross-tick bookkeeping: `prevLiveIds` (so a session is promoted to `finished` only when it was alive *last tick* — stale junk files from previous CC runs never appear) and `recentlyFinished` (carry-over for `FINISHED_TTL_MS = 3000`ms after death).

State priority for an idle session: `awaiting_plan` > `awaiting` > plain `idle`. See `deriveState()` in `sessions.ts`.

### Render pipeline (`src/render-loop.ts` + `src/icons/`)

`SlotAction.orderedActions()` sorts visible action instances by Stream Deck `(row, column)` — that's what defines slot 1..N. `renderAll()` zips slots with `DisplayEntry[]`, calls `renderIcon()` to produce an SVG, base64-encodes a `data:image/svg+xml;base64,…` URL, and only calls `setImage` when the URL changed (per-slot dedup via `slotState.lastSvg`). The clipboard payload (`session.cwd`, copied on key press) is refreshed every tick regardless.

Icon code is split per concern across `src/icons/`: `theme.ts` (constants), `motifs.ts` (animated SVG fragments per state), `states.ts` (the single `STATES` registry mapping each `SessionState` to palette + motif + animated flag), `text.ts` (label splitting + marquee), `render.ts` (compose the final SVG). Adding a new state = one entry in `STATES` + plumb it through `deriveState`.

### Terminal focus on slot press (`src/terminal-focus.ts` + per-backend modules)

Pressing a slot key tries to bring the terminal hosting the session forward
(best-effort, no-op when unmatched). `src/terminal-focus.ts` dispatches by the
session's `terminal` kind — stamped at `SessionStart` by the hook from
`$TERM_PROGRAM` and reduced into `SessionInfo.terminal`:

- **warp** → `warp-focus.ts` (macOS AppleScript / Windows Warp sqlite DB +
  Win32 keystroke). See `src/warp-db.ts`, `src/warp-cwd.ts`.
- **vscode** → `vscode-focus.ts`: raise the best-matching VS Code *window*
  (title-based scoring in `vscode-window-match.ts`; Windows enumerates via
  `Get-Process Code` + raises the HWND, macOS via System Events `AXRaise`).
  Window-level only — no integrated-terminal-tab precision.
- **iterm** → placeholder (not implemented).
- **other** → bare terminal, nothing to raise.
- **unknown** → back-compat: try Warp, then VS Code.

The Win32 foreground machinery (P/Invoke bundle + `runPowerShell`) is shared by
the Warp and VS Code Windows backends in `src/win32-raise.ts`. Clipboard
fallback (the session cwd) runs regardless so the user always has something to
paste. `scripts/check-warp` and `scripts/check-vscode.ts` are CLI sanity-checks
for the two read paths.

### Reload trigger (`src/reload-watcher.ts`)

`pnpm watch` and `pnpm sd:reload` both `touch ~/.claude/.streamdeck-claude.reload`. The plugin polls the file's mtime each second; when it changes, the plugin calls `process.exit(0)` and the SD app respawns it (this is the SD app's normal crash-recovery behaviour, repurposed). `PROCESS_START_MS` guards against looping on startup if the trigger file already exists.

### Hook pipeline (`hooks/` + `scripts/install-hook.sh`)

Every registered Claude Code event runs the same hook script (`notification.sh` on WSL, `notification.ps1` on Windows). Both do exactly one thing: append a single JSON line — `{"ts":…,"event":…,"tool":…?}` — to `~/.claude/sessions/<sid>.events.ndjson`. There is no mapping table; the bash and PowerShell scripts are tiny mirrors of each other. `SessionStart` truncates the log first (clean reset, bounds long-lived sessions); `SessionEnd` unlinks it.

The plugin reads each session's event log every tick and replays it through the pure state machine in `src/session-events.ts` (`reduceEvents`). That function is the single source of truth for state transitions — adding a new state means one new case there plus registering the event in `install-hook.sh`. No `events.json`, no per-state sidecar files, no mtime/TTL/grace heuristics.

The Windows hook is **not copied** — `install-hook.sh --target=windows` registers a PowerShell command that runs `hooks/notification.ps1` directly over `\\wsl.localhost\<distro>\…\hooks\notification.ps1`, so a single repo edit propagates to both. PID liveness still handles the case where a CC process dies hard (no `SessionEnd`): the session disappears from display via `state-tracker.ts`'s `prevLiveIds` check, and the orphan event log is cleaned the next time CC reuses that sessionId (`SessionStart` truncate).

## Conventions worth knowing

- TypeScript ESM (`"type": "module"`), Node 20, `strict: true`. Source is `src/**/*.ts`, output is `com.julien.claudesessions.sdPlugin/bin/plugin.js` (single bundled file via rollup).
- Imports use the `.js` extension even for `.ts` files (NodeNext-style). Don't drop the extension.
- Two Stream Deck actions are registered: `com.julien.claudesessions.slot` (one key per live CC session, in `src/slot-action.ts`) and `com.julien.claudesessions.setup` (a single maintenance key, in `src/setup-action.ts`). Both use the `@action({ UUID: "..." })` decorator AND must be passed to `streamDeck.actions.registerAction(...)` — the decorator alone is not enough.
- The Setup action's key press (and its property inspector "Refresh States" button) calls `refreshNow()` in `plugin.ts`, which `wipeAllEventLogs()` (deletes every `<sid>.events.ndjson` across both source dirs) then runs an immediate `runSlowTick()`. The PI uses raw WebSocket against the Elgato bridge (`connectElgatoStreamDeckSocket`) — the SDK's TS API is plugin-side only.
- Background context for Stream Deck plugin development inside WSL lives in the local skill `streamdeck-plugin-wsl` (`.claude/skills/`); session-introspection internals (the `<pid>.json` schema, dual-namespace liveness, hook patterns) are in `claude-code-process-introspection`. Invoke them via the `Skill` tool when relevant.
- `docs/` holds reference notes (`architecture.md`, `development.md`, `warp-focus*.md`, `vscode-focus.md`). `docs/code-refacto.md` specifically is an audit doc, not authoritative — treat as a record of considered ideas, not a TODO list.
