import { platform } from "node:os";
import { spawnCapture } from "./spawn-capture.js";

/**
 * Best-effort activation of the Claude desktop app (`open -a Claude`) on a
 * slot press. macOS only; other platforms get a no-op result. Never throws —
 * a missing app just yields `ok: false` with the `open` error.
 */
export async function activateClaudeDesktop(): Promise<{ ok: boolean; reason: string }> {
  if (platform() !== "darwin") return { ok: false, reason: "unsupported-platform" };
  const r = await spawnCapture("/usr/bin/open", ["-a", "Claude"], { timeoutMs: 3000 });
  if (r.timedOut) return { ok: false, reason: "timeout" };
  if (r.err) return { ok: false, reason: `spawn: ${r.err}` };
  if (r.code !== 0) return { ok: false, reason: r.stderr.trim() || `exit-${r.code}` };
  return { ok: true, reason: "activated" };
}
