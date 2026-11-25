import { platform } from "node:os";
import type { FocusResult } from "./terminal-focus.js";
import { focusWarpTabOnMac } from "./warp-focus-mac.js";
import { focusWarpTabOnWin } from "./warp-focus-win.js";

/** Back-compat alias — Warp's result is the shared focus-result shape. */
export type WarpFocusResult = FocusResult;

/**
 * Dispatch to the platform-specific Warp tab focus implementation. Callers
 * treat the operation as best-effort, so platforms without an implementation
 * (Linux, etc.) get a no-op result rather than an error.
 */
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
