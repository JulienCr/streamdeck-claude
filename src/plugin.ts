import streamDeck, { LogLevel } from "@elgato/streamdeck";
import { ANIMATION_FRAMES } from "./icons/index.js";
import { SlotAction } from "./slot-action.js";
import { SetupAction } from "./setup-action.js";
import { watchForReload } from "./reload-watcher.js";
import { createStateTracker } from "./state-tracker.js";
import { renderAll } from "./render-loop.js";
import { wipeAllEventLogs, wipeSessionEventLog, type SessionOrigin } from "./sessions.js";
import { killSession } from "./kill-session.js";
import { checkHooks, HOOK_FIX_HINT } from "./hook-check.js";

streamDeck.logger.setLevel(LogLevel.DEBUG);

const POLL_MS = 1000;
const ANIMATION_MS = 120;

const tracker = createStateTracker();
let frame = 0;
let slowTickRunning = false;

async function runSlowTick(): Promise<void> {
  if (slowTickRunning) return;
  slowTickRunning = true;
  try {
    const entries = await tracker.tick(slotAction.orderedActions().length);
    await renderAll(slotAction, entries, frame);
  } catch (err) {
    streamDeck.logger.error("tick failed", err);
  } finally {
    slowTickRunning = false;
  }
}

async function refreshNow() {
  const result = await wipeAllEventLogs();
  if (result.errors.length) {
    streamDeck.logger.warn(`wipeAllEventLogs errors: ${result.errors.join("; ")}`);
  }
  // Force a re-poll + re-render so the user sees the wipe take effect immediately.
  // If a tick is already in flight, the regular interval picks up the change in <1s.
  await runSlowTick();
  return result;
}

async function resetSlot(sessionId: string, origin: SessionOrigin): Promise<void> {
  const r = await wipeSessionEventLog(sessionId, origin);
  if (!r.wiped) {
    streamDeck.logger.warn(`wipeSessionEventLog(${origin}/${sessionId}) failed: ${r.error}`);
    throw new Error(r.error ?? "wipe failed");
  }
  await runSlowTick();
}

async function killSlot(pid: number, sessionId: string, origin: SessionOrigin): Promise<void> {
  streamDeck.logger.info(`kill requested for ${origin}/${sessionId} pid=${pid}`);
  await killSession(pid, origin);
  // Refresh : l'agent passera "finished" puis disparaîtra au tick suivant.
  await runSlowTick();
}

const slotAction = new SlotAction(resetSlot, killSlot);
const setupAction = new SetupAction(refreshNow);

streamDeck.actions.registerAction(slotAction);
streamDeck.actions.registerAction(setupAction);
await streamDeck.connect();

watchForReload({ pollMs: POLL_MS });

setInterval(runSlowTick, POLL_MS);

let animateRunning = false;
setInterval(async () => {
  if (animateRunning) return;
  animateRunning = true;
  frame = (frame + 1) % ANIMATION_FRAMES;
  // Skip render if nothing on screen needs to change frame-to-frame
  // (no animated motif AND no marquee-overflowing label).
  if (!tracker.needsAnimation() && !slotAction.anyKillArming()) {
    animateRunning = false;
    return;
  }
  try {
    await renderAll(slotAction, tracker.getEntries(), frame);
  } catch (err) {
    streamDeck.logger.error("animation render failed", err);
  } finally {
    animateRunning = false;
  }
}, ANIMATION_MS);

streamDeck.logger.info(`claude-sessions plugin started, polling=${POLL_MS}ms anim=${ANIMATION_MS}ms`);

// Surface stale/missing hook registration loudly — otherwise the plugin runs
// fine but renders wrong icons (e.g. a permission padlock that never clears
// because PostToolUse isn't catch-all). The Setup key also badges this.
checkHooks().then(({ ok, problems }) => {
  if (!ok) {
    streamDeck.logger.warn(`hook config check failed — ${HOOK_FIX_HINT}\n  ${problems.join("\n  ")}`);
  }
}).catch((err) => {
  streamDeck.logger.warn(`hook config check threw: ${err instanceof Error ? err.message : String(err)}`);
});
