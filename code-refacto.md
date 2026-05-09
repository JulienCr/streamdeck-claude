# Code refactoring audit — `streamdeck-claude`

Scope: `src/`, `scripts/`, `hooks/`, plus glue (`package.json`, `rollup.config.mjs`, `manifest.json`).
Total today: ~1300 LOC (840 TS, 113 Python, 250 shell, 60 PowerShell, ~125 HTML/JS).

The codebase is **small and works**. Nothing here suggests a rewrite. The refactor target is to make the **add-a-state / change-a-theme / wire-another-hook** loop a one-file edit instead of a six-file edit, and to drop the one ecosystem we don't need (Python). Everything below is sized to one or two PRs.

---

## 1. The Python question — drop it

`scripts/render-static-pngs.py` (113 LOC) is the only Python in the repo. It runs **once at packaging time** to draw four static PNG assets the SD validator demands as bitmap (it rejects SVG for `Icon` / `CategoryIcon`, see `streamdeck-plugin-wsl` skill).

| Concern | Today | After |
|---|---|---|
| Languages on the build path | TS + Bash + PowerShell + Python + Pillow | TS + Bash + PowerShell |
| Asset source of truth | hand-coded with `PIL.ImageDraw` (separate from `src/icons.ts`) | derived from the same SVG primitives the runtime uses |
| First-run install | `apt install python3-pil` (or pip + system fonts) | `pnpm install` already done |

**Recommendation:** replace with a ~40-line `scripts/render-static-pngs.mjs` that calls `@resvg/resvg-js` (or `sharp`) to rasterize a small set of SVG templates. Two things to keep distinct:

- The **runtime** key icons (already SVG, drawn live by `setImage(dataUrl)`) — no change.
- The **manifest assets** (marketplace 144/288, category-icon 28/56, action-picker 40/80, default key 144/288) — generate by:
  1. either authoring 4 small SVG sources in `assets/` (preferred — diff-friendly), or
  2. composing them from `src/icons.ts` primitives if/when palette/motifs land in their own module (point 5 below).

Net win: one less language, one less venv, identical output, the asset PNGs become re-derivable from the same theme that drives the runtime.

**Not worth doing alone — bundle with point 5** so the SVG primitives are in a shape the build script can `import` cleanly.

---

## 2. State machine: 6 edit-points → 1

Adding `awaiting_plan` to the existing 5 states would have required touching, today:

1. `src/icons.ts:1` — add to `SessionState` union
2. `src/icons.ts:3` — add palette row
3. `src/icons.ts:140` — add `motif()` case
4. `src/icons.ts:231` — add to `iconNeedsAnimation` if animated
5. `src/icons.ts:241` — add to `isAnimated` if animated
6. `src/sessions.ts:140` — slot into `deriveState` priority order
7. (sometimes) `hooks/notification.{sh,ps1}` — drop the trigger file
8. (sometimes) `src/sessions.ts:96-112` — read the new trigger file

That's 6–8 edits to add **one** state, with no compiler help if you forget #4 or #5 (the icon just stops animating silently).

**Recommendation:** consolidate states into a single registry in `src/states.ts`:

```ts
export type SessionState = keyof typeof STATES;

export const STATES = {
  working:       { palette: { ... }, animated: true,  motif: spinnerArc },
  idle:          { palette: { ... }, animated: false, motif: idleArrow },
  awaiting:      { palette: { ... }, animated: true,  motif: awaitingPulse },
  awaiting_plan: { palette: { ... }, animated: true,  motif: planPulse },
  finished:      { palette: { ... }, animated: false, motif: finishedCheck },
  empty:         { palette: { ... }, animated: false, motif: emptyDashed },
} satisfies Record<string, { palette: Palette; animated: boolean; motif: MotifFn }>;
```

Then `motif()`, `isAnimated()`, `PALETTE`, and the `SessionState` union are all derived from one object — adding a state becomes **one row**.

