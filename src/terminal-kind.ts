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
