# VS Code terminal focus on slot press — design

**Date:** 2026-05-23
**Status:** approved (brainstorming → ready for implementation plan)

## Problem

Pressing a slot key already copies the session's `cwd` to the clipboard and, on
macOS/Windows, tries to bring the **Warp** tab whose cwd matches the session to
the foreground. Session *detection* (reading `~/.claude/sessions/<pid>.json` +
liveness + the hook event log) is terminal-agnostic, so a Claude Code session
launched in a **VS Code integrated terminal** (WSL-remote or native PowerShell)
is already shown on a key — but pressing that key does nothing useful because
the focus path only knows how to raise Warp.

Goal: pressing a slot bound to a VS Code-hosted session brings the matching
**VS Code window** to the foreground, on both Windows and macOS. The mechanism
must generalise to iTerm2 later (the stated next target).

## Research conclusions (what is and isn't possible)

These findings shaped the design; they are recorded so future work doesn't
re-litigate them.

1. **Process tree can't identify the window.** A VS Code integrated terminal's
   shell is a child of a *shared pty host* process (one Node process hosting
   every terminal across every window), not of the window. Walking
   `claude → shell → parent` therefore can't tell us which window we're in.
2. **Terminal-tab precision needs a companion extension.** Only the extension
   API (`window.terminals` + `terminal.shellIntegration.cwd` + `terminal.show()`)
   can map cwd → a specific integrated terminal. Everything else tops out at the
   *window* level. A companion extension is out of scope here.
3. **The `code <folder>` CLI is a footgun for focus.** It focuses an existing
   window only if `<folder>` is the exact open workspace root; otherwise it opens
   a **new** window. Claude often runs in a subdirectory of the workspace root, so
   this would spawn stray windows — a worse failure mode than the current silent
   no-op. Rejected.
4. **Detecting *that* a session is in VS Code is clean.** The integrated terminal
   exports `TERM_PROGRAM=vscode` (Warp: `WarpTerminal`, iTerm2: `iTerm.app`). A
   `SessionStart` hook runs inside that shell and can stamp the terminal kind
   once. This is the dispatch signal and it generalises to iTerm2.
5. **Raising the right window via its title is feasible.** On Windows,
   `Get-Process Code | ? MainWindowHandle -ne 0` enumerates VS Code windows with
   their title + HWND; the default title contains the workspace name
   (`${rootName}`) and remote marker (`[WSL: <distro>]`). On macOS, VS Code
   exposes an Accessibility tree (unlike Warp), so System Events can enumerate
   window names and `AXRaise` the chosen one. We score titles against the
   session cwd and raise the best match, reusing the Win32 foreground machinery
   already written for Warp.

**Chosen approach:** stamp the terminal kind at `SessionStart`, dispatch focus by
kind, and for VS Code raise the best-matching *window* (window-level precision,
title-based matching). No terminal-tab precision, no companion extension, no
`code` CLI.

## Components

### Terminal kind: type and capture

`TerminalKind = "vscode" | "warp" | "iterm" | "other" | "unknown"`.

Captured by the hook scripts at `SessionStart` only (the moment the log is
truncated, so the stamp is always the head entry). Both scripts already run in
the session's shell, so the terminal env vars are visible.

- `hooks/notification.sh`: derive `term` from the environment —
  `vscode` if `$TERM_PROGRAM == vscode` **or** `$VSCODE_PID`/`$VSCODE_GIT_IPC_HANDLE`
  is non-empty (the secondary check survives tmux/screen, which overwrite
  `TERM_PROGRAM` with their own value); `warp` if `WarpTerminal`; `iterm` if
  `iTerm.app`; else `other`. Add `term` to the emitted JSON only on
  `SessionStart`.
- `hooks/notification.ps1`: exact mirror against `$env:TERM_PROGRAM` /
  `$env:VSCODE_PID` / `$env:VSCODE_GIT_IPC_HANDLE`.

