# Warp pane focus via session ID (Windows + WSL)

**Available since:** warpdotdev/Warp PR (TBD — feature/issue-8611-session-id, awaiting upstream merge). OSS channel scheme is `warposs://`, Stable is `warp://`.

Every Warp pane exports `WARP_SESSION_ID` (UUID, hyphenated) into its shell. WSL inherits it via `WSLENV`. Reading the env var from inside a process tells you which pane hosts it.

To focus a pane from anywhere:
- Stable build: `Start-Process "warp://session/<uuid>"`
- OSS/dev build: `& warp-oss.exe "warposs://session/<uuid>"` (the registry handler points at Stable, so passing the URL as argv to the right binary is required)

The parser accepts both the hyphenated form (`550e8400-e29b-41d4-a716-446655440000`) and the 32-char unhyphenated form. Triggering a deep link brings Warp to the foreground, switches to the right window, tab, and pane.

Read another process's `WARP_SESSION_ID` from outside without running anything in its shell: open the target PID and read its PEB → `ProcessParameters.Environment` (Windows). Useful for verifying the env var is set without touching the running session.

## Supersedes

`warp-focus-research.md` (2026-05-09) concluded "Pane-level focus depuis le plugin = pas faisable". That verdict was correct against the binaries shipped at the time and is now obsolete once the linked PR is merged. The "best-effort window-summon" fallback (title-match / single-window / Z-order) is no longer needed.
