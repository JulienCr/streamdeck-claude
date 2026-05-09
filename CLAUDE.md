# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Stream Deck plugin that mirrors live Claude Code CLI session state on up to N keys. The runtime is a single Node process (`com.julien.claudesessions.sdPlugin/bin/plugin.js`) launched by the Windows-side Stream Deck app. The repo lives in WSL; the SD app reads the plugin folder over a `\\wsl.localhost\<distro>\…` symlink. README.md covers setup and the user-visible behaviour — read it before changing anything in `scripts/` or `hooks/`.

## Common commands

Use **pnpm** (not npm/npx) — see global memory.

```bash
pnpm build              # rollup → com.julien.claudesessions.sdPlugin/bin/plugin.js (terser in prod, sourcemaps in watch)
pnpm watch              # rollup -w + auto-touches the reload trigger after each rebuild
pnpm sd:reload          # touch ~/.claude/.streamdeck-claude.reload → plugin self-exits → SD app respawns it (~1s)
pnpm sd:validate        # @elgato/cli validate manifest + assets (pinned to HOME=/mnt/c/Users/julie)
pnpm sd:link / sd:unlink           # (re)create the Windows-side mklink /D into Plugins/
pnpm install:hook                  # merge Notification + ExitPlanMode hooks into WSL ~/.claude/settings.json
pnpm install:hook:windows          # same for Windows %USERPROFILE%\.claude\settings.json (no copy — registers the .ps1 over UNC)
pnpm icons:render       # regenerate icons/*.svg reference assets from src/icons/
pnpm icons:static       # rasterize manifest PNGs from assets/svg/ via @resvg/resvg-js
```

There is **no test suite and no lint script**. Verify by `pnpm build && pnpm sd:validate && pnpm sd:reload`, then watch logs at `%APPDATA%\Elgato\StreamDeck\Plugins\com.julien.claudesessions.sdPlugin\logs\`.

The Elgato `streamdeck restart` / `streamdeck list` commands fail from WSL with `EIO` because they `readlink` a UNC-targeted symlink — use `pnpm sd:reload` instead. First time after building, you still need to quit + relaunch the SD app once so the new bundle picks up the reload-watcher.

## Architecture

### Dual-origin sessions (the core asymmetry)

Claude Code drops `~/.claude/sessions/<pid>.json` per running CLI session. PIDs from a WSL `claude` and a Windows-native `claude.exe` live in **different process namespaces**, so liveness must be checked separately:

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

### Reload trigger (`src/reload-watcher.ts`)

`pnpm watch` and `pnpm sd:reload` both `touch ~/.claude/.streamdeck-claude.reload`. The plugin polls the file's mtime each second; when it changes, the plugin calls `process.exit(0)` and the SD app respawns it (this is the SD app's normal crash-recovery behaviour, repurposed). `PROCESS_START_MS` guards against looping on startup if the trigger file already exists.

### Hook pipeline (`hooks/` + `scripts/install-hook.sh`)

Three Claude Code events trigger the same hook script — `Notification` (drop `<sid>.notify.json`), `PreToolUse[ExitPlanMode]` (drop `<sid>.plan.json`), `PostToolUse[ExitPlanMode]` (`rm` it). The mapping table is **`hooks/events.json`**, read by both `notification.sh` (WSL-side, Bash) and `notification.ps1` (Windows-side, PowerShell). To add a new "awaiting" state: edit `events.json` once and both sides pick it up.

The Windows hook is **not copied** — `install-hook.sh --target=windows` registers a PowerShell command that runs `hooks/notification.ps1` directly over `\\wsl.localhost\<distro>\…\hooks\notification.ps1`, so a single repo edit propagates to both. The plugin then watches `<sid>.notify.json` (TTL 60s) and `<sid>.plan.json` (TTL 30min — explicitly cleared on `PostToolUse`, TTL is a safety net).

## Conventions worth knowing

- TypeScript ESM (`"type": "module"`), Node 20, `strict: true`. Source is `src/**/*.ts`, output is `com.julien.claudesessions.sdPlugin/bin/plugin.js` (single bundled file via rollup).
- Imports use the `.js` extension even for `.ts` files (NodeNext-style). Don't drop the extension.
- `streamdeck-claude` is wired up to the Stream Deck SDK via `@action({ UUID: "..." })` + `streamDeck.actions.registerAction(slotAction)`. The decorator alone is not enough — manual registration is required.
- Background context for Stream Deck plugin development inside WSL lives in the local skill `streamdeck-plugin-wsl` (`.claude/skills/`); session-introspection internals (the `<pid>.json` schema, dual-namespace liveness, hook patterns) are in `claude-code-process-introspection`. Invoke them via the `Skill` tool when relevant.
- `docs/code-refacto.md` is an audit doc, not authoritative — treat as a record of considered ideas, not a TODO list.
