---
name: claude-code-process-introspection
description: Use when building a tool that needs to detect or monitor live Claude Code CLI sessions across WSL and Windows-native installs — reading per-pid state from `~/.claude/sessions/<pid>.json`, checking process liveness in two namespaces, and installing Notification hooks idempotently in both shells. Covers the session schema, the dual-origin layout, the tasklist `/FI` AND-quirk, the PowerShell stdin gotcha, and the `<sessionId>.notify.json` pattern for surfacing "awaiting permission" state without modifying Claude itself.
---

# Claude Code process introspection

Built and validated while shipping `streamdeck-claude`. Everything below is observed behaviour against Claude Code 2.1.x — there's no public spec, treat the schema as best-effort and don't rely on undocumented fields.

## Where Claude Code stores live session state

Every running `claude` CLI writes a JSON file to `<HOME>/.claude/sessions/<pid>.json`:

```json
{
  "pid": 234003,
  "sessionId": "07cbcb21-23f8-450b-a03c-cdfac4316542",
  "cwd": "/home/julien/dev/streamdeck-claude",
  "startedAt": 1778324147749,
  "procStart": "31768035",
  "version": "2.1.138",
  "peerProtocol": 1,
  "kind": "interactive",
  "entrypoint": "cli",
  "status": "busy",
  "updatedAt": 1778324166394,
  "name": "html-effectiveness-doc",
  "bridgeSessionId": "session_01ER..."
}
```

Confirmed values for `status`: only `"busy"` and `"idle"`. **There is no native `awaiting_permission` value** — see "Notification hook" below for our workaround.

`name` is set when the user gave the session a custom title (`/title`) or for managed-agent sessions; otherwise absent. `bridgeSessionId` indicates a managed/remote agent session. Treat both as best-effort and fall back to `basename(cwd)` for a label.

**Files persist after the process exits.** They are not cleaned up. Always combine the file scan with a liveness check; a session file alone tells you nothing.

## Two stores per host (WSL ↔ Windows-native)

WSL `claude` and Windows-native `claude` are **completely separate installs with separate process namespaces**. They never share PIDs or session IDs.

