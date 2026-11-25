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
