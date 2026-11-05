import { platform } from "node:os";
import { focusWarpTabOnMac } from "./warp-focus-mac.js";
import { focusWarpTabOnWin, openWarpUrlOnWin } from "./warp-focus-win.js";
import { spawnCapture } from "./spawn-capture.js";

/** Outcome of attempting to focus a Warp tab matching a session's cwd. */
export interface WarpFocusResult {
  matched: boolean;
  reason: string;
}

export interface WarpFocusTarget {
  cwd: string;
  /** Validated `warp://session/<uuid>` deep-link; preferred over cwd matching. */
  warpFocusUrl?: string;
}

/**
 * Focus the Warp pane of a session. A deep-link, when known, is exact and
 * fast; on failure (or when absent: older hooks, tmux/ssh) we fall back to
 * the cwd → tab guess. Best-effort: unsupported platforms get a no-op result.
 */
export async function focusWarp({ cwd, warpFocusUrl }: WarpFocusTarget): Promise<WarpFocusResult> {
  let deeplinkError: string | undefined;
  if (warpFocusUrl) {
    const opened = await openWarpUrl(warpFocusUrl);
    if (opened.ok) return { matched: true, reason: `deeplink ${warpFocusUrl}` };
    deeplinkError = opened.error;
  }
  const res = await focusWarpTabForCwd(cwd);
  return deeplinkError === undefined
    ? res
    : { ...res, reason: `deeplink-failed: ${deeplinkError}; ${res.reason}` };
}

async function openWarpUrl(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
  switch (platform()) {
    case "darwin": {
      const r = await spawnCapture("/usr/bin/open", [url], { timeoutMs: 2000 });
      if (r.timedOut) return { ok: false, error: "timeout" };
      if (r.err) return { ok: false, error: `spawn: ${r.err}` };
      if (r.code !== 0) return { ok: false, error: r.stderr.trim() || `exit-${r.code}` };
      return { ok: true };
    }
    case "win32": {
      const r = await openWarpUrlOnWin(url);
      return r.ok ? { ok: true } : r;
    }
    default:
      return { ok: false, error: "unsupported-platform" };
  }
}

/** Platform dispatch for the cwd-based tab guess (SQLite DB / AppleScript). */
export async function focusWarpTabForCwd(cwd: string): Promise<WarpFocusResult> {
  switch (platform()) {
    case "darwin":
      return focusWarpTabOnMac(cwd);
    case "win32":
      return focusWarpTabOnWin(cwd);
    default:
      return { matched: false, reason: "unsupported-platform" };
  }
}
