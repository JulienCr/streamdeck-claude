import { platform } from "node:os";
import streamDeck from "@elgato/streamdeck";
import type { SessionOrigin } from "./sessions.js";
import { WSL_DISTRO } from "./env.js";
import { nativeSteps, terminateThenForce, windowsSteps, wslSteps, type KillSteps } from "./kill-flow.js";

/**
 * Terminates a Claude Code session process, escalating if it will not leave.
 *
 * Dispatches by platform like live-pids.ts: outside win32 the session lives in
 * our own process namespace and `origin` is irrelevant.
 *
 * @throws if the process could not be confirmed gone
 */
export async function killSession(pid: number, origin: SessionOrigin): Promise<void> {
  const outcome = await terminateThenForce(stepsFor(pid, origin));
  if (outcome === "forced") streamDeck.logger.info(`escalated to forced kill for ${pid}`);
}

function stepsFor(pid: number, origin: SessionOrigin): KillSteps {
  if (platform() !== "win32") return nativeSteps(pid);
  return origin === "wsl" ? wslSteps(pid, WSL_DISTRO) : windowsSteps(pid);
}
