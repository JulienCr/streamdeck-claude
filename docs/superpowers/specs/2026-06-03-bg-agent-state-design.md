# Background-agent state — design

Date: 2026-06-03
Status: approved (pending spec review)

## Problem

A Stream Deck slot showed an "agent" (`mosaic-sr-fallback-404`) that no longer
exists. Investigation traced it to a new Claude Code 2.1.x session kind.

### Root cause

Claude Code 2.1.x introduced **background agents / jobs**. A bg job writes
`~/.claude/sessions/<pid>.json` exactly like an interactive session, but with
extra fields:

```json
{"pid":26658,"kind":"bg","entrypoint":"cli","name":"mosaic-sr-fallback-404",
 "jobId":"b4e040a6","status":"waiting","waitingFor":"permission prompt",
 "updatedAt":1779875704195, ...}
```

vs. an interactive session:

```json
{"pid":89686,"kind":"interactive","status":"busy","updatedAt":1780479715678, ...}
```

The plugin breaks on three points:

1. `readOneSource()` (`src/sessions.ts`) never inspects `kind` — it ingests
   every valid `<pid>.json`.
2. The slot label comes from `name` (`label: raw.name?.trim() || basename(cwd)`),
   so the job's `name` shows verbatim.
3. Liveness passes for the wrong reason: the bg job's host process is a
   **shared, recycled `--bg-spare` daemon**. `kill -0 <pid>` keeps succeeding
   for days even though the job is long gone, so the slot never expires.

Corroborating: the ghost's `updatedAt` was frozen ~7 days (job stuck on a
`waitingFor:"permission prompt"` nobody answered, daemon recycled to a spare),
while a live interactive session refreshes `updatedAt` within seconds.

**The plugin's core assumption — "one `<pid>.json` = one live interactive CLI
session, liveness = PID alive" — no longer holds for `kind:"bg"`.**

## Goal

Surface background agents as **first-class, visually distinct** slots, with a
liveness model that doesn't rely on the (shared/recycled) daemon PID, so a
finished or abandoned bg job disappears like any dead session.

## Non-goals

- Killing / cancelling bg jobs (no job-cancel API is exposed; see §5).
- Feeding bg state from the event-log hook pipeline (bg agents run headless and
  do not feed it; their json is the source of truth).
- Reworking interactive-session behaviour in any way.

## Decisions (from brainstorming)

- **Show bg agents as a distinct state** (not hide them, not a single generic
  badge): a dedicated set of `bg_*` states.
- **Liveness = hybrid**: a bg session is alive iff `updatedAt` is fresh AND its
  status is non-terminal. Stale OR terminal → gone.
- **Motifs (accepted default): reuse the semantically-matching existing motifs**
  per bg state (DRY); a dedicated palette family + a persistent "bg" badge carry
  the distinction. Bespoke per-state motifs were the costlier alternative and
  were not chosen.
- **`FRESH_MS = 90_000`** (accepted default; tunable constant).

## Design

### 1. Detection & data (`src/sessions.ts`)

- `RawSession` gains optional `kind`, `jobId`, `waitingFor`, `updatedAt`.
- `SessionInfo` gains:
  - `kind: "interactive" | "bg"` — **defaults to `interactive` when the field is
    absent** (back-compat: a session without `kind` is never treated as bg).
  - `bgStatus?: string`, `bgWaitingFor?: string`, `updatedAt?: number` — populated
    only for bg sessions.
- For `kind === "bg"`, **skip the event-log read/reduce** entirely; the json
  carries the state.
- Label unchanged: `name || basename(cwd)`.

### 2. Liveness — hybrid model (`src/live-pids.ts`)

`filterLiveSessions` partitions sessions **before** the PID checks:

- **bg** → resolved locally, no spawn:
  `alive = updatedAt != null && (now - updatedAt) < FRESH_MS && !TERMINAL.has(bgStatus)`
- **interactive** → existing PID checks (wsl `kill -0`, windows `tasklist`),
  unchanged.

Constants (co-located with the bg branch):
- `FRESH_MS = 90_000`
- `TERMINAL = new Set(["completed","failed","cancelled","done"])` — **best-effort,
  to be confirmed (see §6).**

The daemon PID never participates in bg liveness.

**Why this fixes the original bug with no new machinery:** the existing
`state-tracker.ts` only promotes a session to `finished` if it was in
`prevLiveIds` last tick. The `mosaic` ghost is *already* stale at startup → never
enters `prevLiveIds` → never promoted → simply not displayed. A bg session that
goes stale mid-run was alive last tick → promoted to `finished` (3 s TTL) →
disappears, identical to a dead interactive session.

### 3. State derivation (`deriveState`, `src/sessions.ts`)

A `kind === "bg"` branch maps the json to `bg_*` states via one central table:

