# Development

There is no test suite and no lint script. Verify a change by running `pnpm build && pnpm sd:validate && pnpm sd:reload`, then watch the logs.

## pnpm scripts

| Script | What it does |
|---|---|
| `pnpm build` | Rollup → `com.julien.claudesessions.sdPlugin/bin/plugin.js` (terser in prod, sourcemaps in watch) |
| `pnpm watch` | `rollup -w`; auto-touches the reload trigger after each rebuild |
| `pnpm sd:reload` | Touch `~/.claude/.streamdeck-claude.reload` → plugin self-exits → SD app respawns it (~1 s) |
| `pnpm sd:link` / `pnpm sd:unlink` | (Re)create / remove the Windows-side `mklink /D` into the SD `Plugins/` folder |
| `pnpm sd:validate` | `streamdeck validate` against the manifest + assets |
| `pnpm sd:pack` | Bundle `dist/com.julien.claudesessions.streamDeckPlugin` for distribution |
| `pnpm sd:dev` | Enable Stream Deck developer mode (one-time) |
| `pnpm install:hook` | Idempotently merge the Notification + ExitPlanMode hooks into WSL/macOS `~/.claude/settings.json` |
| `pnpm install:hook:windows` | Same for Windows `%USERPROFILE%\.claude\settings.json` (registers the `.ps1` over the WSL UNC path; no copy) |
| `pnpm icons:render` | Regenerate `icons/*.svg` reference assets from `src/icons/` |
| `pnpm icons:static` | Rasterize manifest PNGs from `assets/svg/` via `@resvg/resvg-js` |
| `pnpm check:hooks` | Diff installed hooks against `scripts/install-hook.sh` to confirm the registration is current |

Logs land at `%APPDATA%\Elgato\StreamDeck\Plugins\com.julien.claudesessions.sdPlugin\logs\` (Windows) or `~/Library/Logs/ElgatoStreamDeck/com.julien.claudesessions.sdPlugin/` (macOS).

## Reload flow

The plugin watches `~/.claude/.streamdeck-claude.reload` once per second. On mtime change it calls `process.exit(0)` and the Stream Deck app respawns it — the SD app's normal crash-recovery behaviour, repurposed.

`pnpm sd:reload` just touches that file. `pnpm watch` triggers it automatically on each rebuild.

The first time after building, you still need to quit + relaunch the SD app once (the *currently-running* bundle doesn't yet know how to self-reload). After that, `pnpm sd:reload` is enough.

The Elgato `streamdeck restart` / `streamdeck list` commands don't work from WSL when the plugin is symlinked over `\\wsl.localhost\…` — they `readlink` the symlink and the WSL filesystem driver returns `EIO`. Use `pnpm sd:reload` instead.

## End-to-end verification checklist

1. `pnpm build` produces `com.julien.claudesessions.sdPlugin/bin/plugin.js`.
2. `pnpm sd:validate` reports "Validation successful".
3. `pnpm install:hook` — `jq '.hooks.Notification' ~/.claude/settings.json` shows the new hook.
4. `pnpm sd:link` — output contains "✓ symlink resolves through Windows" (Windows-side only).
5. Quit + relaunch the Stream Deck app. Drag **Claude Session Slot** onto whatever keys you want to dedicate to live sessions.
6. In a terminal, run `claude` somewhere. Slot 1 fills with the project name in amber while it works, blue while idle.
7. Trigger a permission prompt → slot flips to orange within ~1 s.
8. Open `claude` in another `cwd` → slot 2 lights up.
9. Exit one session → it shows green "finished" briefly, then empties.
10. Press a key → paste in any app: confirm the project path appears in the clipboard.

## Tweaks

- **Different WSL distro:** set `WSL_DISTRO_NAME` before `pnpm build`. Auto-detected by `link-plugin.sh` and `install-hook.sh`; baked into the bundle so the SD-launched plugin (which doesn't see WSL env vars) still resolves the right UNC path.
- **Different Windows username / home path:** `USERPROFILE` is set by Windows and used directly. For a different WSL home, just `pnpm build` from that home — `HOME` at build time is captured by Rollup and baked into the bundle. All path resolution lives in `src/env.ts`.
- **Different icon designs:** edit `src/icons/`, then `pnpm icons:render` to refresh the reference SVGs in `icons/`. For the manifest PNGs, edit `assets/svg/` then `pnpm icons:static`.
