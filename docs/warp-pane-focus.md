# Warp pane focus via session deep link

Reference for the Warp surface the plugin relies on. Verified 2026-10-02 on macOS, Warp Stable 0.2026.09.30.08.29.01. Source refs (Warp repo): `crates/warp_terminal/src/focus_env.rs`, `app/src/uri/mod.rs` (`UriHost::Session`, `decode_uuid_hex`), `crates/warp_terminal/src/local_tty/windows/environment.rs` (`wsl_env_allowlist`).

## Env vars injected into every pane's shell

| Variable | Value |
|---|---|
| `WARP_TERMINAL_SESSION_UUID` | 32 lowercase hex chars, no hyphens. Equals `terminal_panes.uuid` in Warp's SQLite DB. |
| `WARP_FOCUS_URL` | `<scheme>://session/<uuid>` |

Both are forwarded into WSL through `WSLENV`.

## URL format

- Scheme per channel: `warp` (Stable), `warppreview`, `warpdev`, `warplocal`, `warposs`.
- `decode_uuid_hex` requires exactly 32 hex chars. The hyphenated UUID form is **not** accepted (an earlier version of this doc said it was; that was wrong).
- Opening the URL (`open "$WARP_FOCUS_URL"` on macOS, `Start-Process` on Windows) finds the pane across all windows, shows the window, switches tab and focuses the pane. On macOS it exits 0 in about 200 ms; `~/Library/Logs/warp.log` shows `received url` then `dispatching action for "root_view:handle_pane_navigation_event"`.

## Reading another process's env (macOS)

For same-user processes, `ps eww -o command= -p <pid>` prints the command followed by its environment, so `WARP_FOCUS_URL` can be checked without touching the target shell. On Windows the equivalent is reading the target's PEB `ProcessParameters.Environment`.

## Caveat: SQLite persistence is lazy

Warp snapshots its SQLite DB lazily. After a deep-link tab switch, `windows.active_tab_index` was unchanged 2 s later. Anything that reads the DB (the cwd fallback in [`warp-focus.md`](./warp-focus.md)) can see stale tab state.

## Watch item: warpctrl

`warpctrl` / `crates/local_control` in the Warp source is a local control API with window/tab/pane/session selectors. It is gated behind `FeatureFlag::WarpControlCli`, enabled only in `DOGFOOD_FLAGS`, so it is not available in Stable as of 2026-10-02.

## How the plugin uses it

See [`warp-focus.md`](./warp-focus.md): hooks record `WARP_FOCUS_URL` on every event, `reduceEvents` latches it, and the key press opens it, falling back to the cwd heuristic when it is missing or fails.

## Supersedes

`warp-focus-research.md` (2026-05-09) concluded that pane-level focus from the plugin was not feasible. That was correct for the binaries of the time and is obsolete now.
