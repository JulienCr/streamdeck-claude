import streamDeck from "@elgato/streamdeck";
import { describeTopPanes, pickBestPane, readWarpPanes } from "./warp-db.js";
import type { WarpFocusResult } from "./warp-focus.js";
import { TYPES_GUARD, runPowerShell } from "./win32-raise.js";

/**
 * Best-effort focus of the Warp tab for `cwd` on Windows (Warp exposes no focus IPC).
 *
 * Warp's "Switch to tab N" binds `Ctrl+VK_NUMPAD<n>`: only `SendInput` with that VK
 * works, not `SendKeys` or top-row digits. A bare `SetForegroundWindow` is silently
 * refused from a Stream Deck child process, hence the `AttachThreadInput` dance.
 */
export async function focusWarpTabOnWin(cwd: string): Promise<WarpFocusResult> {
  const db = await readWarpPanes();
  if (!db.ok) return { matched: false, reason: `db-read-failed: ${db.error}` };
  if (db.snapshot.panes.length === 0) return { matched: false, reason: "db-empty" };

  const best = pickBestPane(cwd, db.snapshot.panes);
  if (!best) {
    const top = describeTopPanes(cwd, db.snapshot.panes);
    return { matched: false, reason: `no-match (rows=${db.snapshot.panes.length}, top=[${top}])` };
  }

  const windowCount = new Set(db.snapshot.panes.map((r) => r.windowId)).size;

  // Tabs 1..9 → Ctrl+VK_NUMPAD<n>. tabIndex is 0-based; VK_NUMPAD1 = 0x61.
  // Absolute binding: lands on tab N regardless of which Warp window the
  // OS raises, so multi-window setups are safe on this path.
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
  // The cycle math uses best.windowId's active_tab_index but the keystroke
  // lands in whichever Warp window the OS raised first. Single-window =
  // guaranteed correct; multi-window = no way to map DB window_id → HWND,
  // so the cycle may target the wrong window's tab strip. We proceed
  // best-effort and flag it in the result so the caller's log carries the
  // ambiguity (see issue: HWND ↔ window_id mapping).
  if (windowCount > 1) {
    streamDeck.logger.warn(
      `warp: ${windowCount} windows in DB and tab>9 — cycle may target wrong window (DB target=${best.windowId})`,
    );
  }
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
  const ambiguity = windowCount > 1 ? " (multi-window: target unverified)" : "";
  return {
    matched: true,
    reason: `cycle ${direction} x${steps} → window=${best.windowId} tab=${best.tabIndex} (from ${active}/${total})${ambiguity} pane="${best.paneCwd}" [${sent.out}]`,
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
