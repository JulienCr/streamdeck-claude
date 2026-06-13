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
  // AppleScript string literals don't honour backslash escapes; embed any
  // double-quote in the title via the `quote` keyword instead, e.g.
  // (first window whose name is "foo" & quote & "bar").
  const escaped = name.replace(/"/g, '" & quote & "');
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
