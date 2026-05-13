import { platform } from "node:os";
import { focusWarpTabOnMac } from "./warp-focus-mac.js";

/** Outcome of attempting to focus a Warp tab matching a session's cwd. */
export interface WarpFocusResult {
  matched: boolean;
  reason: string;
}

/**
 * Dispatch to the platform-specific Warp tab focus implementation. Callers
 * treat the operation as best-effort, so platforms without an implementation
 * (Linux, etc.) get a no-op result rather than an error.
 */
export async function focusWarpTabForCwd(cwd: string): Promise<WarpFocusResult> {
  switch (platform()) {
    case "darwin":
      return focusWarpTabOnMac(cwd);
    default:
      return { matched: false, reason: "unsupported-platform" };
  }
}
