# Architecture

How the plugin discovers Claude Code sessions, derives state, and renders icons. This is reference material — for what the plugin *does*, see the top-level [`README.md`](../README.md).

## Session discovery

Claude Code drops one JSON file per running CLI session under `~/.claude/sessions/<pid>.json`. The plugin reads that directory once per second, batches a `kill -0 <pid>` check to filter out stale files, sorts the live sessions by `startedAt`, and renders an SVG per Stream Deck slot via `setImage`.

When the plugin runs on a Windows host, two session directories are scanned in parallel:

- WSL sessions, read over a `\\wsl.localhost\<distro>\…` UNC path. PIDs are checked with `wsl.exe -d <distro> -- kill -0 <pid>`, batched into a single bash invocation.
- Windows-native sessions, read at `%USERPROFILE%\.claude\sessions`. PIDs are checked with one `tasklist.exe /NH /FO CSV` dump intersected in-process. (Per-PID `/FI "PID eq N"` filters AND together in tasklist — they don't OR — so per-PID filtering is impossible; one big dump is cheaper than N spawns.)

Each `SessionInfo` carries an `origin: "wsl" | "windows"` tag so the right liveness check is applied. A 10s `CACHE_FALLBACK_MS` absorbs transient empty/errored spawns without flickering keys to "finished".

## State derivation

Every registered Claude Code hook event appends one JSON line to `~/.claude/sessions/<sessionId>.events.ndjson` — a single source of truth, no per-state sidecar files, no mtime heuristics. The plugin replays each log every tick through the pure state machine in `src/session-events.ts` (`reduceEvents`).

| Hook event | Effect on state |
|---|---|
| `SessionStart` | truncates the log + resets state |
| `SessionStart[source=compact]` | preserves state (mid-turn auto-compaction) but clears `compacting` |
| `Notification[permission_prompt]` | sets `awaitingPermission` (only in-turn) |
| `Notification[idle_prompt\|elicitation_dialog\|elicitation_url_dialog\|agent_needs_input]` / undefined | sets `awaiting` (undefined covers older logs / older CC builds) |
| `Notification[elicitation_complete\|elicitation_response]` | clears `awaiting` |
| `Notification[quota_auto_resume_fired]` | clears `throttled` (not gated on `inTurn` — fires while idle) |
| `Notification` post-Stop (`idle_prompt`) | ignored — filtered by reducer's `inTurn` guard |
| `PermissionRequest` | sets `awaitingPermission` (not gated on `inTurn` — always a real dialog) |
| `PreCompact` | sets `compacting` |
| `PostCompact` | clears `compacting` |
| `Stop` | clears `awaiting` / `awaitingPermission` / `awaitingQuestion` / `awaitingPlan` / `compacting` |
| `PreToolUse[ExitPlanMode]` | sets `awaitingPlan` |
| `PostToolUse[ExitPlanMode]` / `PostToolUseFailure[ExitPlanMode]` | clears `awaitingPlan` |
| `PreToolUse[AskUserQuestion]` | sets `awaitingQuestion` |
| `PostToolUse[AskUserQuestion]` / `PostToolUseFailure[AskUserQuestion]` | clears `awaitingQuestion` |
| `StopFailure[rate_limit\|overloaded]` | sets `throttled` (auto-retry, not a real error) |
| `StopFailure` (other/absent `error_type`) | sets `errored` |
| `UserPromptSubmit` | clears all `awaiting*` flags + `errored` + `throttled` + the subagent id set (not `bgRunning` — background work outlives turns) |
| `SubagentStart` | adds `agentId` to the active-subagent set (or bumps a legacy +1 depth counter if the line predates `agentId`) |
| `SubagentStop` | removes `agentId` from the set **only if present there** — most `SubagentStop` lines carry a unique `agentId` with no matching `SubagentStart` (CC-internal agents) and must not be treated as ending a real subagent |
| `SessionEnd` | unlinks the log |

The `notification_type` discrimination requires hooks to capture CC's `notification_type` field into the NDJSON `notifType` column — both `notification.sh` and `notification.ps1` already do this. Older logs without `notifType` fall through to plain `awaiting` (catch-all), so the regression risk is bounded.

### Event log line schema

Each NDJSON line is `{ts, event}` plus whichever of these the hook payload actually carried (all optional, omitted rather than `null`):

| Field | Source | Notes |
|---|---|---|
| `tool` | `tool_name` | PreToolUse/PostToolUse/PostToolUseFailure |
| `notifType` | `notification_type` | Notification only |
| `source` | `source` | SessionStart only |
| `errorType` | `error_type` | StopFailure only |
| `todos` | `tool_input.todos[*].status` | PostToolUse[TodoWrite] only |
| `agentId` | `agent_id` | Present when the event fired inside a subagent — logged under the **parent** session_id regardless |
| `agentType` | `agent_type` | Alongside `agentId`; empty/absent for CC-internal agents |
| `mode` | `permission_mode` | Every event carries this; the reducer only trusts it from a main-thread (no `agentId`) event |
| `bgRunning` | `background_tasks` | Stop/SubagentStop only, and only when the payload has the field at all — count of entries with `status: "running"` |

### Subagent tracking

`SubagentStart`/`SubagentStop` no longer drive a single depth counter. The reducer keeps a set of active foreground subagent ids (added on `SubagentStart{agentId}`, removed on the matching `SubagentStop{agentId}`) plus a legacy +1/-1 counter for pre-`agentId` log lines. `subagentActive` (exposed on `DerivedState`/`SessionInfo`) is true when either is non-empty/positive. This fixes a real bug: CC emits far more `SubagentStop` than `SubagentStart` (internal agents with a unique `agentId` and no start event), and the old depth-1-per-stop logic made a real running subagent's icon disappear early.

A parallel-agent-safe permission lock rides alongside this: `Notification[permission_prompt]` and `PermissionRequest` record which agent (`agentId`, or `"main"`) raised the prompt. `PreToolUse`/`PostToolUse`/`PostToolUseFailure` only clear `awaitingPermission` when their own `agentId` matches — a subagent B's tool call must not clear subagent A's padlock. `Stop`/`UserPromptSubmit` still clear it unconditionally (turn boundary). `awaitingPlan`/`awaitingQuestion` are unaffected — `ExitPlanMode`/`AskUserQuestion` from a subagent still count, since the user must answer either way.

`PreToolUse` and `PostToolUse` are registered with **empty matcher** (catch-all), so the NDJSON gets one line per tool call. The reducer dispatches by `tool_name` — only `ExitPlanMode`, `AskUserQuestion`, and `TodoWrite` produce state transitions; other tools are no-ops. The trade-off is bigger logs (~1 line per Bash/Edit/Read), but `SessionStart` truncates so it stays bounded per CC run.

The catch-all matcher is load-bearing: `awaitingPermission` is cleared by *any* `PreToolUse`/`PostToolUse` mid-turn (`session-events.ts`), so a permission padlock only clears once a normal tool runs after approval. If a stale `settings.json` registers these tool-specific (the pre-`9dc606c` `ExitPlanMode`/`TodoWrite` matchers) instead, `PostToolUse[Bash]` never fires and the padlock stays stuck until the turn ends. `src/hook-check.ts` guards against exactly this: it verifies the catch-all registration at startup (and on Setup-key appear) and surfaces a warning rather than letting the plugin degrade silently.

To add a new state: register the event in `scripts/install-hook.sh`, add a case in `src/session-events.ts`, and an entry in the `STATES` registry at `src/icons/states.ts`. State priority (see `deriveState()` in `src/sessions.ts`): `finished` > `error` > `throttled` > `awaiting_plan` > `awaiting_permission` > `awaiting_question` > `awaiting` > `compacting` > `subagent` > `working` > `idle`. All `awaiting*` flags win over `busy` because CC keeps the session marked busy while waiting on the user.

## Path / environment resolution

The plugin runs inside the Stream Deck app on Windows where neither `HOME` nor `WSL_DISTRO_NAME` is set. Rollup's `inject-build-env` plugin (in `rollup.config.mjs`) replaces two sentinels — `__BUILD_WSL_HOME__` and `__BUILD_WSL_DISTRO__` — at build time with whatever was live in the WSL build shell. At runtime, real env vars take precedence; the baked values are the fallback. `assertResolved` in `src/env.ts` throws if a sentinel survived (e.g. running an unbuilt module).

**All UNC and path math lives in `src/env.ts` — don't re-derive UNC paths inline elsewhere.**

| Env var | Used for | Override knob |
|---|---|---|
| `WSL_DISTRO_NAME` | UNC distro segment + `wsl.exe -d <distro>` | Set in the WSL build shell before `pnpm build` |
| `HOME` | WSL session dir, baked into UNC path | Set in the WSL build shell before `pnpm build` |
| `USERPROFILE` | Windows session dir + reload trigger | Provided by Windows; no override |

## Tick loop

`src/plugin.ts` runs two intervals against the same `state-tracker.ts` instance:

- **Slow tick (1s):** `tracker.tick()` re-reads sessions + liveness + event logs, computes the sorted `DisplayEntry[]`, and `renderAll()`s every slot. Re-entrancy guarded by `slowTickRunning`.
- **Animation tick (120ms):** advances `frame`, then renders only if `tracker.needsAnimation()` is true (any animated motif OR a marquee-overflowing label). Same guard pattern.

`createStateTracker()` owns the cross-tick bookkeeping: `prevLiveIds` (so a session is promoted to `finished` only when it was alive *last tick* — stale junk files from previous CC runs never appear) and `recentlyFinished` (carry-over for `FINISHED_TTL_MS = 3000`ms after death).

## Render pipeline

`SlotAction.orderedActions()` sorts visible action instances by Stream Deck `(row, column)` — that's what defines slot 1..N. `renderAll()` zips slots with `DisplayEntry[]`, calls `renderIcon()` to produce an SVG, base64-encodes a `data:image/svg+xml;base64,…` URL, and only calls `setImage` when the URL changed (per-slot dedup via `slotState.lastSvg`).

Icon code is split per concern across `src/icons/`:
- `theme.ts` — palette / dimension constants
- `motifs.ts` — animated SVG fragments per state
- `states.ts` — the single `STATES` registry mapping each `SessionState` to palette + motif + animation flag
- `text.ts` — label splitting + marquee
- `render.ts` — composes the final SVG, including two overlay badges drawn on interactive-session states only (never on `bg_*`, which don't carry these fields): a left-edge `+N` (motif height) for `bgRunning > 0`, and a top-left glyph for `permissionMode` (`bypassPermissions`/`plan` only — other modes render nothing)

## Reload trigger

`pnpm watch` and `pnpm sd:reload` both `touch ~/.claude/.streamdeck-claude.reload`. The plugin polls the file's mtime each second; when it changes, the plugin calls `process.exit(0)` and the Stream Deck app respawns it (this is the SD app's normal crash-recovery behaviour, repurposed). `PROCESS_START_MS` guards against looping on startup if the trigger file already exists.

The Elgato `streamdeck restart` / `streamdeck list` commands fail from WSL with `EIO` because they `readlink` a UNC-targeted symlink — use `pnpm sd:reload` instead. The first time after building you still need to quit + relaunch the SD app once, since the *currently-running* bundle doesn't yet know how to self-reload.

## Hook pipeline

Two thin hook scripts mirror each other:

- `hooks/notification.sh` — Bash, called by Claude Code on Linux/macOS/WSL.
- `hooks/notification.ps1` — PowerShell, called by Claude Code on Windows.

Both do exactly one thing: read the hook payload from stdin, extract `session_id` + `hook_event_name` (+ the optional fields in [Event log line schema](#event-log-line-schema) above), and append a single compact JSON line to `<sessionId>.events.ndjson` next to that side's session JSON files. `SessionStart` truncates the log first; `SessionEnd` unlinks it.

The Windows hook is **not copied** — `scripts/install-hook.sh --target=windows` registers a PowerShell command that runs `hooks/notification.ps1` directly over `\\wsl.localhost\<distro>\…\hooks\notification.ps1`, so a single repo edit propagates to both sides. PID liveness handles the case where a CC process dies hard (no `SessionEnd`): the session disappears from display via `state-tracker.ts`'s `prevLiveIds` check, and the orphan event log is cleaned the next time CC reuses that sessionId (`SessionStart` truncate).

## Project layout

```
.
├── com.julien.claudesessions.sdPlugin/   # canonical Elgato plugin folder
│   ├── manifest.json
│   ├── bin/plugin.js                     # built bundle
│   ├── imgs/                             # static manifest icons
│   ├── ui/                               # property inspector HTML
│   └── assets/clawd/                     # AGPL-3.0 mascot SVGs (see NOTICE.md)
├── src/
│   ├── plugin.ts                         # entry, polling loop
│   ├── slot-action.ts                    # per-slot SingletonAction
│   ├── setup-action.ts                   # maintenance key (wipe logs + refresh)
│   ├── sessions.ts                       # reads ~/.claude/sessions/
│   ├── live-pids.ts                      # batched kill -0 / tasklist liveness
│   ├── session-events.ts                 # pure state machine
│   ├── state-tracker.ts                  # cross-tick bookkeeping
│   ├── render-loop.ts                    # zip slots → setImage
│   ├── env.ts                            # all path/UNC math (single source)
│   ├── reload-watcher.ts                 # mtime-driven self-restart
│   ├── warp-focus.ts                     # platform dispatcher
│   ├── warp-focus-mac.ts                 # osascript activate + Cmd+digit / cycle
│   ├── warp-focus-win.ts                 # PowerShell + AttachThreadInput + SendInput
│   ├── warp-db.ts                        # read-only sqlite3 → (window, tab_index)
│   ├── warp-cwd.ts                       # Windows UNC / drive normalizer for WSL paths
│   └── icons/                            # render pipeline (theme/motifs/states/text/render)
├── icons/                                # standalone reference SVGs (one per state)
├── hooks/
│   ├── notification.sh                   # Bash hook (Linux/macOS/WSL)
│   └── notification.ps1                  # PowerShell hook (Windows)
└── scripts/
    ├── install-hook.sh                   # merge hook into ~/.claude/settings.json
    ├── link-plugin.sh                    # Windows symlink (mklink /D over UNC target)
    ├── unlink-plugin.sh                  # remove the symlink
    ├── reload-plugin.sh                  # touch the reload trigger
    ├── render-icons.mjs                  # regenerate icons/*.svg from src/icons/
    └── render-static-pngs.mjs            # rasterize manifest PNGs from assets/svg/
```
