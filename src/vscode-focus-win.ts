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
  ForEach-Object { "OK\`t$($_.MainWindowHandle.ToInt64())\`t$($_.MainWindowTitle)" }
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
