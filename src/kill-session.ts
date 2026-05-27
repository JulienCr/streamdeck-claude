import { platform } from "node:os";
import streamDeck from "@elgato/streamdeck";
import type { SessionOrigin } from "./sessions.js";
import { WSL_DISTRO } from "./env.js";
import { spawnCapture } from "./spawn-capture.js";

/** Délai avant d'escalader SIGTERM → SIGKILL si le process refuse de partir. */
const SIGKILL_ESCALATION_MS = 2000;

/**
 * Best-effort : termine le process d'une session Claude Code. SIGTERM d'abord,
 * puis SIGKILL après SIGKILL_ESCALATION_MS s'il est toujours vivant.
 *
 * Dispatch par plateforme (miroir de live-pids.ts). Sur macOS/Linux la session
 * vit dans notre propre namespace de process, donc `process.kill` direct suffit
 * (le tag `origin` y vaut "wsl" mais est sans effet). La branche win32 est
 * dormante sur Mac.
 */
export async function killSession(pid: number, origin: SessionOrigin): Promise<void> {
  if (platform() === "win32") {
    await killWindows(pid, origin);
    return;
  }
  killNative(pid);
}

function killNative(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return; // déjà mort
    streamDeck.logger.warn(`SIGTERM ${pid} failed: ${code ?? String(err)}`);
    return;
  }
  setTimeout(() => {
    try {
      process.kill(pid, 0); // sonde : throw ESRCH si mort
      process.kill(pid, "SIGKILL");
      streamDeck.logger.info(`escalated to SIGKILL for ${pid}`);
    } catch {
      // déjà mort entre-temps — rien à faire
    }
  }, SIGKILL_ESCALATION_MS);
}

async function killWindows(pid: number, origin: SessionOrigin): Promise<void> {
  if (origin === "wsl") {
    await spawnCapture("wsl.exe", ["-d", WSL_DISTRO, "--", "kill", "-TERM", String(pid)]);
    setTimeout(() => {
      void spawnCapture("wsl.exe", ["-d", WSL_DISTRO, "--", "kill", "-KILL", String(pid)]);
    }, SIGKILL_ESCALATION_MS);
    return;
  }
  await spawnCapture("taskkill.exe", ["/PID", String(pid), "/T"]);
  setTimeout(() => {
    void spawnCapture("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
  }, SIGKILL_ESCALATION_MS);
}