| bg json | state |
|---|---|
| `waitingFor` contains "permission" | `bg_awaiting_permission` |
| `status === "waiting"` (other/no waitingFor) | `bg_awaiting` |
| `status === "busy"` or `"running"` | `bg_working` |
| other non-terminal / unknown | `bg_idle` (catch-all) |

Terminal statuses never reach here (filtered upstream by liveness → `finished` /
removed). Interactive derivation is untouched.

### 4. Visual — dedicated `bg_*` states (`src/icons/states.ts`, `src/icons/render.ts`)

Four new `STATES` entries: `bg_working`, `bg_awaiting_permission`, `bg_awaiting`,
`bg_idle`.

- **Dedicated palette family** (cool indigo/violet base, e.g.
  `bg:#10131a accent:#8b9cff label:#c7d2fe`) — instantly reads as "background",
  distinct from the amber/orange/cyan interactive families.
- **Motifs reused semantically**: `bg_awaiting_permission`→`permissionPulse`,
  `bg_awaiting`→`awaitingPulse`, `bg_working`→`spinnerArc`, `bg_idle`→
  `clawdIdleLook`. No new motif functions. (`emptyDashed` stays reserved for the
  empty-slot state.)
- **Persistent "bg" corner badge**: a small "bg" text glyph in the **top-left**
  corner (mirroring the top-right slot-number badge so they never collide),
  reusing the `renderSlotBadge` text/style pattern. Makes background-ness
  unmistakable even on pulsing states.
- `pulseBg: true` for `bg_awaiting_permission` and `bg_awaiting` (a bg agent
  waiting on you should flash to catch the eye); `false` for `bg_working` /
  `bg_idle`.

`SessionState` auto-extends from the `STATES` keys, so `deriveState`,
`render-loop`, and `iconNeedsAnimation` pick up the new states for free.

### 5. Slot press & kill safety (`src/slot-action.ts`, `src/render-loop.ts`)

**Critical given the `feat/aggressive-kill` branch:** the 3 s hold arms
`killTimer` → `killSlot(pid, …)`, which kills **by PID**. For a bg slot that PID
is the shared `--bg-spare` daemon; killing it would take down the daemon and any
other jobs it hosts. There is no exposed job-cancel API.

Therefore, for bg slots:
- `SlotState` gains `killable?: boolean`, set by the render-loop to
  `entry.session.kind !== "bg"` when it binds slot state each tick.
- `onKeyDown` **does not arm `killTimer`** when `killable === false` → no KILL
  ring, palier 2 is a no-op.
- Short press (copy cwd + Warp focus) still runs — Warp focus no-ops gracefully
  for a headless agent with no terminal tab.
- Palier 1 (≥500 ms event-log wipe) still runs — harmless for bg (no log).

### 6. Unknowns & defensive defaults

Only **one** bg sample is available (`status:"waiting"` /
`waitingFor:"permission prompt"`). Consequences:

- `TERMINAL` and the §3 mapping are best-effort, centralised in one place, with a
  `bg_idle` catch-all for any unknown non-terminal value → never crash, never a
  weird blank slot.
- To be confirmed by observing more bg jobs (or CC docs/source): the full
  `status`/`waitingFor` vocabulary, and whether the daemon refreshes `updatedAt`
  while a job runs quietly (drives the `FRESH_MS` value).

## File-by-file change list

- `src/sessions.ts` — `RawSession` + `SessionInfo` fields; bg branch in
  `readOneSource` (skip event-log); bg branch in `deriveState` + mapping table.
- `src/live-pids.ts` — partition bg vs interactive; bg liveness via
  freshness + terminal-status; `FRESH_MS` / `TERMINAL` constants.
- `src/icons/states.ts` — four `bg_*` `STATES` entries (palette family + reused
  motifs).
- `src/icons/render.ts` — persistent "bg" badge for bg states.
- `src/slot-action.ts` — `SlotState.killable`; gate `killTimer` arming.
- `src/render-loop.ts` — set `killable` when binding slot state.

## Risks

- **Status vocabulary guess** (mitigated by central table + catch-all).
- **`FRESH_MS` too tight** could hide a quiet-but-running bg job (mitigated by a
  generous 90 s default; tunable). Too large delays disappearance of a finished
  job by at most `FRESH_MS`.
- **Badge collision** with the slot-number badge (mitigated by explicit
  positioning; verify visually).

## Verification

No test suite exists. Per project convention:
`pnpm build && pnpm sd:validate && pnpm sd:reload`, then confirm on the deck /
logs:
1. The stale `mosaic` ghost no longer appears.
2. A fresh bg job appears with the bg palette + badge and the correct `bg_*`
   state derived from its `status`/`waitingFor`.
3. Holding a bg slot 3 s does **not** show the KILL ring and does not kill the
   daemon.
4. Interactive sessions are visually and behaviourally unchanged.
