import streamDeck from "@elgato/streamdeck";
import { spawn } from "node:child_process";
import { pickBestPane, readWarpPanes } from "./warp-db.js";
import type { WarpFocusResult } from "./warp-focus.js";

/**
 * Best-effort focus of the Warp tab corresponding to `cwd` on Windows.
 *
 * Warp Windows exposes no IPC for pane focus (no AppleScript equivalent,
 * no URL action verb until upstream issue #8611 ships). Workaround mirrors
 * the macOS path: read Warp's local sqlite DB to map cwd → window/tab
 * index, then raise a Warp window and inject the per-tab keystroke via
 * Win32 `SendInput`.
 *
 * Two Windows-specific quirks vs. macOS:
 *
 * 1. Warp's "Switch to tab N" binding listens for `Ctrl+VK_NUMPAD<n>`, not
 *    top-row digits. `SendKeys` can't distinguish those — only `SendInput`
 *    with the explicit VK code reaches Warp.
 * 2. The plugin runs as a Stream Deck child process. Its thread doesn't
 *    own the foreground lock when a deck key is pressed (some other app
 *    does — Chrome, VS Code, …), so a bare `SetForegroundWindow` is
 *    silently refused. The `AttachThreadInput` trick attaches our thread's
 *    input queue to the current foreground's, transferring the lock long
 *    enough to raise Warp.
 *
 * Implementation: build a self-contained PowerShell script that
 * Add-Types the user32/kernel32 wrappers, picks the first Warp HWND,
 * does the focus dance, and `SendInput`s the keystroke. Spawn one
 * `powershell.exe -NoProfile -Command -` per call. Per-call PS warmup
 * (~150–250 ms) is the dominant cost; the DB read is ~25 ms.
 */
export async function focusWarpTabOnWin(cwd: string): Promise<WarpFocusResult> {
  const db = await readWarpPanes();
  if (!db.ok) return { matched: false, reason: `db-read-failed: ${db.error}` };
  if (db.snapshot.panes.length === 0) return { matched: false, reason: "db-empty" };

  const best = pickBestPane(cwd, db.snapshot.panes);
  if (!best) return { matched: false, reason: `no-match (rows=${db.snapshot.panes.length})` };

  // Multi-window: same limitation as macOS. The first HWND that
  // Get-Process returns wins; if it's the wrong window the user can
  // raise the right one manually and re-press.
  const windowCount = new Set(db.snapshot.panes.map((r) => r.windowId)).size;
  if (windowCount > 1) {
    streamDeck.logger.info(`warp: ${windowCount} windows in DB — first HWND wins`);
  }

  // Tabs 1..9 → Ctrl+VK_NUMPAD<n>. tabIndex is 0-based; VK_NUMPAD1 = 0x61.
  if (best.tabIndex <= 8) {
    const vk = 0x61 + best.tabIndex;
    const sent = await runPowerShell(buildScript({ kind: "single", vk }), 3000);
    if (!sent.ok) return { matched: false, reason: `keystroke-failed: ${sent.error}` };
    return {
      matched: true,
      reason: `Ctrl+Numpad${best.tabIndex + 1} → window=${best.windowId} tab=${best.tabIndex} score=${best.score} pane="${best.paneCwd}" [${sent.out}]`,
    };
  }

  // Tabs 10+ → cycle via Ctrl+PageDown (next) / Ctrl+PageUp (prev).
  const active = db.snapshot.activeTabByWindow.get(best.windowId);
  const total = db.snapshot.tabCountByWindow.get(best.windowId);
  if (active === undefined || total === undefined || total <= 0) {
    return { matched: false, reason: `cycle-needs-active+total (window=${best.windowId} active=${active} total=${total})` };
  }
  const { direction, steps } = shortestCycle(active, best.tabIndex, total);
  if (steps === 0) {
    return { matched: true, reason: `already-on-tab window=${best.windowId} tab=${best.tabIndex}` };
  }
  const vk = direction === "next" ? 0x22 /* VK_NEXT  / PageDown */ : 0x21 /* VK_PRIOR / PageUp */;
  const sent = await runPowerShell(buildScript({ kind: "repeat", vk, steps }), 3000 + steps * 30);
  if (!sent.ok) return { matched: false, reason: `cycle-keystroke-failed: ${sent.error}` };
  return {
    matched: true,
    reason: `cycle ${direction} x${steps} → window=${best.windowId} tab=${best.tabIndex} (from ${active}/${total}) pane="${best.paneCwd}" [${sent.out}]`,
  };
}

