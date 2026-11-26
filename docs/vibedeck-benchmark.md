# VibeDeck benchmark & session-observation review

Study date: 2026-11-25. Subject: [VibeDeck](https://getvibedeck.com/) v2.1.0.0, a
closed-source Stream Deck plugin for AI coding agents, and what Claude Code (2.1.332)
now offers to observe and drive sessions. Raw teardown material (crawled pages,
videos, key SVGs) was kept out of the repo.

Scoping decisions taken before writing (they shape every recommendation below):

| # | Decision |
|---|---|
| Ambition | Personal tool, open to contributions — no Marketplace packaging, no licensing |
| Agents | Claude Code only; keep the event model agent-agnostic so Codex can plug in later |
| Approvals from the deck | Yes, **opt-in, with fallback** to the terminal prompt |
| Questions / plans from the deck | Yes, through a **temporary profile** |
| Session registry | `claude agents --json`, falling back to `<pid>.json` |
| Event transport | **Keep the ndjson log** (durable, replayable) |
| Hook distribution | Ship the hooks as a **Claude Code plugin** |
| Extras worth detailing | Usage/context gauges, alerts, and an interrupt ("stop") |

## Roadmap (decided 2026-11-26)

| Lot | Item | Section |
|---|---|---|
| **1** | ~~Spikes first~~ — done, [results](spikes-2026-11.md) | §6 |
| **1** | Swarm key (no slot reordering) | §4.1 |
| **1** | Hooks shipped as a Claude Code plugin | §4.3 |
| **1** | Richer key: tool / branch line, timer, "no session", done flourish | §4.8 |
| **1** | Approve / deny from the deck (opt-in, temporary profile) | §4.4 |
| **2** | Answer profile for questions and plans, on the R6 plumbing | §4.5 |
| **2** | Registry from `claude agents --json`, if the spike allows | §4.2 |
| **2** | Context gauge + quota key via a status-line tee | §4.6 |
| Backlog | Interrupt the turn (triple-tap → Esc) | §4.7 |
| Backlog | Alerts (subagents, zombie, full context) and Custom Signal key | §4.6, §4.8 |
| Rejected | Urgency sorting, sticky slots, HTTP hooks, dictation, HUD, SSH, Marketplace | — |

## 1. VibeDeck in one page

- **What:** "Your agents ask. Your Stream Deck answers." A live inbox of agent
  sessions (amber = waits for you, green = done, blue = working, red = error), with
  approvals, questions and plans answered from keys or from a floating on-screen card.
- **Scale:** 15 agents (7 of them status-only), 33 actions, macOS (Apple Silicon) and
  Windows 10+, Stream Deck 7.1+. Claude Code and Codex get the deep integration.
- **Business:** sole trader, launched mid-2026 at $5/month, now $19 one-time
  (2 machines) or 73 PLN on the Elgato Marketplace (published 2026-11-07). Very low
  public traction (Product Hunt: 1 upvote). Six other Claude-related Stream Deck
  plugins sit on the same Marketplace page.
- **Architecture clues (documented):** hooks merged into `~/.claude/settings.json`
  with preview → backup → validate → rollback; hooks talk to a **loopback HTTP service
  with a per-process token**; setup is a local web page on `127.0.0.1`; the
  on-screen card is a Rust/Slint helper. 2.1 cut per-tool-call hook latency from
  ~450 ms to ~30 ms on Windows (a PowerShell hook on every tool call was too slow —
  relevant to our `notification.ps1`).
- **Honest limits they state themselves:** exact pane focus only on iTerm2, Ghostty,
  Terminal.app, WezTerm, kitty, tmux and Windows Terminal; **Warp and Alacritty get app
  focus only; WSL and SSH sessions get no focus at all**; their VS Code bridge is not
  distributed.

### Their key design (worth borrowing)

Described from VibeDeck's real 144 px key SVGs (not vendored here).

- **Left status rail** (12×116 px) whose fill doubles as a gauge: context fill on a
  session key (amber ≥ 80 %, red ≥ 95 %), quota on a usage key. Gradient + glow per
  state: working `#7ABBFF→#2668D9`, waiting `#FFD34D→#E88F0C`, done `#6FF0B2→#22A968`,
  error `#FF8A7A→#D9333F`.
- **Four-line text stack:** agent glyph or state label (`! APPROVE`, `! INPUT`,
  `✓ DONE`) · project (cwd basename, 23 px bold) · git branch **or** the tool being
  approved (`Bash?`) **or** `question` · elapsed timer (blue while working, grey while
  waiting, `tap = open` when done).
- **Motion:** working = rail pulses (faster when burning tokens faster than usual);
  waiting = blinking amber border; done = 4-frame big ✓ flourish, then settle.
- **Approval key:** tool name, a giant `ALLOW` / `ALWAYS` / `DENY`, the command, the
  project. Dimmed `no request` when idle.
- **Answer keys:** `① PostgreSQL`, `② SQLite`, … plus a red `OTHER` key.

## 2. Feature matrix — VibeDeck vs us

Legend: ✅ we have it · 🟡 partial · ❌ gap · — out of scope (per the decisions above).

| Area | VibeDeck | Us today | Verdict |
|---|---|---|---|
| Per-session live state | working / waits / done / error / stuck | working, idle, awaiting (permission / plan / question), compacting, subagent, throttled, error, finished, bg-agent states, bypass/plan badges | ✅ **richer than theirs** |
| Slot ordering | **needs-you first**, then done, then working | start-time order; sessions beyond the slot count are **not displayed** | kept by choice; the Swarm key covers hidden sessions |
| Aggregate "Swarm" key | waiting / done / working totals; tap cycles waiting sessions | none | ❌ cheap, high value |
| Tap = focus | exact pane on 7 terminals; Warp = app only; WSL = none | Warp tab (Win DB + keystroke, macOS AppleScript), VS Code window, **works for WSL sessions** | ✅ we beat them on our own stack |
| Approve / deny from deck | Allow / Always / Deny, held hook with 10–290 s wait | none (we only *show* `awaiting_permission`) | ❌ → §4.4 |
| Answer questions / plans | Answer profile auto-switch, options 1–4 + Other (dictated) | none | ❌ → §4.5 |
| On-screen card (HUD) | Rust/Slint floating card | none | — (heavy native helper; the deck profile is enough) |
| Interrupt turn | triple-tap within 2 s (Esc) | none — we only **kill** the process (3 s hold) | ❌ → §4.7 |
| Kill process | no | 3 s hold with KILL ring | ✅ ours |
| Context fill / cache hit | rail gauge + `↻92%` | none | ❌ → §4.6 |
| 5 h / weekly quota, burn rate | usage keys, burn "wall ~2h58m" | none | ❌ → §4.6 (quota yes, burn rate later) |
| Early warnings | >10 subagents, 3× burn, 30 min busy without tool use | `throttled`, `error` states | 🟡 → §4.6 |
| Sounds | chimes, music pause | none | later, optional |
| Model / effort / custom command keys | yes (selected session) | none | later (needs keystroke injection) |
| Custom Signal key (scripts push state) | yes (CI, deploy…) | none | idea: trivially fits our ndjson model |
| Dictation, Keep Awake, Minimize, SSH hosts, 15 agents, licensing | yes | — | — out of scope |
| Hook install | settings.json merge with preview/backup/rollback | `install-hook.sh` + `check:hooks` + Setup self-check (#18) | 🟡 → §4.3 (CC plugin supersedes both) |

## 3. Observation: what Claude Code offers now

Today we rely on two things: the undocumented `~/.claude/sessions/<pid>.json` (+ PID
liveness via `kill -0` / `tasklist`) and a command hook appending one line per event
to `<sid>.events.ndjson`, polled every second and replayed by `reduceEvents`.

| Mechanism | What it gives | Push/poll | Status | Use it? |
|---|---|---|---|---|
| **Hooks — 34 events** (`PermissionRequest`, `PermissionDenied`, `Elicitation`, `SubagentStart`, `TaskCreated/Completed`, `StopFailure`, `PostToolBatch`, …) | Exact transitions, incl. the permission prompt itself | push (we persist) | documented | ✅ already the backbone; add the events we miss |
| **Hook types `http`, `mcp_tool`, `prompt`, `agent`** | `http` POSTs the event JSON to a URL | push | documented | ❌ for transport (decision: keep ndjson — events emitted while the plugin is down would be lost, and WSL → Windows networking is one more failure mode) |
| **`PermissionRequest` hook output** | `decision.behavior: allow/deny`, `updatedInput`, `message` | sync | documented | ✅ the approval path (§4.4) |
| **`claude agents --json [--all]`** | every session: `pid`, `cwd`, `kind` (interactive/background), `sessionId`, `name`, `status` (busy/waiting/idle) or `state` (working/blocked/done/failed/stopped), `waitingFor` | poll | **research preview** | ✅ registry + liveness (§4.2) |
| **Claude Code plugin** (`hooks/hooks.json`, `${CLAUDE_PLUGIN_ROOT}`) | hooks registered without editing settings.json; versioned updates via a marketplace | — | documented | ✅ distribution (§4.3) |
| **Status line JSON** | `context_window.used_percentage`, `rate_limits.five_hour/seven_day` (`used_percentage`, `resets_at`), cost, model | per session, debounced 300 ms | documented | ✅ for gauges only, through a tee wrapper (§4.6) |
| **OpenTelemetry** | metrics every 60 s, logs every 5 s; permission waits visible only after they resolve | batched | documented | ❌ too slow for keys |
| **Mods** (in-process JS) | tool-call hooks, panes, messages to sessions | push | documented, ≥ 2.1.287 | ❌ overkill; not in WSL sessions of the Desktop app |
| **Channels / Remote Control** | chat bridge / claude.ai relay | — | preview | ❌ |
| **Transcripts** `~/.claude/projects/**/*.jsonl` | token usage per turn | poll | **internal format** | 🟡 fallback for context % when no status line ran |

Verified locally: `claude agents --json` on 2.1.332 lists both interactive sessions
(`pid`, `status: "idle"`, `name`) and background ones (`state: "blocked"`). The docs
explicitly ask consumers not to parse `~/.claude/jobs/*` or `daemon/roster.json`.

## 4. Recommendations, in delivery order

### 4.1 Swarm key — the overflow safety net

- **Slot order stays as it is** (start time). Re-sorting by urgence was rejected:
  keys moving under your finger cost more than they save. Sticky slots (a session
  keeping its key until it ends) were rejected too, to keep the deck compact.
- The cost of that choice: a session beyond the slot count is invisible, even when
  it waits for you. The **Swarm key** (third action) covers it: three stacked counts
  `!! / ✓ / ▶` over *all* sessions, hidden ones included; tap = focus the oldest
  waiting session.

### 4.2 Registry from `claude agents --json`, fallback `<pid>.json`

- Replace the `<pid>.json` scan + `kill -0` / `tasklist` with one `claude agents --json`
  call per origin (WSL via `wsl.exe -d <distro> -- claude agents --json`, Windows
  natively). Liveness becomes "listed", and `status`/`state`/`waitingFor` give a
  second opinion on `awaiting`.
- **Measured** ([spikes](spikes-2026-11.md) §1): 285 ms native, 830 ms via `wsl.exe`
  from Windows — poll every 5 s at most. But `<pid>.json` already carries
  `status: "waiting"` + `waitingFor`, so the status half needs no subprocess at all;
  what remains is liveness (and `tasklist.exe` costs 2.4 s per call today).
- Fallback: on non-zero exit / unparseable JSON / missing command, use the current
  path unchanged (it stays the code we have). Log the fallback once.
- **#8** settled: during a permission prompt `status` reads `"waiting"`,
  `waitingFor: "permission prompt"` (verified on a real prompt).
- Also gives background sessions their documented state instead of our bg heuristics.

### 4.3 Hooks as a Claude Code plugin

- Repo gains `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and
  `hooks/hooks.json`; the same hook scripts, referenced via `${CLAUDE_PLUGIN_ROOT}`.
  Install: `/plugin marketplace add JulienCr/streamdeck-claude` then
  `/plugin install streamdeck-claude` — once in WSL, once in Windows CC.
- Retires `install-hook.sh`, `check:hooks`, and most of the Setup key's stale-hook
  self-check (#18): the plugin version *is* the hook version. Keep a minimal check
  ("no event seen from a live session for N min → HOOKS?").
- Windows: the hook ships inside the plugin cache, so the UNC trick for
  `notification.ps1` disappears. The ps1 still needs to find the sessions dir — same
  logic as today.
- Latency, measured ([spikes](spikes-2026-11.md) §4): `notification.ps1` costs 464 ms
  per call as installed (VibeDeck: ~450 ms), 136 ms for `notification.sh`. Set
  `async: true` on the pure-observer events (all but the approval hook): order held
  in every run.
- **#10** (sh ↔ ps1 parity test) stays relevant — maybe more, since both now ship.

### 4.4 Approve / deny from the deck — opt-in, with fallback

Mechanism (keeps the ndjson decision — files only, no server):

1. A **separate** `PermissionRequest` hook (`approval.sh` / `.ps1`) — the observer
   hook keeps logging the event as today.
2. Gate, zero-cost when unused: if the opt-in flag is off **or** the plugin heartbeat
   file (`~/.claude/.streamdeck-claude.alive`, touched every tick) is older than 3 s,
   exit immediately with no output → Claude shows its normal prompt.
3. Otherwise poll for `~/.claude/sessions/<sid>.decision.json` (written by the plugin,
   atomic rename) for up to *N* s (default 20, setting). On a decision, print
   `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
   (or `deny` + `message`); on timeout, exit silently → terminal prompt.
4. "Always": return `allow` plus the permission suggestion Claude passed in the
   payload (`permission_suggestions` → `updatedPermissions`), so the scope is Claude's
   own — what VibeDeck calls "keeps Claude's exact provider scope". Verified: the
   array varies per command (`addRules` → `localSettings`, or session-only
   `addDirectories`/`setMode`), so echo it back rather than build a rule.
5. Verified: while the hook blocks, the terminal already shows the normal prompt and
   accepts an answer. The wait can be long; the terminal is the fallback by
   construction.

**Gestures (your note: the press should keep showing the agent).**

- Key insight from VibeDeck: multi-tap needs **no latency** if the first tap's action
  is idempotent. Tap 1 focuses immediately (as today); taps 2–3 within the window add
  meaning. No 250 ms wait on every press.
- Proposed map on a slot key:

| Gesture | Any state | `awaiting_permission` |
|---|---|---|
| Tap | focus + copy cwd (unchanged) | same, **and** switch the deck to the approval profile |
| Hold 0.5 s | wipe the event log (unchanged) | same |
| Hold 3 s | kill (unchanged) | same |

- Approve/deny themselves live on **profile keys** (`ALLOW` / `ALWAYS` / `DENY`, with
  tool + command + project), never on a gesture of the slot key: a mis-timed
  double-tap must not run `rm -rf`. The profile appears automatically when a
  permission waits *and* auto-switch is on; otherwise on tap.

### 4.5 Answer profile — questions and plans

- **Read:** `AskUserQuestion` arrives in the `PreToolUse` payload (`tool_input.questions[].options[].label/description`).
  Log `tool_input` for that tool only (the hook currently logs `tool`), so the plugin
  can render `① label` keys. Plans = `ExitPlanMode` → a `PermissionRequest` → same
  path as §4.4 (Approve / Keep planning).
- **Answer:** a blocking `PreToolUse` hook on `AskUserQuestion` returning
  `permissionDecision: "allow"` with `updatedInput` carrying the `answers` — the shape
  the Agent SDK documents for `canUseTool`. Verified for hooks (answers keyed by
  question text, [spikes](spikes-2026-11.md) §3) — no keystroke fallback needed.
- **Profile:** one bundled profile per device size (manifest `Profiles`), switched via
  `switchToProfile` while a prompt waits, switched back when none remain. Keys: up to
  4 options, `Other` (= focus the terminal), `Back`. Mini: ▲ ▼ select. Studio has no
  profile switching (VibeDeck notes the same limit).
- Shared plumbing with §4.4: one "pending interaction" model (sid, kind
  permission|question|plan, payload, createdAt) and one decision file format.

### 4.6 Gauges and alerts

- **Source:** a status-line tee. Claude Code allows one `statusLine` command; ours
  wraps the user's existing one: read stdin, write `<sid>.status.json` (context %,
  `rate_limits`, model, cost), pipe stdin through to the original command and print
  its output. Whether a CC plugin can install a `statusLine` is unverified; assume
  a one-time, optional `settings.json` edit.
- **Session key:** a bottom-edge or side rail for context fill (amber ≥ 80 %,
  red ≥ 95 %), the same thresholds as VibeDeck, so the colour already means something
  to anyone who has used it.
- **Usage key** (new action): 5 h / weekly `%` and time to reset; tap toggles. Amber
  ≥ 60 %, red ≥ 85 %. Account-wide, so any live session's latest status file will do.
- **Alerts** (border colour only, never act): subagents > N (we already count
  `SubagentStart/Stop`); busy with no tool event for > 30 min ("zombie"); context
  ≥ 95 %. Burn-rate projection: later, it needs history.
- Fallback when the status line never ran: context % from the transcript's last
  `usage` block (internal format — tolerate failure).

### 4.7 Interrupt ("stop") — backlog idea, not planned

- VibeDeck's Stop interrupts the turn (Esc) and keeps the session; our 3 s hold kills
  the process. Both are useful; they must look different.
- Mechanism: focus (already done by tap 1) → send `Esc` via the per-terminal
  backend: Win32 keystroke (exists for Warp; to build for VS Code), AppleScript
  `key code 53` (macOS). Background sessions: `claude stop <id>` is the documented
  way, but it stops the job, not a turn — keep bg keys kill-free as today.
- Gesture if revived: triple-tap within 2 s (no added latency, see §4.4). Feedback: a brief `STOP` flash.

### 4.8 Small borrowings

- Empty key text "no session" instead of a blank key, once at least one slot is
  configured (onboarding signal that the plugin is alive).
- Third line: git branch while working, the tool name (`Bash?`) while awaiting
  permission, `question` for `AskUserQuestion` — we already log `tool`.
- Elapsed timer since the last state change (working / waiting).
- Done flourish (a few frames of ✓) before settling on `finished` — fits the existing
  animation tick.
- Custom Signal key: any script appends `{event:"Signal",state:"working|done|needs_you|error"}`
  to a named ndjson log; zero new infrastructure.

### Codex later

Keep the ndjson line format agent-neutral (`agent` field, default `claude`) and the
reducer keyed on event names that Codex's `hooks.json` also emits (`UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`). Nothing to build now.

## 5. Open issues and PRs touched

| Item | Relation |
|---|---|
| #8 rawStatus during mid-turn Notification | §4.2 — `agents --json` `status/waitingFor` answers it; verify on a live prompt |
| #10 hook parity test sh ↔ ps1 | §4.3 — still needed, a decision hook doubles the surface |
| #16 drill-states for bg states | extend to the new visuals (rail, timer, flourish) |
| #18 / Setup self-check | mostly superseded by the CC plugin (§4.3) |
| #29 docs refresh | add this doc to the docs index |
| PR #26 Claude desktop focus (macOS) | VibeDeck opens the *exact* Desktop conversation — a possible follow-up |
| #4, #5, #7, #9, #11, #12 | unaffected |

## 6. Spikes before committing to a design

Run 2026-11-26, results in [spikes-2026-11.md](spikes-2026-11.md); spike 5 moved into #32.

1. `claude agents --json`: spawn cost from Windows (native and via `wsl.exe`); does an
   interactive session show `waiting` + `waitingFor` during a permission prompt?
2. `PermissionRequest` blocking: what the terminal shows meanwhile; the exact payload
   (`permission_suggestions`?), the hook timeout ceiling.
3. `AskUserQuestion` answered through `PreToolUse` `updatedInput.answers`.
4. Per-call cost of `notification.ps1` on Windows (VibeDeck measured ~450 ms) and
   whether `async: true` on observer hooks preserves event order in the log.
5. CC plugin install from a GitHub marketplace on both WSL and Windows CC.

## Sources

- VibeDeck: https://getvibedeck.com/ (`/claude-code`, `/sessions`, `/safety`,
  `/terminals`, `/compatibility`, `/install`, `/releases/`), Elgato Marketplace
  listing, Product Hunt page.
- Claude Code docs: https://code.claude.com/docs/en/hooks.md ·
  `/agent-view.md` · `/plugins/components.md` · `/statusline.md` ·
  `/monitoring-usage.md` · `/plugins/mods/overview.md` · `/channels.md` ·
  `/sessions.md`.
