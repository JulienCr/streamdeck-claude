# VS Code Terminal Focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pressing a slot key bound to a Claude Code session running in a VS Code integrated terminal brings the matching VS Code window to the foreground, on Windows and macOS.

**Architecture:** A `SessionStart` hook stamps the terminal kind (from `TERM_PROGRAM`) into the session's NDJSON event log. The plugin reduces that into `SessionInfo.terminal` and dispatches the slot-press focus by kind: Warp (existing), VS Code (new), iTerm2 (placeholder), bare (no-op), unknown (Warp→VS Code fallback). The VS Code backend enumerates VS Code windows, scores their titles against the session cwd with a pure matcher, and raises the best window — reusing the Win32 foreground machinery already written for Warp.

**Tech Stack:** TypeScript ESM (NodeNext, `.js` import extensions), Node 20, rollup bundle, `tsx` test runner (`node:test`), PowerShell (Windows raise/enumerate), AppleScript/`osascript` (macOS raise/enumerate), bash + PowerShell hook scripts, pnpm.

---

## Conventions for every task

- Imports use the `.js` extension even for local `.ts` modules (NodeNext).
- After any TS change, the build check is: `pnpm build` (must succeed, no type errors).
- Tests run with: `pnpm test` (added in Task 1).
- Commit messages end with the trailer:
  `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
- Work happens on branch `feat/vscode-terminal-focus` (already created; the spec is committed there).

---

## File structure

**Created:**
- `src/terminal-kind.ts` — `TerminalKind` type + `normaliseTerm()` (pure). Shared by the reducer and the focus dispatch.
- `src/terminal-kind.test.ts` — tests for `normaliseTerm`.
- `src/vscode-window-match.ts` — `pickBestWindow()` (pure title↔cwd scorer).
- `src/vscode-window-match.test.ts` — tests for `pickBestWindow`.
- `src/session-events.test.ts` — tests for `reduceEvents` terminal plumbing.
- `src/win32-raise.ts` — shared Win32 P/Invoke bundle (`TYPES_GUARD`) + `runPowerShell()`, extracted from `warp-focus-win.ts`.
- `src/terminal-focus.ts` — `FocusResult` type + `focusTerminalForSession()` dispatch.
- `src/vscode-focus.ts` — platform dispatcher for the VS Code backend.
- `src/vscode-focus-win.ts` — Windows: enumerate VS Code windows + raise the chosen HWND.
- `src/vscode-focus-mac.ts` — macOS: enumerate VS Code windows + `AXRaise` the chosen one.
- `scripts/check-vscode.ts` — CLI sanity-check that dumps enumerated windows + chosen match for a cwd (run via `tsx`, mirrors `scripts/drill-states.ts`).
- `docs/vscode-focus.md` — reference doc, mirrors `docs/warp-focus.md`.

**Modified:**
- `hooks/notification.sh` — stamp `term` on `SessionStart`.
- `hooks/notification.ps1` — mirror of the above.
- `src/session-events.ts` — `SessionEvent.term`, `DerivedState.terminal`, reducer wiring.
- `src/sessions.ts` — `SessionInfo.terminal`.
- `src/render-loop.ts` — set `slotState.terminal`.
- `src/slot-action.ts` — `SlotState.terminal` + call `focusTerminalForSession`.
- `src/warp-focus.ts` — `WarpFocusResult` becomes an alias of `FocusResult`.
- `src/warp-focus-win.ts` — import `TYPES_GUARD`/`runPowerShell` from `win32-raise.ts` instead of defining them locally.
- `package.json` — add `test` and `check:vscode` scripts.
- `CLAUDE.md` — update the focus-on-press section.
- `README.md` — user-visible behaviour note.

---

## Task 1: TerminalKind type + normaliseTerm + test runner

**Files:**
- Create: `src/terminal-kind.ts`
- Create: `src/terminal-kind.test.ts`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Add the `test` script**

In `package.json`, inside `"scripts"`, add this entry (next to `"build"`):

```json
"test": "tsx --test src/*.test.ts",
```

- [ ] **Step 2: Write the failing test**

Create `src/terminal-kind.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseTerm, type TerminalKind } from "./terminal-kind.js";

test("normaliseTerm maps canonical hook values to kinds", () => {
  const cases: [string | undefined, TerminalKind][] = [
    ["vscode", "vscode"],
    ["warp", "warp"],
    ["iterm", "iterm"],
    ["other", "other"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normaliseTerm(input), expected);
  }
});