/** Pick the shorter direction around a circular tab strip of `total` tabs. */
function shortestCycle(
  from: number,
  to: number,
  total: number,
): { direction: "next" | "prev"; steps: number } {
  if (total <= 0 || from === to) return { direction: "next", steps: 0 };
  const forward = (to - from + total) % total;
  const backward = (from - to + total) % total;
  return forward <= backward
    ? { direction: "next", steps: forward }
    : { direction: "prev", steps: backward };
}

type ScriptSpec =
  | { kind: "single"; vk: number }
  | { kind: "repeat"; vk: number; steps: number };

function buildScript(spec: ScriptSpec): string {
  const action = spec.kind === "single"
    ? `[W]::CtrlVk(${spec.vk})`
    : `for ($i=0; $i -lt ${spec.steps}; $i++) { [W]::CtrlVk(${spec.vk}); Start-Sleep -Milliseconds 20 }`;
  // Stay attached to the foreground thread for the full duration of the
  // raise *and* the keystroke. Detaching before SendInput let Chrome (or
  // whatever was foreground) reclaim focus during the settle sleep, so the
  // injected input landed on the wrong window. Combine three raise APIs
  // (ShowWindow restore, BringWindowToTop, SetForegroundWindow) — each
  // covers a different Windows quirk, and the cost of trying all three is
  // a few µs.
  return `${TYPES_GUARD}
$proc = Get-Process warp -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Output "ERROR: warp-not-running"; exit 1 }
$h = $proc.MainWindowHandle
$cur = [W]::GetCurrentThreadId()
$dummy = [uint32]0
$fg = [W]::GetWindowThreadProcessId([W]::GetForegroundWindow(), [ref]$dummy)
$attached = $false
if ($fg -ne $cur) { $attached = [W]::AttachThreadInput($fg, $cur, $true) }
[W]::ShowWindow($h, 9) | Out-Null
[W]::BringWindowToTop($h) | Out-Null
$sfw = [W]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 80
$fgNow = [W]::GetForegroundWindow()
${action}
Start-Sleep -Milliseconds 30
if ($attached) { [W]::AttachThreadInput($fg, $cur, $false) | Out-Null }
Write-Output ("OK attach={0} sfw={1} fgWasWarp={2} h={3} fgNow={4}" -f $attached, $sfw, ($fgNow -eq $h), $h, $fgNow)
`;
}

/**
 * Add-Type bundle. The guard skips re-Adding when run twice in the same
 * PS host (irrelevant here since each call spawns a fresh process, but
 * cheap insurance if we ever switch to a persistent host).
 *
 * `INPUT` is laid out as a tagged union: the union starts at offset 0
 * inside `InputUnion` (LayoutKind.Explicit), and the outer struct is
 * Sequential so the type discriminator + union alignment match
 * `sizeof(INPUT)` (40 bytes on x64, 28 on x86 — `Marshal.SizeOf`
 * handles both). `MOUSEINPUT` is wider than `KEYBDINPUT`, so it has to
 * be declared even though we only set the keyboard variant.
 */
const TYPES_GUARD = `if (-not ('W' -as [type])) {
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

function runPowerShell(
  script: string,
  timeoutMs: number,
): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  // We pass the script through `-EncodedCommand` (base64 of UTF-16-LE) rather
  // than `-Command -` via stdin. Stdin mode trips up the parser on multi-line
  // here-strings (the Add-Type block above), silently swallowing the script
  // without executing it. EncodedCommand sidesteps all quoting/parsing.
  //
  // `-OutputFormat Text` + `$ProgressPreference=SilentlyContinue` together
  // suppress the CLIXML progress wrapper that `-NonInteractive` otherwise
  // emits the first time PS loads modules — the wrapper would push the "OK"
  // marker off the trailing position our check looks for.
  const wrapped = "$ProgressPreference = 'SilentlyContinue'\n" + script;
  const encoded = Buffer.from(wrapped, "utf16le").toString("base64");

  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", encoded],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, error: "timeout" });
    }, timeoutMs);
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `spawn: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = stdout.trim();
      const err = stderr.trim();
      if (code !== 0) return resolve({ ok: false, error: err || out || `exit-${code}` });
      if (out.includes("ERROR:")) return resolve({ ok: false, error: out });
      // Success line is `OK <trace…>` so we anchor at the start; the trace
      // tail is preserved in `out` and forwarded into the focus-result
      // reason for runtime visibility.
      if (/^OK(\s|$)/m.test(out)) return resolve({ ok: true, out });
      resolve({ ok: false, error: err ? `stderr: ${err}` : `no-OK-marker: ${out || "(empty)"}` });
    });
  });
}