`deriveState` (`src/sessions.ts:140`) stays as-is for now — the priority logic (`plan > permission > busy > idle > finished`) is genuinely conditional on cross-cutting flags (`alive`, `awaitingPlan`, `awaiting`) that aren't per-state. Don't try to fold those into `STATES` — that's exactly the kind of premature framework that hurts later.

---

## 3. `icons.ts` is approaching a god-file (242 lines, 6 concerns)

Today it owns: palette, layout constants, label splitter, marquee text renderer, 5 motif functions, the SVG composer, and two animation predicates. Manageable now, painful at +2 states or a second theme.

**Recommendation — split when point 2 lands:**

```
src/icons/
├── theme.ts          # PALETTE, BORDER_*, layout constants. Future: theme switching.
├── text.ts           # splitLabel + textLine (marquee). No SVG-state coupling.
├── motifs.ts         # spinnerArc, awaitingPulse, planPulse, idleArrow, finishedCheck, emptyDashed
├── states.ts         # The STATES registry from point 2. Imports motifs + theme.
├── render.ts         # renderIcon, iconNeedsAnimation, isAnimated. Reads from states.
└── index.ts          # re-exports the public surface
```

This is **not** about file count — it's about each concept living somewhere a future contributor can find with one ⌘P. The split also unlocks point 1 (the static PNG generator can `import { motifs, theme }` directly).

**Don't** introduce a "theme engine" abstraction — `theme.ts` is just a palette object today. Add multi-theme support **only when a second theme is actually requested**. (Kaizen: rule of three.)

---

## 4. `plugin.ts` mixes 4 concerns into one file

`src/plugin.ts` (195 lines) does:

- **Reload trigger** (`RELOAD_FILE`, `checkReload`, lines 25–55) — file-mtime watcher
- **Tick orchestration** (`tick`, lines 89–127) — read sessions, filter live, manage `recentlyFinished` carry-over
- **Render** (`render`, lines 129–158) — SVG → data URL → `setImage`, with dedup cache
- **Loop scheduling** (lines 161–193) — two `setInterval`s with re-entrance guards

Each is reasonable on its own; together it's the longest TS file once you exclude `icons.ts`. Worse, the carry-over state (`recentlyFinished`, `prevLiveIds`, `cachedEntries`, `frame`) is module-level mutable — hard to test in isolation.

**Recommendation:**

```
src/plugin.ts          # connect, register action, schedule the two intervals — that's it
src/reload-watcher.ts  # checkReload + RELOAD_FILE + PROCESS_START_MS
src/state-tracker.ts   # tick() logic: classes/closure that owns recentlyFinished/prevLiveIds, returns DisplayEntry[]
src/render-loop.ts     # render() + per-slot dedup cache + frame counter
```