Emitted line: `{"ts":…,"event":"SessionStart","term":"vscode"}`. No other event
line changes. `SessionStart` is already a registered event, so
`scripts/install-hook.sh` is unchanged and `pnpm check:hooks` stays green.

### State pipeline plumbing

- `src/session-events.ts`:
  - `SessionEvent` gains `term?: string`; `parseEventLog` extracts it
    (string-or-undefined, like `tool`/`notifType`).
  - `DerivedState` gains `terminal: TerminalKind` (default `"unknown"`); `ZERO`
    includes `terminal: "unknown"`.
  - `applyEvent`'s `SessionStart` case returns `{ ...ZERO, terminal: normaliseTerm(ev.term) }`.
    The `SessionEnd` case keeps returning `ZERO`. All other resets
    (`UserPromptSubmit`, `Stop`, …) spread `...state`, so `terminal` carries
    forward through the session.
  - `normaliseTerm(raw)` maps a raw string to a `TerminalKind`, defaulting to
    `"unknown"` for absent/unrecognised values (so the reducer is robust even if
    a hook ever emits something unexpected).
- `src/sessions.ts`: `SessionInfo` gains `terminal: TerminalKind`, populated from
  `derived.terminal`. The inline default-`DerivedState` literal in `readOneSource`
  gains `terminal: "unknown"`.
- `src/render-loop.ts`: `slotState.terminal = entry?.session.terminal` (set each
  tick alongside `clipboardPayload`/`sessionId`/`origin`).
- `src/slot-action.ts`: `SlotState` gains `terminal?: TerminalKind`;
  `runShortPress` reads it and calls the new dispatch. The clipboard copy still
  runs first and is unconditional.

### Focus dispatch — `src/terminal-focus.ts`

Generalises today's `warp-focus.ts` entry point.

```ts
focusTerminalForSession({ cwd, terminal, origin }): Promise<FocusResult>
```

- `warp`    → `focusWarpTabForCwd(cwd)` (existing, unchanged)
- `vscode`  → `focusVscodeWindowForCwd(cwd, origin)` (new)
- `iterm`   → no-op result (explicit placeholder for the future)
- `other`   → no-op (bare terminal: nothing to raise; clipboard already covers it)
- `unknown` → back-compat safety net: try Warp; if it returns no match, try
  VS Code. Covers sessions started before the hook stamp existed and any case
  where env detection missed.

`FocusResult` is the existing `WarpFocusResult` shape (`{ matched, reason }`),
renamed conceptually to `FocusResult` and shared by both backends. The result is
only logged; the key's `showOk`/`showAlert` feedback stays driven by the
clipboard copy, exactly as today.

### VS Code window locator

- `src/vscode-focus.ts`: dispatch by `process.platform` (`darwin` →
  `vscode-focus-mac.ts`, `win32` → `vscode-focus-win.ts`, else no-op). Mirrors
  `warp-focus.ts`.
- `src/vscode-window-match.ts` (pure, no I/O): `pickBestWindow(cwd, windows, origin)`
  scores each `{ title }` against `cwd` and returns the best or `null`.
  - `basename(cwd)` present as a path-ish token in the title → strong score;
    deeper path-component overlap → tie-breaker.
  - `origin === "wsl"` → bonus for titles containing `[WSL`; `origin === "windows"`
    → penalty for `[WSL` titles. Disambiguates the same basename open both natively
    and in a WSL-remote window.
  - Returns `null` when nothing scores above zero (caller gives up silently).
  - Mirrors the scoring philosophy of `warp-db.ts`'s `pickBestPane`.
- `src/vscode-focus-win.ts`: enumerate windows via PowerShell
  `Get-Process Code,'Code - Insiders' -EA SilentlyContinue | ? { $_.MainWindowHandle -ne 0 } | % { "$($_.MainWindowHandle)`t$($_.MainWindowTitle)" }`
  → `(hwnd, title)` pairs. Score with `pickBestWindow` → raise the winning HWND
  via the shared Win32 foreground dance (see refactor below), **without** a
  keystroke (raise only — there is no tab to switch to).
