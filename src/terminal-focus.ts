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
 * Dispatch the slot-press focus by the terminal kind stamped at SessionStart.
 * Best-effort: the caller copies the cwd to the clipboard regardless.
 * `unknown` (unstamped or undetected sessions) must keep trying Warp, then VS Code.
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