test("normaliseTerm defaults unknown/absent to 'unknown'", () => {
  assert.equal(normaliseTerm(undefined), "unknown");
  assert.equal(normaliseTerm(""), "unknown");
  assert.equal(normaliseTerm("WarpTerminal"), "unknown"); // raw env value, not canonical
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot find module `./terminal-kind.js` / `normaliseTerm is not a function`.

- [ ] **Step 4: Implement the module**

Create `src/terminal-kind.ts`:

```ts
/** Which terminal application hosts a Claude Code session. Stamped once at
 *  SessionStart by the hook (from $TERM_PROGRAM) and used to pick the focus
 *  strategy when a slot key is pressed. */
export type TerminalKind = "vscode" | "warp" | "iterm" | "other" | "unknown";

const KINDS: ReadonlySet<TerminalKind> = new Set([
  "vscode",
  "warp",
  "iterm",
  "other",
]);

/** Coerce a raw `term` field (already canonicalised by the hook) into a
 *  TerminalKind. Anything absent or unrecognised becomes "unknown" so the
 *  dispatch falls back to the safe Warp→VS Code path. */
export function normaliseTerm(raw: string | undefined): TerminalKind {
  return raw && KINDS.has(raw as TerminalKind) ? (raw as TerminalKind) : "unknown";
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json src/terminal-kind.ts src/terminal-kind.test.ts
git commit -m "feat(terminal): TerminalKind type + normaliseTerm, add tsx test runner

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: VS Code window matcher (pure)

**Files:**
- Create: `src/vscode-window-match.ts`
- Create: `src/vscode-window-match.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/vscode-window-match.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickBestWindow } from "./vscode-window-match.js";

const win = (title: string) => ({ title });

test("matches a window whose title contains the cwd basename as a token", () => {
  const best = pickBestWindow("/home/julien/dev/foo", [win("index.ts — foo [WSL: Ubuntu]")], "wsl");
  assert.equal(best?.title, "index.ts — foo [WSL: Ubuntu]");
});

test("prefers the window with deeper path-component overlap on a basename tie", () => {
  const best = pickBestWindow(
    "/a/b/foo",
    [win("foo"), win("b — foo")],
    "windows",
  );
  assert.equal(best?.title, "b — foo");
});

test("WSL-origin sessions prefer windows with a [WSL] marker", () => {
  const best = pickBestWindow(
    "/home/u/foo",
    [win("foo"), win("foo [WSL: Ubuntu]")],
    "wsl",
  );
  assert.equal(best?.title, "foo [WSL: Ubuntu]");
});

test("windows-origin sessions penalise [WSL] markers", () => {
  const best = pickBestWindow(
    "D:\\dev\\foo",
    [win("foo"), win("foo [WSL: Ubuntu]")],
    "windows",
  );
  assert.equal(best?.title, "foo");
});

test("returns null when nothing scores above zero", () => {
  assert.equal(pickBestWindow("/x/bar", [win("foo — baz")], "windows"), null);
});

test("returns null for an empty window list", () => {
  assert.equal(pickBestWindow("/x/foo", [], "wsl"), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — cannot find module `./vscode-window-match.js`.

- [ ] **Step 3: Implement the matcher**

Create `src/vscode-window-match.ts`:

```ts
import type { SessionOrigin } from "./sessions.js";

/** Minimal shape the matcher needs; backends pass richer objects (HWND, etc.)
 *  and get the same object back, so this is generic over the carrier. */
export interface TitledWindow {
  title: string;
}

/**
 * Pick the VS Code window whose title best matches `cwd`, or null if none
 * scores. Matching is title-based and best-effort: VS Code's default window
 * title contains the workspace name (`${rootName}`) and a `[WSL: <distro>]`
 * marker, but a user can reshape it via `window.title`, and the active editor
 * filename prefixes it. We therefore score on tokens, not exact strings.
 *
 * Scoring per window:
 *   +10  the cwd basename appears as a token in the title
 *   + N  N additional cwd path components also appear as tokens (tie-break)
 *   + 3  origin is "wsl" and the title carries a [WSL] marker
 *   - 3  origin is "windows" and the title carries a [WSL] marker
 * Highest score wins; ties resolve to the first window; score <= 0 → no match.
 */
export function pickBestWindow<W extends TitledWindow>(
  cwd: string,
  windows: readonly W[],
  origin: SessionOrigin,
): W | null {
  const cwdTokens = pathTokens(cwd);
  if (cwdTokens.length === 0) return null;
  const base = cwdTokens[cwdTokens.length - 1];
  const rest = cwdTokens.slice(0, -1);

  let best: W | null = null;
  let bestScore = 0;
  for (const w of windows) {
    const titleTokens = titleTokenSet(w.title);
    let score = 0;
    if (titleTokens.has(base)) score += 10;
    for (const t of rest) if (titleTokens.has(t)) score += 1;
    const hasWsl = /\[wsl/i.test(w.title);
    if (hasWsl) score += origin === "wsl" ? 3 : -3;
    if (score > bestScore) {
      bestScore = score;
      best = w;
    }
  }
  return bestScore > 0 ? best : null;
}

/** Lowercased path components of a cwd, both `/` and `\` separated, empties dropped. */
function pathTokens(cwd: string): string[] {
  return cwd
    .toLowerCase()
    .split(/[/\\]+/)
    .filter(Boolean);
}

/** Lowercased token set of a window title, split on whitespace, path separators,
 *  and the separators VS Code uses in titles (em dash, pipe, brackets, parens). */
function titleTokenSet(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[\s/\\—|()[\]]+/)
      .filter(Boolean),
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS (all tests in both test files).

- [ ] **Step 5: Commit**

```bash
git add src/vscode-window-match.ts src/vscode-window-match.test.ts
git commit -m "feat(vscode): pure title↔cwd window matcher

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Reduce `term` into DerivedState

**Files:**
- Modify: `src/session-events.ts`
- Create: `src/session-events.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/session-events.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEventLog, reduceEvents } from "./session-events.js";

test("SessionStart term is reduced into DerivedState.terminal", () => {
  const log = JSON.stringify({ ts: 1, event: "SessionStart", term: "vscode" });
  assert.equal(reduceEvents(parseEventLog(log)).terminal, "vscode");
});

test("terminal carries through a turn (UserPromptSubmit/Stop preserve it)", () => {
  const log = [
    { ts: 1, event: "SessionStart", term: "warp" },
    { ts: 2, event: "UserPromptSubmit" },
    { ts: 3, event: "Stop" },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  assert.equal(reduceEvents(parseEventLog(log)).terminal, "warp");
});

test("absent term defaults to 'unknown'", () => {
  const log = JSON.stringify({ ts: 1, event: "SessionStart" });
  assert.equal(reduceEvents(parseEventLog(log)).terminal, "unknown");
});

test("an unrecognised term value is coerced to 'unknown'", () => {
  const log = JSON.stringify({ ts: 1, event: "SessionStart", term: "kitty" });
  assert.equal(reduceEvents(parseEventLog(log)).terminal, "unknown");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `terminal` is `undefined` (property not yet on DerivedState).

- [ ] **Step 3: Add the import and the `term` field to `SessionEvent`**

In `src/session-events.ts`, add the import at the top (after the existing header comment, before `export type TodoStatus`):

```ts
import { normaliseTerm, type TerminalKind } from "./terminal-kind.js";
```

In the `SessionEvent` interface, add after `todos?`:

```ts
  /** Terminal host, present only on the SessionStart line. */
  term?: string;
```

- [ ] **Step 4: Add `terminal` to `DerivedState`**

In the `DerivedState` interface, add after `todos: TodoStatus[];`:

```ts
  /** Which terminal hosts this session (from the SessionStart hook stamp). */
  terminal: TerminalKind;
```

- [ ] **Step 5: Add `terminal` to `ZERO`**

Change the `ZERO` constant so it includes `terminal`:

```ts
const ZERO: ReducerState = { awaiting: false, awaitingPermission: false, awaitingQuestion: false, awaitingPlan: false, errored: false, subagentDepth: 0, todos: [], terminal: "unknown", inTurn: false };
```

- [ ] **Step 6: Stamp `terminal` in the `SessionStart` case**

In `applyEvent`, replace the combined `SessionStart`/`SessionEnd` case:

```ts
    case "SessionStart":
    case "SessionEnd":
      return ZERO;
```

with:

```ts
    case "SessionStart":
      return { ...ZERO, terminal: normaliseTerm(ev.term) };

    case "SessionEnd":
      return ZERO;
```

- [ ] **Step 7: Extract `term` in `parseEventLog`**

In `parseEventLog`, inside the `out.push({ … })` object, add after `todos,`:

```ts
          term: typeof obj.term === "string" ? obj.term : undefined,
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS (all test files).

- [ ] **Step 9: Verify the build**

Run: `pnpm build`
Expected: build succeeds (the `terminal` field is now required on `DerivedState`; `sessions.ts` will fail to compile until Task 4 — so expect a type error in `sessions.ts` here). If `pnpm build` errors **only** in `src/sessions.ts` about a missing `terminal` property, that is expected and fixed in Task 4. Proceed.

- [ ] **Step 10: Commit**

```bash
git add src/session-events.ts src/session-events.test.ts
git commit -m "feat(state): reduce SessionStart term stamp into DerivedState.terminal

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Carry `terminal` through SessionInfo → SlotState

**Files:**
- Modify: `src/sessions.ts`
- Modify: `src/render-loop.ts`
- Modify: `src/slot-action.ts`

- [ ] **Step 1: Add `terminal` to `SessionInfo`**

In `src/sessions.ts`, import the type. The file already imports from `./session-events.js`; add a separate import for the kind near the other imports:

```ts
import type { TerminalKind } from "./terminal-kind.js";
```

In the `SessionInfo` interface, add after `origin: SessionOrigin;`:

```ts
  /** Terminal host (from the event-log SessionStart stamp); drives slot-press focus. */
  terminal: TerminalKind;
```

- [ ] **Step 2: Add `terminal` to the inline default `DerivedState`**

In `readOneSource`, the local `derived` default literal currently reads:

```ts
        let derived: DerivedState = {
          awaiting: false, awaitingPermission: false, awaitingQuestion: false, awaitingPlan: false, errored: false, subagentDepth: 0, todos: [],
        };
```

Add `terminal: "unknown",`:

```ts
        let derived: DerivedState = {
          awaiting: false, awaitingPermission: false, awaitingQuestion: false, awaitingPlan: false, errored: false, subagentDepth: 0, todos: [], terminal: "unknown",
        };
```

- [ ] **Step 3: Populate `terminal` in the `out.push`**

In `readOneSource`'s `out.push({ … })`, add after `origin: src.origin,`:

```ts
          terminal: derived.terminal,
```

- [ ] **Step 4: Set `slotState.terminal` in render-loop**

In `src/render-loop.ts`, after the existing `slotState.origin = entry?.session.origin;` line, add:

```ts
    slotState.terminal = entry?.session.terminal;
```

- [ ] **Step 5: Add `terminal` to `SlotState`**

In `src/slot-action.ts`, import the type near the existing `SessionOrigin` import:

```ts
import type { SessionOrigin } from "./sessions.js";
import type { TerminalKind } from "./terminal-kind.js";
```

In the `SlotState` interface, add after `origin?: SessionOrigin;`:

```ts
  terminal?: TerminalKind;
```

- [ ] **Step 6: Verify the build**

Run: `pnpm build`
Expected: build succeeds (the Task 3 type error in `sessions.ts` is now resolved). No behaviour change yet — `runShortPress` still calls Warp.

- [ ] **Step 7: Run tests (no regression)**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/sessions.ts src/render-loop.ts src/slot-action.ts
git commit -m "feat(state): carry terminal kind through SessionInfo to SlotState

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Extract shared Win32 raise machinery

**Files:**
- Create: `src/win32-raise.ts`
- Modify: `src/warp-focus-win.ts`

This moves the P/Invoke bundle and the PowerShell spawn wrapper out of
`warp-focus-win.ts` verbatim so `vscode-focus-win.ts` can reuse them. No
behaviour change to Warp.

- [ ] **Step 1: Create `src/win32-raise.ts` with the moved code**

Create `src/win32-raise.ts` (the body of `TYPES_GUARD` and `runPowerShell` are
copied verbatim from `warp-focus-win.ts`):

```ts
import { spawnCapture } from "./spawn-capture.js";

/**
 * Add-Type bundle shared by every Win32 window-raise path (Warp, VS Code, …).
 * The guard skips re-Adding when run twice in the same PS host (irrelevant
 * here since each call spawns a fresh process, but cheap insurance).
 *
 * `INPUT` is laid out as a tagged union: the union starts at offset 0 inside
 * `InputUnion` (LayoutKind.Explicit), and the outer struct is Sequential so
 * the type discriminator + union alignment match `sizeof(INPUT)` (40 bytes on
 * x64, 28 on x86 — `Marshal.SizeOf` handles both). `MOUSEINPUT` is wider than
 * `KEYBDINPUT`, so it has to be declared even though only the keyboard variant
 * is used (and only by callers that send keystrokes; raise-only callers ignore
 * `CtrlVk`/`SendInput`).
 */
export const TYPES_GUARD = `if (-not ('W' -as [type])) {
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint t1, uint t2, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion u; }
  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint SendInput(uint n, INPUT[] inputs, int cb);
  public static void CtrlVk(ushort vk) {
    INPUT[] arr = new INPUT[4];
    arr[0].type = 1; arr[0].u.ki.wVk = 0x11;
    arr[1].type = 1; arr[1].u.ki.wVk = vk;
    arr[2].type = 1; arr[2].u.ki.wVk = vk;    arr[2].u.ki.dwFlags = 2;
    arr[3].type = 1; arr[3].u.ki.wVk = 0x11;  arr[3].u.ki.dwFlags = 2;
    SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
}`;

/**
 * Run a self-contained PowerShell script via `-EncodedCommand` (base64 of
 * UTF-16-LE) rather than `-Command -` via stdin. Stdin mode trips the parser
 * on multi-line here-strings (the Add-Type block), silently swallowing the
 * script. EncodedCommand sidesteps all quoting/parsing.
 *
 * `-OutputFormat Text` + `$ProgressPreference=SilentlyContinue` suppress the
 * CLIXML progress wrapper PS otherwise emits the first time it loads modules —
 * the wrapper would push the "OK" marker off the trailing position callers
 * look for. Success is signalled by a line starting with `OK`.
 */
export async function runPowerShell(
  script: string,
  timeoutMs: number,
): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  const wrapped = "$ProgressPreference = 'SilentlyContinue'\n" + script;
  const encoded = Buffer.from(wrapped, "utf16le").toString("base64");

  const r = await spawnCapture(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", encoded],
    { timeoutMs },
  );
  if (r.timedOut) return { ok: false, error: "timeout" };
  if (r.err) return { ok: false, error: `spawn: ${r.err}` };
  const out = r.stdout.trim();
  const err = r.stderr.trim();
  if (r.code !== 0) return { ok: false, error: err || out || `exit-${r.code}` };
  if (out.includes("ERROR:")) return { ok: false, error: out };
  if (/^OK(\s|$)/m.test(out)) return { ok: true, out };
  return { ok: false, error: err ? `stderr: ${err}` : `no-OK-marker: ${out || "(empty)"}` };
}
```

- [ ] **Step 2: Update `warp-focus-win.ts` to import the shared code**

In `src/warp-focus-win.ts`:

1. Change the imports at the top. Current:

```ts
import streamDeck from "@elgato/streamdeck";
import { pickBestPane, readWarpPanes } from "./warp-db.js";
import type { WarpFocusResult } from "./warp-focus.js";
import { spawnCapture } from "./spawn-capture.js";
```

Replace with (drop `spawnCapture`, add the shared imports):

```ts
import streamDeck from "@elgato/streamdeck";
import { pickBestPane, readWarpPanes } from "./warp-db.js";
import type { WarpFocusResult } from "./warp-focus.js";
import { TYPES_GUARD, runPowerShell } from "./win32-raise.js";
```

2. Delete the local `const TYPES_GUARD = …` block (the entire `const TYPES_GUARD` declaration through its closing `` }` ``).

3. Delete the local `async function runPowerShell(…) { … }` definition (the entire function).

Leave `buildScript`, `focusWarpTabOnWin`, and `shortestCycle` untouched — they
now reference the imported `TYPES_GUARD` and `runPowerShell`.

- [ ] **Step 3: Verify the build**

Run: `pnpm build`
Expected: build succeeds. `warp-focus-win.ts` is shorter; no other file changed.

- [ ] **Step 4: Run tests (no regression)**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/win32-raise.ts src/warp-focus-win.ts
git commit -m "refactor(win): extract shared Win32 raise machinery into win32-raise.ts

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

> Manual check (Windows, when convenient): after `pnpm sd:reload`, press a slot
> for a Warp-hosted session and confirm the Warp tab still focuses. The refactor
> is behaviour-preserving; this is a smoke test, not a blocker for later tasks.

---

## Task 6: VS Code focus backends + dispatcher

**Files:**
- Create: `src/vscode-focus.ts`
- Create: `src/vscode-focus-win.ts`
- Create: `src/vscode-focus-mac.ts`

These depend on `FocusResult`, which is defined in Task 7. To keep this task
buildable on its own, the backends import the type from `./terminal-focus.js`
and Task 7 creates that file. **Do Task 6 and Task 7 in order, but commit them
together** (build only succeeds once both exist). If you prefer a clean build at
every commit, do Task 7 Step 1 (create `terminal-focus.ts` with just the
`FocusResult` type) before this task, then finish Task 7 afterward.

- [ ] **Step 1: Create the platform dispatcher**

Create `src/vscode-focus.ts`:

```ts
import { platform } from "node:os";
import type { SessionOrigin } from "./sessions.js";
import type { FocusResult } from "./terminal-focus.js";
import { focusVscodeWindowOnWin } from "./vscode-focus-win.js";
import { focusVscodeWindowOnMac } from "./vscode-focus-mac.js";

/**
 * Best-effort: bring the VS Code window whose workspace matches `cwd` to the
 * foreground. Window-level only (no integrated-terminal-tab precision — VS Code
 * exposes no public cwd→tab map). Silent no-op on unsupported platforms.
 */
export async function focusVscodeWindowForCwd(
  cwd: string,
  origin: SessionOrigin,
): Promise<FocusResult> {
  switch (platform()) {
    case "darwin":
      return focusVscodeWindowOnMac(cwd, origin);
    case "win32":
      return focusVscodeWindowOnWin(cwd, origin);
    default:
      return { matched: false, reason: "unsupported-platform" };
  }
}
```

- [ ] **Step 2: Create the Windows backend**

Create `src/vscode-focus-win.ts`:

```ts
import streamDeck from "@elgato/streamdeck";
import type { SessionOrigin } from "./sessions.js";
import type { FocusResult } from "./terminal-focus.js";
import { pickBestWindow } from "./vscode-window-match.js";
import { TYPES_GUARD, runPowerShell } from "./win32-raise.js";

interface WinWindow {
  hwnd: string;
  title: string;
}

/**
 * Raise the VS Code window matching `cwd` on Windows.
 *
 * Two PowerShell calls: one to enumerate VS Code windows (HWND + title), one to
 * raise the chosen HWND. The raise reuses the AttachThreadInput dance from the
 * Warp path — the plugin runs as a Stream Deck child process and doesn't own
 * the foreground lock when a deck key is pressed, so a bare SetForegroundWindow
 * is refused; attaching our input queue to the current foreground's transfers
 * the lock long enough to raise the target. No keystroke is sent (raise only).
 */
export async function focusVscodeWindowOnWin(
  cwd: string,
  origin: SessionOrigin,
): Promise<FocusResult> {
  const list = await enumerateWindows();
  if (!list.ok) return { matched: false, reason: `enumerate-failed: ${list.error}` };
  if (list.windows.length === 0) return { matched: false, reason: "no-vscode-windows" };

  const best = pickBestWindow(cwd, list.windows, origin);
  if (!best) return { matched: false, reason: `no-match (windows=${list.windows.length})` };

  const raised = await runPowerShell(buildRaiseScript(best.hwnd), 3000);
  if (!raised.ok) return { matched: false, reason: `raise-failed: ${raised.error}` };
  return { matched: true, reason: `raised hwnd=${best.hwnd} title="${best.title}" [${raised.out}]` };
}

/**
 * `Get-Process` over the stable + Insiders process names; only entries with a
 * non-zero MainWindowHandle are actual windows (gpu/utility/ptyHost children
 * have none). Emit `HWND\tTitle` per line; skip blank titles (windowless).
 */
async function enumerateWindows(): Promise<
  { ok: true; windows: WinWindow[] } | { ok: false; error: string }
> {
  const script = `Get-Process Code,'Code - Insiders' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |
  ForEach-Object { "OK`t$($_.MainWindowHandle.ToInt64())`t$($_.MainWindowTitle)" }
Write-Output "OK-END"`;
  const r = await runPowerShell(script, 3000);
  if (!r.ok) return { ok: false, error: r.error };
  const windows: WinWindow[] = [];
  for (const line of r.out.split(/\r?\n/)) {
    const parts = line.split("\t");
    if (parts[0] !== "OK" || parts.length < 3) continue;
    windows.push({ hwnd: parts[1], title: parts.slice(2).join("\t") });
  }
  return { ok: true, windows };
}

/** Raise a known HWND. Mirrors the Warp dance minus the keystroke. */
function buildRaiseScript(hwnd: string): string {
  return `${TYPES_GUARD}
$h = [IntPtr]([int64]${hwnd})
$cur = [W]::GetCurrentThreadId()
$dummy = [uint32]0
$fg = [W]::GetWindowThreadProcessId([W]::GetForegroundWindow(), [ref]$dummy)
$attached = $false
if ($fg -ne $cur) { $attached = [W]::AttachThreadInput($fg, $cur, $true) }
[W]::ShowWindow($h, 9) | Out-Null
[W]::BringWindowToTop($h) | Out-Null
$sfw = [W]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 60
if ($attached) { [W]::AttachThreadInput($fg, $cur, $false) | Out-Null }
Write-Output ("OK attach={0} sfw={1} h={2}" -f $attached, $sfw, $h)
`;
}
```

> Note: `enumerateWindows` prefixes each data row with `OK` so it satisfies
> `runPowerShell`'s `^OK` success check even when zero windows match (the
> trailing `Write-Output "OK-END"` guarantees at least one `OK` line). Rows are
> then filtered on the `OK` prefix; `OK-END` has too few tab fields and is
> skipped.

- [ ] **Step 3: Create the macOS backend**

Create `src/vscode-focus-mac.ts`:

```ts
import type { SessionOrigin } from "./sessions.js";
import type { FocusResult } from "./terminal-focus.js";
import { pickBestWindow } from "./vscode-window-match.js";
import { spawnCapture } from "./spawn-capture.js";

/**
 * Raise the VS Code window matching `cwd` on macOS.
 *
 * VS Code exposes an Accessibility tree (unlike Warp), so System Events can
 * enumerate window names and AXRaise a specific one. Two osascript calls:
 * enumerate names, then raise the best match by exact name. Requires Stream
 * Deck.app to hold Accessibility permission (same prompt the Warp path needs).
 *
 * Stable VS Code only ("Code"); Insiders is a documented gap on macOS.
 */
export async function focusVscodeWindowOnMac(
  cwd: string,
  origin: SessionOrigin,
): Promise<FocusResult> {
  const names = await enumerateWindowNames();
  if (!names.ok) return { matched: false, reason: `enumerate-failed: ${names.error}` };
  if (names.titles.length === 0) return { matched: false, reason: "no-vscode-windows" };

  const best = pickBestWindow(cwd, names.titles.map((title) => ({ title })), origin);
  if (!best) return { matched: false, reason: `no-match (windows=${names.titles.length})` };

  const raised = await raiseWindowByName(best.title);
  if (!raised.ok) return { matched: false, reason: `raise-failed: ${raised.error}` };
  return { matched: true, reason: `raised title="${best.title}"` };
}

/** One window name per line via System Events. */
async function enumerateWindowNames(): Promise<
  { ok: true; titles: string[] } | { ok: false; error: string }
> {
  const script = `
    tell application "System Events"
      if not (exists process "Code") then return "ERR:not-running"
      set out to ""
      repeat with w in windows of process "Code"
        set out to out & (name of w) & linefeed
      end repeat
      return out
    end tell
  `;
  const r = await runOsa(script, 2000);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.out.startsWith("ERR:")) return r.out === "ERR:not-running"
    ? { ok: true, titles: [] }
    : { ok: false, error: r.out };
  const titles = r.out.split("\n").map((s) => s.trim()).filter(Boolean);
  return { ok: true, titles };
}

/** Activate VS Code and AXRaise the window whose name matches exactly. */
async function raiseWindowByName(name: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `
    tell application "System Events"
      if not (exists process "Code") then return "ERR:not-running"
      tell process "Code"
        set frontmost to true
        try
          set target to (first window whose name is "${escaped}")
          perform action "AXRaise" of target
        on error
          return "ERR:window-gone"
        end try
      end tell
      return "OK"
    end tell
  `;
  const r = await runOsa(script, 2000);
  if (!r.ok) return { ok: false, error: r.error };
  return r.out === "OK" ? { ok: true } : { ok: false, error: r.out };
}

async function runOsa(
  script: string,
  timeoutMs: number,
): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  const r = await spawnCapture("/usr/bin/osascript", ["-e", script], { timeoutMs });
  if (r.timedOut) return { ok: false, error: "timeout" };
  if (r.err) return { ok: false, error: `spawn: ${r.err}` };
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || `exit-${r.code}` };
  return { ok: true, out: r.stdout.trim() };
}
```

- [ ] **Step 4: Build verification deferred to Task 7**

These files import `FocusResult` from `./terminal-focus.js`, created in Task 7.
Do not run `pnpm build` yet — proceed straight to Task 7, which adds that module
and rewires the call site, then build + commit both tasks together.

---

## Task 7: Focus dispatch + slot-press rewire

**Files:**
- Create: `src/terminal-focus.ts`
- Modify: `src/slot-action.ts`
- Modify: `src/warp-focus.ts`

- [ ] **Step 1: Create the dispatch module**

Create `src/terminal-focus.ts`:

```ts
import streamDeck from "@elgato/streamdeck";
import type { SessionOrigin } from "./sessions.js";
import type { TerminalKind } from "./terminal-kind.js";
import { focusWarpTabForCwd } from "./warp-focus.js";
import { focusVscodeWindowForCwd } from "./vscode-focus.js";

/** Outcome of attempting to focus the terminal hosting a session. */
export interface FocusResult {
  matched: boolean;
  reason: string;
}

/**
 * Dispatch the slot-press focus to the right terminal backend, keyed by the
 * terminal kind stamped at SessionStart. Best-effort throughout — the caller
 * always copies the cwd to the clipboard regardless of the result.
 *
 * - warp    → Warp tab focus (reads Warp's sqlite DB, sends a per-tab keystroke)
 * - vscode  → raise the matching VS Code window (title-based, window-level)
 * - iterm   → not implemented yet (placeholder for the next backend)
 * - other   → bare terminal; nothing to raise
 * - unknown → back-compat: try Warp, then VS Code. Covers sessions that started
 *             before the hook stamp existed or where env detection missed.
 */
export async function focusTerminalForSession(opts: {
  cwd: string;
  terminal: TerminalKind;
  origin: SessionOrigin;
}): Promise<FocusResult> {
  const { cwd, terminal, origin } = opts;
  switch (terminal) {
    case "warp":
      return focusWarpTabForCwd(cwd);
    case "vscode":
      return focusVscodeWindowForCwd(cwd, origin);
    case "iterm":
      return { matched: false, reason: "iterm-not-implemented" };
    case "other":
      return { matched: false, reason: "bare-terminal" };
    case "unknown": {
      const warp = await focusWarpTabForCwd(cwd);
      if (warp.matched) return warp;
      streamDeck.logger.info(`focus: unknown terminal, warp miss (${warp.reason}); trying vscode`);
      return focusVscodeWindowForCwd(cwd, origin);
    }
  }
}
```

- [ ] **Step 2: Make `WarpFocusResult` an alias of `FocusResult`**

In `src/warp-focus.ts`, replace the `WarpFocusResult` interface declaration:

```ts
/** Outcome of attempting to focus a Warp tab matching a session's cwd. */
export interface WarpFocusResult {
  matched: boolean;
  reason: string;
}
```

with an alias (keeps every existing `import { WarpFocusResult }` working):

```ts
import type { FocusResult } from "./terminal-focus.js";

/** Back-compat alias — Warp's result is the shared focus-result shape. */
export type WarpFocusResult = FocusResult;
```

(Place the `import type` with the other imports at the top of the file.)

- [ ] **Step 3: Rewire `slot-action.ts` to dispatch**

In `src/slot-action.ts`:

1. Replace the import:

```ts
import { focusWarpTabForCwd } from "./warp-focus.js";
```

with:

```ts
import { focusTerminalForSession } from "./terminal-focus.js";
```

2. In `runShortPress`, replace the focus block. Current:

```ts
    try {
      await copyToClipboard(cwd);
      const res = await focusWarpTabForCwd(cwd);
      streamDeck.logger.info(`warp focus: ${res.reason} for cwd=${cwd}`);
      await ev.action.showOk();
    } catch (err) {
```

with (read `terminal`/`origin` from the slot; clipboard copy stays first and unconditional):

```ts
    try {
      await copyToClipboard(cwd);
      const res = await focusTerminalForSession({
        cwd,
        terminal: slot?.terminal ?? "unknown",
        origin: slot?.origin ?? "wsl",
      });
      streamDeck.logger.info(`focus(${slot?.terminal ?? "unknown"}): ${res.reason} for cwd=${cwd}`);
      await ev.action.showOk();
    } catch (err) {
```

> `slot` is the `SlotState` already fetched at the top of `runShortPress` via
> `this.state.get(ev.action.id)`. The `origin` fallback to `"wsl"` only applies
> to the unknown path on a Linux/dev edge case; on a real press `origin` is
> always set alongside `clipboardPayload`.

- [ ] **Step 4: Verify the build (Tasks 6 + 7 together)**

Run: `pnpm build`
Expected: build succeeds. All new modules resolve; the slot press now dispatches.

- [ ] **Step 5: Run tests**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Validate the plugin bundle**

Run: `pnpm sd:validate`
Expected: manifest + assets validate OK.

- [ ] **Step 7: Commit (Tasks 6 + 7)**

```bash
git add src/vscode-focus.ts src/vscode-focus-win.ts src/vscode-focus-mac.ts src/terminal-focus.ts src/slot-action.ts src/warp-focus.ts
git commit -m "feat(focus): dispatch slot press by terminal kind, add VS Code window raise

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Stamp `term` in the hook scripts

**Files:**
- Modify: `hooks/notification.sh`
- Modify: `hooks/notification.ps1`

- [ ] **Step 1: Stamp `term` in `notification.sh`**

In `hooks/notification.sh`, after the `SessionStart` truncate block (the
`if [ "$EVENT" = "SessionStart" ]; then : > "$TARGET" fi`) and before the
`TS_MS=` line, add:

```sh
# Terminal host, captured once at SessionStart for the focus-on-press feature.
# $TERM_PROGRAM is set by the terminal; VSCODE_* survive tmux/screen overwriting
# TERM_PROGRAM with "tmux". Canonical values mirror src/terminal-kind.ts.
TERM_KIND=""
if [ "$EVENT" = "SessionStart" ]; then
  if [ "${TERM_PROGRAM:-}" = "vscode" ] || [ -n "${VSCODE_PID:-}" ] || [ -n "${VSCODE_GIT_IPC_HANDLE:-}" ]; then
    TERM_KIND="vscode"
  elif [ "${TERM_PROGRAM:-}" = "WarpTerminal" ]; then
    TERM_KIND="warp"
  elif [ "${TERM_PROGRAM:-}" = "iTerm.app" ]; then
    TERM_KIND="iterm"
  else
    TERM_KIND="other"
  fi
fi
```

Then extend the `jq` invocation. Current:

```sh
jq -nc \
  --argjson ts "$TS_MS" \
  --arg event "$EVENT" \
  --arg tool "$TOOL_NAME" \
  --arg notifType "$NOTIF_TYPE" \
  --argjson todos "$TODOS_JSON" \
  '{ts: $ts, event: $event}
   | (if $tool      != ""   then . + {tool:      $tool}      else . end)
   | (if $notifType != ""   then . + {notifType: $notifType} else . end)
   | (if $todos     != null then . + {todos:     $todos}     else . end)' \
  >> "$TARGET"
```

Replace with (adds `--arg term` and a branch):

```sh
jq -nc \
  --argjson ts "$TS_MS" \
  --arg event "$EVENT" \
  --arg tool "$TOOL_NAME" \
  --arg notifType "$NOTIF_TYPE" \
  --arg term "$TERM_KIND" \
  --argjson todos "$TODOS_JSON" \
  '{ts: $ts, event: $event}
   | (if $tool      != ""   then . + {tool:      $tool}      else . end)
   | (if $notifType != ""   then . + {notifType: $notifType} else . end)
   | (if $term      != ""   then . + {term:      $term}      else . end)
   | (if $todos     != null then . + {todos:     $todos}     else . end)' \
  >> "$TARGET"
```

- [ ] **Step 2: Stamp `term` in `notification.ps1`**

In `hooks/notification.ps1`, after the `SessionStart` truncate block
(`if ($eventName -eq 'SessionStart') { Set-Content … }`) and before the
`$ts = …` line, add:

```powershell
# Terminal host, captured once at SessionStart for the focus-on-press feature.
# Canonical values mirror src/terminal-kind.ts.
$termKind = ''
if ($eventName -eq 'SessionStart') {
    if ($env:TERM_PROGRAM -eq 'vscode' -or $env:VSCODE_PID -or $env:VSCODE_GIT_IPC_HANDLE) {
        $termKind = 'vscode'
    } elseif ($env:TERM_PROGRAM -eq 'WarpTerminal') {
        $termKind = 'warp'
    } elseif ($env:TERM_PROGRAM -eq 'iTerm.app') {
        $termKind = 'iterm'
    } else {
        $termKind = 'other'
    }
}
```

Then extend the entry hashtable. Current:

```powershell
$entry = [ordered]@{ ts = $ts; event = $eventName }
if ($toolName)         { $entry.tool      = $toolName }
if ($notifType)        { $entry.notifType = $notifType }
if ($null -ne $todos)  { $entry.todos     = $todos }
```

Replace with (adds the `term` line):

```powershell
$entry = [ordered]@{ ts = $ts; event = $eventName }
if ($toolName)         { $entry.tool      = $toolName }
if ($notifType)        { $entry.notifType = $notifType }
if ($termKind)         { $entry.term      = $termKind }
if ($null -ne $todos)  { $entry.todos     = $todos }
```

- [ ] **Step 3: Verify hook config unchanged**

Run: `pnpm check:hooks`
Expected: no diff — the registered hook *command* is unchanged; only the script
bodies changed.

- [ ] **Step 4: Manually verify the stamp**

In a VS Code integrated terminal (WSL or PowerShell), start a fresh `claude`
session, then inspect the head of its event log:

- WSL: `head -n1 ~/.claude/sessions/*.events.ndjson`
- PowerShell: `Get-Content "$env:USERPROFILE\.claude\sessions\*.events.ndjson" -TotalCount 1`

Expected: the first line is a `SessionStart` entry containing `"term":"vscode"`.
Repeat in Warp → `"term":"warp"`; in a plain terminal → `"term":"other"`.

- [ ] **Step 5: Commit**

```bash
git add hooks/notification.sh hooks/notification.ps1
git commit -m "feat(hook): stamp terminal kind at SessionStart

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: `check-vscode` debug CLI

**Files:**
- Create: `scripts/check-vscode.ts`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Add the `check:vscode` script**

In `package.json` `"scripts"`, add (next to `"check:hooks"`; mirrors the existing
`"drill": "tsx scripts/drill-states.ts"` entry):

```json
"check:vscode": "tsx scripts/check-vscode.ts",
```

- [ ] **Step 2: Write the CLI**

Create `scripts/check-vscode.ts` (a TS file run via `tsx`; mirrors the role of
`scripts/check-warp` and the invocation style of `scripts/drill-states.ts`):

```ts
/**
 * Sanity-check the VS Code focus path: enumerate VS Code windows on this OS and
 * print which one would be chosen for a given cwd.
 *
 *   pnpm check:vscode "/home/julien/dev/foo"        # defaults origin=wsl
 *   pnpm check:vscode "D:\\dev\\foo" windows
 */
import { platform } from "node:os";
import { pickBestWindow } from "../src/vscode-window-match.js";
import type { SessionOrigin } from "../src/sessions.js";

async function main() {
  const cwd = process.argv[2];
  const origin = (process.argv[3] as SessionOrigin) ?? "wsl";
  if (!cwd) {
    console.error('usage: pnpm check:vscode "<cwd>" [wsl|windows]');
    process.exit(2);
  }

  const titles = await enumerate();
  console.log(`platform=${platform()} origin=${origin} windows=${titles.length}`);
  for (const t of titles) console.log(`  • ${t}`);

  const best = pickBestWindow(cwd, titles.map((title) => ({ title })), origin);
  console.log(best ? `\nmatch → "${best.title}"` : "\nmatch → (none)");
}

/** Reuse the same enumeration the runtime backends use, OS-dispatched. */
async function enumerate(): Promise<string[]> {
  if (platform() === "win32") {
    const { execFileSync } = await import("node:child_process");
    const ps = `Get-Process Code,'Code - Insiders' -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |
      ForEach-Object { $_.MainWindowTitle }`;
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf8",
    });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  if (platform() === "darwin") {
    const { execFileSync } = await import("node:child_process");
    const osa = `tell application "System Events"
      if not (exists process "Code") then return ""
      set out to ""
      repeat with w in windows of process "Code"
        set out to out & (name of w) & linefeed
      end repeat
      return out
    end tell`;
    const out = execFileSync("/usr/bin/osascript", ["-e", osa], { encoding: "utf8" });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  console.error(`enumeration not supported on ${platform()}`);
  return [];
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Verify it runs**

Run (with VS Code open on a folder): `pnpm check:vscode "<a folder open in VS Code>"`
Expected: prints the platform, the enumerated window titles, and a `match → …`
line naming the chosen window (or `(none)`).

- [ ] **Step 4: Commit**

```bash
git add package.json scripts/check-vscode.ts
git commit -m "feat(dev): check-vscode CLI to debug the window match path

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Documentation

**Files:**
- Create: `docs/vscode-focus.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Write `docs/vscode-focus.md`**

Create `docs/vscode-focus.md`:

```markdown
# VS Code window focus

Pressing a slot copies the session's `cwd` to the clipboard. If the session was
launched in a **VS Code integrated terminal** (WSL-remote or native), the plugin
also tries to bring the matching VS Code **window** to the foreground —
best-effort, silent on failure. Window-level only: VS Code exposes no public map
from cwd to a specific integrated-terminal tab, so the plugin can't target the
exact terminal pane (that would require a companion VS Code extension).

## How a session is tagged as "VS Code"

A `SessionStart` hook runs inside the session's shell and stamps a `term` field
into `<sid>.events.ndjson` (`{"…","term":"vscode"}`), derived from
`$TERM_PROGRAM` (plus `VSCODE_PID`/`VSCODE_GIT_IPC_HANDLE`, which survive tmux
overwriting `TERM_PROGRAM`). The plugin reduces this into `SessionInfo.terminal`
and dispatches the slot-press focus by kind (`src/terminal-focus.ts`). Sessions
started before the hook existed are tagged `unknown` and fall back to a
Warp-then-VS Code attempt.

## Matching algorithm

`src/vscode-window-match.ts` scores each window title against the cwd:

- the cwd basename present as a title token → strong score;
- additional cwd path components present → tie-break;
- a `[WSL]` marker boosts WSL-origin sessions and penalises Windows-origin ones.

Highest score wins; no positive score → silent give-up (clipboard copy still
happened). Matching is title-based because VS Code's default window title
contains `${rootName}` (+ `[WSL: <distro>]`); a user who reshapes `window.title`
to drop the folder name will defeat the match.

## Windows

Enumerate via `Get-Process Code,'Code - Insiders' | ? MainWindowHandle -ne 0`
(HWND + title). Raise the chosen HWND with the shared Win32 dance
(`src/win32-raise.ts`): `AttachThreadInput` transfers the foreground lock from
whatever app the deck press came from, then `ShowWindow`/`BringWindowToTop`/
`SetForegroundWindow`. No keystroke (raise only). Prereq: none beyond PowerShell.

## macOS

VS Code exposes an Accessibility tree, so System Events enumerates
`name of windows of process "Code"`, then `set frontmost to true` +
`perform action "AXRaise"` on the window matched by exact name. Requires Stream
Deck.app to hold Accessibility permission (the same grant the Warp path needs).
Insiders ("Code - Insiders") is not handled on macOS.

## Failure modes

All silent — clipboard still works, focus is skipped:

| Reason | Log |
|---|---|
| VS Code not running | `no-vscode-windows` |
| No window title matches the cwd | `no-match (windows=N)` |
| Accessibility denied (macOS) | `raise-failed: …` |
| `window.title` stripped of `${rootName}` | `no-match` |

## Debugging

`pnpm check:vscode "<cwd>" [wsl|windows]` dumps the enumerated window titles and
the chosen match without raising anything.
```

- [ ] **Step 2: Update `CLAUDE.md`**

In `CLAUDE.md`, find the section header:

```
### Warp tab focus on slot press (`src/warp-focus*.ts`, `src/warp-db.ts`, `src/warp-cwd.ts`)
```

Replace that heading and its paragraph with:

```markdown
### Terminal focus on slot press (`src/terminal-focus.ts` + per-backend modules)

Pressing a slot key tries to bring the terminal hosting the session forward
(best-effort, no-op when unmatched). `src/terminal-focus.ts` dispatches by the
session's `terminal` kind — stamped at `SessionStart` by the hook from
`$TERM_PROGRAM` and reduced into `SessionInfo.terminal`:

- **warp** → `warp-focus.ts` (macOS AppleScript / Windows Warp sqlite DB +
  Win32 keystroke). See `src/warp-db.ts`, `src/warp-cwd.ts`.
- **vscode** → `vscode-focus.ts`: raise the best-matching VS Code *window*
  (title-based scoring in `vscode-window-match.ts`; Windows enumerates via
  `Get-Process Code` + raises the HWND, macOS via System Events `AXRaise`).
  Window-level only — no integrated-terminal-tab precision.
- **iterm** → placeholder (not implemented).
- **other** → bare terminal, nothing to raise.
- **unknown** → back-compat: try Warp, then VS Code.

The Win32 foreground machinery (P/Invoke bundle + `runPowerShell`) is shared by
the Warp and VS Code Windows backends in `src/win32-raise.ts`. Clipboard
fallback (the session cwd) runs regardless so the user always has something to
paste. `scripts/check-warp/` and `scripts/check-vscode.ts` are CLI sanity-checks
for the two read paths.
```

- [ ] **Step 3: Update `README.md`**

Find the user-visible passage describing the slot key press (it mentions copying
the cwd to the clipboard and focusing the Warp tab). Update it to read:

```markdown
Pressing a session key copies that session's working directory to the clipboard
and, when possible, brings its terminal to the foreground:

- **Warp** — focuses the matching Warp tab (macOS and Windows).
- **VS Code** — raises the VS Code window whose workspace matches the session
  (WSL-remote or native; macOS and Windows). Window-level only — it can't pick
  a specific integrated-terminal tab.

If no match is found, the clipboard copy still happens so you can paste the path.
```

> If `README.md`'s current wording differs, preserve its surrounding structure
> and only swap the focus description for the block above.

- [ ] **Step 4: Verify docs reference real paths**

Run: `pnpm build && pnpm test`
Expected: both succeed (docs-only changes don't affect them; this is a final
guard that nothing in the tree regressed).

- [ ] **Step 5: Commit**

```bash
git add docs/vscode-focus.md CLAUDE.md README.md
git commit -m "docs: document VS Code terminal focus on slot press

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] `pnpm build` succeeds.
- [ ] `pnpm test` passes (terminal-kind, vscode-window-match, session-events).
- [ ] `pnpm sd:validate` passes.
- [ ] `pnpm check:hooks` shows no diff.
- [ ] `pnpm sd:reload`, then manual smoke tests:
  - VS Code native PowerShell terminal → slot press raises that window.
  - VS Code WSL-remote window (`[WSL: <distro>]`) → slot press raises it.
  - macOS VS Code window → slot press raises it (after Accessibility grant).
  - Warp session → still focuses the Warp tab (no regression).
  - Bare terminal session → no focus attempt; clipboard still copies.

---

## Self-review notes (filled in by the planner)

**Spec coverage:** every spec section maps to a task — terminal-kind capture
(Task 8) + type (Task 1); pipeline plumbing (Tasks 3–4); dispatch (Task 7);
VS Code locator + matcher + per-OS backends (Tasks 2, 6); win32-raise refactor
(Task 5); docs + tooling (Tasks 9–10). The spec's "extract the attach/raise
sequence" is intentionally narrowed to extracting `TYPES_GUARD` + `runPowerShell`
only (Task 5), each backend keeping its own short script body — lower risk to the
working Warp path, same DRY win on the heavy P/Invoke bundle.

**Type consistency:** `TerminalKind` (terminal-kind.ts) is used identically in
session-events, sessions, slot-action, terminal-focus. `FocusResult`
(terminal-focus.ts) is the single result shape; `WarpFocusResult` aliases it.
`pickBestWindow<W extends TitledWindow>` is called with `{ hwnd, title }` (win)
and `{ title }` (mac) — both satisfy `TitledWindow`. `focusVscodeWindowForCwd`,
`focusVscodeWindowOnWin`, `focusVscodeWindowOnMac` signatures match their call
sites.

**Build-order caveat:** Task 3 leaves a deliberate transient type error in
`sessions.ts` (resolved in Task 4); Tasks 6 + 7 build and commit together
because the backends import `FocusResult` from the module Task 7 creates. Both
are called out in-task.
```