- `src/vscode-focus-mac.ts`: `osascript` + System Events — read
  `name of windows of process "Code"`, score with `pickBestWindow`, then
  `tell process "Code" to set frontmost to true` + `perform action "AXRaise" of window <i>`.
  Reuses the Accessibility permission already required by the Warp macOS path
  (no new permission class). Best-effort: silent if VS Code isn't running, AX is
  denied, or no window matches.

### Targeted refactor — `src/win32-raise.ts`

Extract from `warp-focus-win.ts` the pieces both backends need:

- the `TYPES_GUARD` Add-Type P/Invoke bundle,
- `runPowerShell(script, timeoutMs)`,
- the attach/raise sequence for a given HWND (the `AttachThreadInput` +
  `ShowWindow`/`BringWindowToTop`/`SetForegroundWindow` dance).

`warp-focus-win.ts` keeps its keystroke logic and now consumes the shared raise.
`vscode-focus-win.ts` consumes the raise only. This avoids duplicating ~60 lines
of P/Invoke and keeps the foreground quirks documented in one place.

### Docs & tooling

- `docs/vscode-focus.md`: mirror `docs/warp-focus.md` — mechanism, matching
  algorithm, per-platform notes, failure modes, and the explicit **limitations**
  (window-level only; matching is title-based and depends on the user's
  `window.title` not having stripped `${rootName}`).
- Update the "focus on slot press" section of `CLAUDE.md` (now describes the
  dispatch + two backends) and the user-visible behaviour note in `README.md`.
- `scripts/check-vscode` + `pnpm check:vscode`: dump enumerated VS Code windows
  (title + HWND/index) and the chosen match for a given cwd. Mirrors
  `scripts/check-warp`. Debug aid only.

## Data flow

1. CC `SessionStart` → hook truncates `<sid>.events.ndjson`, appends
   `{"ts","event":"SessionStart","term":"vscode"}`.
2. Slow tick → `sessions.ts` reads the log → `reduceEvents` →
   `SessionInfo.terminal = "vscode"`.
3. `render-loop` binds the slot → `SlotState.terminal` set.
4. Key press → `runShortPress` → copy cwd to clipboard (always) →
   `focusTerminalForSession({ cwd, terminal, origin })`.
5. Dispatch → `vscode` → platform locator → enumerate VS Code windows, score
   titles vs cwd, raise the best window. Best-effort, logged, silent on failure.

## Error handling

- Every step is best-effort. The clipboard copy runs first and is the source of
  the key's success/alert feedback; focus failures only log a `reason` (mirrors
  the Warp path exactly).
- `unknown` terminal → Warp-then-VS Code fallback, so no regression for
  pre-existing sessions.
- VS Code not running / no matching window / AX denied (macOS) / `Get-Process`
  empty (Windows) → silent no-op.

## Testing & verification

No test suite or lint script exists. The pure module `vscode-window-match.ts` is
written to be unit-testable in isolation (no I/O) even though the repo has no
runner yet; correctness of the matcher is the one piece worth exercising via the
`scripts/check-vscode` harness.

Manual verification: `pnpm build && pnpm sd:validate && pnpm sd:reload`, then:

- VS Code native PowerShell terminal → launch `claude`, press the slot → that VS
  Code window comes forward.
- VS Code WSL-remote window (`[WSL: <distro>]`) → same.
- macOS VS Code window → same (after granting Accessibility once).
- Warp session (stamped `warp`) → still focuses the Warp tab as before.
- Bare terminal (Windows Terminal / plain) → no focus attempt, clipboard still
  copies.

## Scope / YAGNI

Out of scope: terminal-tab precision (would require a companion VS Code
extension), iTerm2 (placeholder no-op only), any cwd → tab mapping.