| Origin | Sessions dir (from that side) | From the other side |
|---|---|---|
| WSL claude | `/home/<u>/.claude/sessions/` | `\\wsl.localhost\<distro>\home\<u>\.claude\sessions\` |
| Windows claude | `%USERPROFILE%\.claude\sessions\` (`C:\Users\<u>\.claude\sessions\`) | `/mnt/c/Users/<u>/.claude/sessions/` |

A monitoring tool that wants both must read both directories AND tag each session with its origin so the right liveness check is applied. Reference implementation: `src/sessions.ts` in `streamdeck-claude` — `SessionOrigin = "wsl" | "windows"` carried through every record.

## Liveness checks (two paths)

### WSL pids — `kill -0` over `wsl.exe`

From a Windows-side consumer:
```sh
wsl.exe -d Ubuntu -- bash -c 'kill -0 234003 2>/dev/null && echo 234003; kill -0 234004 2>/dev/null && echo 234004'
```

Batch all candidate PIDs into one bash `-c` script and parse the printed lines. One spawn per tick (~50–200 ms cold).

### Windows pids — `tasklist.exe`

```sh
tasklist.exe /NH /FO CSV
```
returns one CSV row per process: `"image.exe","<pid>","Console","1","123 K"`. Parse the second column, intersect with candidate PIDs.

> **Trap**: `tasklist /FI "PID eq <n>"` works for one PID, but **multiple `/FI "PID eq <n>"` filters are AND'd**, not OR'd, so batch-filtering returns zero results ("no task matches the specified criteria"). Don't try to batch — just dump everything once and intersect in code.

### Reliability — both spawn paths flicker

`wsl.exe` and `tasklist.exe` occasionally return success with empty stdout under load. If your liveness check returns "0 alive" while you have running sessions, every slot on your UI flips to "finished". Cache the previous good answer per origin and reuse for ~10 s on transient empty results. Reference: `src/live-pids.ts` (`parseAndCache` + `CACHE_FALLBACK_MS`).

## Stale-file handling

`~/.claude/sessions/` accumulates dead-pid `.json` files indefinitely. A naive consumer that treats every dead session as "just finished" will spam the UI with months-old leftovers.

Rule we ship: a session enters the "finished" bucket **only** when it was alive in the previous tick AND is dead in this one. Sessions that are dead-on-arrival (never seen alive in this run) are silently dropped.

```ts
// pseudo
let prevLive = new Set<string>();
function tick(sessions, live) {
  for (const s of sessions) {
    if (prevLive.has(s.sessionId) && !live.has(s.sessionId)) {
      finished.set(s.sessionId, { ttl: 3000, ...s });
    }
  }
  prevLive = live;
}
```

## Plan-approval hook — surfacing `ExitPlanMode` waits

Claude's `ExitPlanMode` tool pauses the assistant until the user clicks Approve or Reject. There is no dedicated event for "plan presented to user" — but the `PreToolUse`/`PostToolUse` hooks fire for every tool call, including this one, and accept a `matcher` field to scope by tool name:

```json
"PreToolUse":  [{ "matcher": "ExitPlanMode", "hooks": [{ "type": "command", "command": "..." }]}],
"PostToolUse": [{ "matcher": "ExitPlanMode", "hooks": [{ "type": "command", "command": "..." }]}]
```

We use the same notify-file pattern: PreToolUse drops `<sessionId>.plan.json`, PostToolUse removes it. PostToolUse fires both on Approve (when Claude resumes and processes the tool result) and on Reject (when Claude iterates on the plan), so the file always gets cleared. The consumer treats `status=idle` + plan file present (mtime within ~30 min as a safety TTL) as the awaiting-plan state, and prioritises it over the simpler awaiting-permission state.

The hook script is the same one used for `Notification` — it routes by `hook_event_name` (and, for tool events, `tool_name`) read from the JSON stdin payload. One installed command, three settings entries (`Notification`, `PreToolUse[ExitPlanMode]`, `PostToolUse[ExitPlanMode]`). Reference: `hooks/notification.sh` + `hooks/notification.ps1`.

## Notification hook — surfacing "awaiting permission"

Claude Code fires the `Notification` hook event when it needs the user (permission prompts, idle prompt). The hook stdin is JSON:

```json
{
  "session_id": "07cbcb21-23f8-450b-a03c-cdfac4316542",
  "transcript_path": "...",
  "cwd": "...",
  "hook_event_name": "Notification",
  "message": "..."
}
```

Pattern we use to surface awaiting state without modifying Claude: **the hook drops a tiny `<sessionId>.notify.json` next to the session JSON.** The consumer then treats `status=idle` + notify-mtime within 60 s as "awaiting", and `status=busy` (or stale notify) as "no longer awaiting" — no explicit clear-hook needed.

### WSL (Bash) — `hooks/notification.sh`

Reads stdin via `cat`, extracts `session_id` with `jq -r '.session_id // empty'`, writes `${HOME}/.claude/sessions/${SESSION_ID}.notify.json` with a millisecond timestamp. Echoes `{}` to be polite to other hooks.

### Windows (PowerShell) — `hooks/notification.ps1`

**Critical gotcha**: when launched via `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <script>.ps1`, `[Console]::In.ReadToEnd()` returns **empty string** unless you first set the input encoding:

```powershell
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$payload = [Console]::In.ReadToEnd()
```

Without that line, the hook silently runs with no input and the notify file never appears. (It works fine via `-Command` because the auto-pipeline `$input` variable handles encoding for you, but `-File` mode does not.)

The script then writes `${env:USERPROFILE}\.claude\sessions\<sessionId>.notify.json` and emits `{}` on stdout.

## Idempotent settings.json merge

Both `~/.claude/settings.json` (WSL) and `%USERPROFILE%\.claude\settings.json` (Windows-native) follow the same schema:

```json
{
  "hooks": {
    "Notification": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "..." }] },
      ...
    ]
  }
}
```

Multiple Notification entries are fine — Claude fires them all. Idempotent installer pattern (`scripts/install-hook.sh`, `scripts/install-hook-windows.sh`):

```sh
jq --arg cmd "$HOOK_CMD" '
  .hooks //= {}
  | .hooks.Notification //= []
  | if any(.hooks.Notification[]?; (.hooks // []) | any(.command == $cmd))
    then .
    else .hooks.Notification += [{
      "matcher": "",
      "hooks": [{"type": "command", "command": $cmd}]
    }]
    end
' settings.json > tmp && mv tmp settings.json
```

The merge keys on the exact `command` string, so re-running is a no-op. Take a daily backup first: `cp settings.json settings.json.bak.$(date +%Y%m%d)`.

The install script can run from WSL even when targeting Windows-side `settings.json` (it's at `/mnt/c/Users/<u>/.claude/settings.json`, accessible to both `cp` and `jq`). For the Windows hook script itself, **copy it to `%USERPROFILE%\.claude\hooks\` rather than referencing it via `\\wsl.localhost\…`** — that way the hook keeps working when WSL is suspended.

## Bash watch-out — `cp -i` aliases

Many shells alias `cp` to `cp -i`. When an installer runs `cp src dst` with the destination already present, the prompt has no terminal to answer on, and the copy silently no-ops while the script continues happily. **Use `command cp -f`** (or `\cp -f`) in installer scripts to bypass the alias. We hit this exact failure mode while shipping the Windows hook installer — the hook script appeared "installed" but was the wrong version.

## Hook events you might want besides Notification

Confirmed firing in current Claude Code:
- `SessionStart` — startup, clear, compact
- `SessionEnd` — session ends
- `UserPromptSubmit` — user submits a prompt
- `PreToolUse` / `PostToolUse` / `PostToolUseFailure`
- `Stop` / `SubagentStart` / `SubagentStop`
- `Notification` — what we use

There is **no** `PermissionGranted` or `PermissionDenied` event — that's why we rely on the status-flip from `idle` → `busy` to clear the awaiting state instead of an explicit clear hook.
