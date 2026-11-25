import { setTimeout as sleep } from "node:timers/promises";
import { spawnCapture, type CaptureResult } from "./spawn-capture.js";

export interface KillSteps {
  /** Graceful request. Throws only when escalating could not help either. */
  terminate(): Promise<void>;
  /** Forced request. Returns a diagnostic on failure instead of throwing. */
  force(): Promise<string | undefined>;
  /** True only when the process is positively known to be gone. */
  isGone(): Promise<boolean>;
}

export interface KillTiming {
  graceMs: number;
  confirmMs: number;
  pollMs: number;
}

export type Runner = typeof spawnCapture;

export const KILL_TIMING: KillTiming = { graceMs: 2000, confirmMs: 1000, pollMs: 250 };
const SPAWN_TIMEOUT_MS = 5000;

/**
 * Graceful stop, then a forced one if the process outlives the grace period.
 *
 * @returns which request got rid of the process
 * @throws if the graceful request fails for good, or the process survives both
 */
export async function terminateThenForce(
  steps: KillSteps,
  timing: KillTiming = KILL_TIMING,
): Promise<"graceful" | "forced"> {
  await steps.terminate();
  if (await goneWithin(steps, timing.graceMs, timing.pollMs)) return "graceful";
  const failure = await steps.force();
  if (await goneWithin(steps, timing.confirmMs, timing.pollMs)) return "forced";
  throw new Error(`process still alive after forced kill${failure ? ` (${failure})` : ""}`);
}

async function goneWithin(steps: KillSteps, windowMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    if (await steps.isGone()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

/** Process in the plugin's own namespace (macOS / Linux). */
export function nativeSteps(pid: number): KillSteps {
  const signal = (sig: NodeJS.Signals | 0): NodeJS.ErrnoException | undefined => {
    try {
      process.kill(pid, sig);
      return undefined;
    } catch (err) {
      return err as NodeJS.ErrnoException;
    }
  };
  return {
    async terminate() {
      const err = signal("SIGTERM");
      if (err && err.code !== "ESRCH") throw new Error(`SIGTERM ${pid} failed: ${err.code ?? err.message}`);
    },
    async force() {
      return signal("SIGKILL")?.code;
    },
    async isGone() {
      return signal(0)?.code === "ESRCH";
    },
  };
}

function succeeded(r: CaptureResult): boolean {
  return !r.err && !r.timedOut && r.code === 0;
}

function describeFailure(r: CaptureResult): string {
  if (r.timedOut) return "timed out";
  return r.err ?? `exit ${r.code}: ${r.stderr.trim()}`;
}

/** WSL process seen from Windows. */
export function wslSteps(pid: number, distro: string, run: Runner = spawnCapture): KillSteps {
  const bash = (script: string) =>
    run("wsl.exe", ["-d", distro, "--", "bash", "-c", script], { timeoutMs: SPAWN_TIMEOUT_MS });
  // `kill` exits 1 for "no such process" and "not permitted" alike: /proc tells them apart.
  const send = (sig: "TERM" | "KILL") => bash(`kill -${sig} ${pid} || [ ! -d /proc/${pid} ]`);
  return {
    async terminate() {
      const r = await send("TERM");
      if (!succeeded(r)) throw new Error(`wsl kill -TERM ${pid} failed: ${describeFailure(r)}`);
    },
    async force() {
      const r = await send("KILL");
      return succeeded(r) ? undefined : describeFailure(r);
    },
    async isGone() {
      // An explicit marker: a failing wsl.exe must never read as "gone".
      const r = await bash(`if [ -d /proc/${pid} ]; then echo alive; else echo gone; fi`);
      return succeeded(r) && r.stdout.trim() === "gone";
    },
  };
}

/** Windows-native process tree, seen from a Windows host. */
export function windowsSteps(
  pid: number,
  run: Runner = spawnCapture,
  // Signal 0 works on win32 too: instant and unlocalized, unlike tasklist or taskkill.
  isGone: KillSteps["isGone"] = nativeSteps(pid).isGone,
): KillSteps {
  const taskkill = (...extra: string[]) =>
    run("taskkill.exe", ["/PID", String(pid), "/T", ...extra], { timeoutMs: SPAWN_TIMEOUT_MS });
  return {
    async terminate() {
      // Never fatal: without /F, taskkill routinely refuses console processes.
      await taskkill();
    },
    async force() {
      const r = await taskkill("/F");
      return succeeded(r) ? undefined : describeFailure(r);
    },
    isGone,
  };
}