Each module exposes one function. `plugin.ts` becomes ~40 lines of wiring. Each new module is independently testable (StateTracker in particular — it's pure given inputs).

---

## 5. Hook scripts: real duplication across `.sh` / `.ps1`

`hooks/notification.sh` (48 lines) and `hooks/notification.ps1` (63 lines) are **isomorphic**:

- Read JSON from stdin
- Extract `session_id`, `hook_event_name`, `tool_name`
- Dispatch on event:
  - `Notification` → write `<sid>.notify.json`
  - `PreToolUse` + `tool_name=ExitPlanMode` → write `<sid>.plan.json`
  - `PostToolUse` + `tool_name=ExitPlanMode` → delete `<sid>.plan.json`

Adding a 4th event = edit both files. Two stdin-encoding traps (UTF-8 PowerShell trick, `cp -i` alias) live in two places. Divergence risk is real.

**Three options, ranked:**

### 5a. Keep two scripts, extract the routing table _(low effort, modest win)_

Move the event→action mapping to a shared `hooks/events.json`, both scripts read it. Bash via `jq`, PowerShell via `ConvertFrom-Json`. Adding an event = edit one file (the JSON). The dispatch logic stays duplicated but it's only ~5 lines each.

### 5b. Single Node hook _(medium effort, big win)_

Claude Code itself ships Node 20+ in its install — `hooks/bridge.mjs` could replace both. ~30 lines:

```js
#!/usr/bin/env node
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const payload = JSON.parse(await readStdin());
const { session_id, hook_event_name, tool_name } = payload;
const dir = join(homedir(), ".claude", "sessions");
await mkdir(dir, { recursive: true });
const path = (name) => join(dir, `${session_id}.${name}.json`);

const drop = (name, reason) => writeFile(path(name),
  JSON.stringify({ sessionId: session_id, reason, mtime: Date.now() }));

if (!session_id) { console.log("{}"); process.exit(0); }
if (hook_event_name === "Notification") await drop("notify", "awaiting");
if (hook_event_name === "PreToolUse"  && tool_name === "ExitPlanMode") await drop("plan", "plan");
if (hook_event_name === "PostToolUse" && tool_name === "ExitPlanMode") await unlink(path("plan")).catch(() => {});
console.log("{}");
```

Eliminates the PowerShell stdin-encoding trap, the `cp -i` alias trap, and 60% of the install scripts. Trade-off: requires Node on PATH at hook fire time. CC ships it, but a power-user could remove it; the user's `.claude/settings.json` then lists a broken command. Acceptable if installer verifies `node --version` first.

### 5c. Status quo + lint _(YAGNI-respecting)_

Two scripts, but a tiny test harness that pipes 3 canned JSON payloads into each and asserts the right files appear. Catches divergence early without a rewrite.

**My pick:** **5a now, 5b when a 4th event lands.** 5b is appealing but introduces a runtime dependency (Node) that today's bash bridge doesn't need.

---

## 6. Install scripts: same jq filter, twice

`scripts/install-hook.sh` (50 lines) and `scripts/install-hook-windows.sh` (67 lines) share the same `JQ_FILTER` and `merge()` function — verbatim. The Windows variant only adds a file copy on top.

**Recommendation:** one `scripts/install-hook.sh`, with `--target=wsl|windows`. The shared filter lives in one place; the Windows path adds the `cp` step and computes the ps1 command. Reduces ~40 lines and means a future hook event change is one diff.

(Or merge into the Node bridge if 5b lands — then there's only one settings-merge logic.)

---

## 7. Hardcoded user/distro/path values

Found in 7 places:

| File:line | Hardcoded | Source of truth |
|---|---|---|
| `src/sessions.ts:20` | `Ubuntu`, `julien` (UNC) | `process.env.WSL_DISTRO_NAME`, `os.userInfo().username` |
| `src/sessions.ts:21` | `julie` (Win user) | `process.env.USERPROFILE` (already absolute) |
| `src/plugin.ts:26-27` | same as above | same |
| `src/live-pids.ts:47` | `Ubuntu` | `process.env.WSL_DISTRO_NAME` |
| `package.json:16-18` | `julie` | env var / cross-env config |
| `scripts/install-hook-windows.sh:16` | already env-overridable ✓ | — |
| `scripts/link-plugin.sh:19-20` | already env-overridable ✓ | — |

**Recommendation:** add `src/env.ts` that resolves these once at startup:

```ts
export const WIN_HOME   = process.env.USERPROFILE ?? "C:\\Users\\julie";
export const WSL_DISTRO = process.env.WSL_DISTRO_NAME ?? "Ubuntu";
export const WSL_HOME   = process.env.HOME ?? `/home/${userInfo().username}`;
export const SESSIONS_DIR_WSL_FROM_WIN =
  `\\\\wsl.localhost\\${WSL_DISTRO}${WSL_HOME.replace(/\//g, "\\")}\\.claude\\sessions`;
export const SESSIONS_DIR_WIN = join(WIN_HOME, ".claude", "sessions");
```

`sessions.ts`, `plugin.ts`, `live-pids.ts` import from `env.ts`. Failing-to-find a path now logs the **resolved** path, not a string with someone else's username. Also makes the plugin checkable-out by other people without an edit.

For the `package.json` scripts: they only need `HOME=…AppData/Roaming/Elgato/StreamDeck` (the @elgato/cli looks there). Detect once via a tiny `scripts/find-win-home.mjs` and write it into a `.env.local` that `cross-env` reads. Or just document the env var.

---

## 8. Smaller findings (one-line fixes / tracking)

- **`src/live-pids.ts:122`** — `slot.lastLive = live` for the windows origin stores _every_ live PID on the system (potentially hundreds). Cache is replaced each tick, so not a leak, but `parseAndCache` should accept a `restrict` set and store the intersection only. ~3 lines.
- **`src/slot-action.ts:99`** — `clip.exe` expects UTF-16LE input on Windows; pasting a path with non-ASCII characters (e.g. `é` in `D:\Réseau\…`) will round-trip wrong. Encode `Buffer.from(text, "utf16le")` on the win path. Low-priority — only matters for non-ASCII project dirs.
- **`com.julien.claudesessions.sdPlugin/ui/slot.html:97`** — the `built-at` field reads `info.builtAtLocal`, which is in `sv-SE` locale (`YYYY-MM-DD HH:MM:SS`). Fine, but document why or just compute on the client from `info.unix`. Removes one field from `build-info.json`.
- **`scripts/render-icons.mjs:32`** — the `overflow` sample reuses `slot: 1` from the first row, so the file naming relies on `label.includes("overflows")` rather than a clean discriminator. Move the marquee sample to its own object with a distinct `name` field; small.
- **No tests.** Not a refactor blocker, but `splitLabel`, `deriveState`, and the `recentlyFinished` transition logic are all pure-ish and would catch regressions cheaply. Suggest one `*.test.ts` per module **after** the splits in points 2/3/4 — testing the current shapes would lock them in prematurely.

---

## Suggested execution order (kaizen — one PR per row)

| # | Change | Files touched | Risk | Why now |
|---|---|---|---|---|
| 1 | Unhardcode user/distro (point 7) | 4 files + new `env.ts` | very low | Unblocks anyone else cloning the repo. Pure mechanical. |
| 2 | Merge install scripts (point 6) | 2 → 1 + delete | low | Smallest cleanup, locks in shared jq filter before adding hooks. |
| 3 | Extract state registry (point 2) | `icons.ts`, `sessions.ts` | low — no behaviour change | Single biggest win for future "add a state" work. |
| 4 | Split `icons.ts` (point 3) | `icons.ts` → `icons/*` | low — no behaviour change | Naturally follows #3; sets the stage for #5 (Python kill). |
| 5 | Drop Python (point 1) | replace `render-static-pngs.py` with `.mjs` | low | After #4 the SVG primitives are import-able. |
| 6 | Split `plugin.ts` (point 4) | `plugin.ts` → 4 files | medium — touches polling | Worth doing once the icon side is stable. Tests become possible. |
| 7 | Hook routing table or Node bridge (point 5) | `hooks/*` | low (5a) / medium (5b) | Defer until a 4th event is needed. |

Each step compiles and ships on its own. Stop after #5 if scope shrinks — you'll already have removed Python, fixed the state-registry duplication, and unblocked clone-and-go installs.

---

## What this audit deliberately doesn't recommend

- **No DI / IoC container.** Module-level imports are fine.
- **No theme engine.** Keep palette as a plain object; revisit if a second theme is actually requested.
- **No plugin framework for states.** A typed registry object is sufficient.
- **No abstract `Hook` class.** The hook scripts are 50 lines each — a routing table is the right size.
- **No event bus / observable for the polling loop.** The two `setInterval`s with re-entrance guards are clear and correct; abstracting them would obscure the timing constraints.
- **No tests today.** They lock in shape; write them after the splits land (points 3, 4, 6).
