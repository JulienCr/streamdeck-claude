import streamDeck, { LogLevel } from "@elgato/streamdeck";
import { ANIMATION_FRAMES } from "./icons/index.js";
import { SlotAction } from "./slot-action.js";
import { watchForReload } from "./reload-watcher.js";
import { createStateTracker } from "./state-tracker.js";
import { renderAll } from "./render-loop.js";

streamDeck.logger.setLevel(LogLevel.DEBUG);

const slotAction = new SlotAction();
streamDeck.actions.registerAction(slotAction);
await streamDeck.connect();

const POLL_MS = 1000;
const ANIMATION_MS = 120;

const tracker = createStateTracker();
let frame = 0;

watchForReload({ pollMs: POLL_MS });

let slowTickRunning = false;
setInterval(async () => {
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
}, POLL_MS);

let animateRunning = false;
setInterval(async () => {
  if (animateRunning) return;
  animateRunning = true;
  frame = (frame + 1) % ANIMATION_FRAMES;
  // Skip render if nothing on screen needs to change frame-to-frame
  // (no animated motif AND no marquee-overflowing label).
  if (!tracker.needsAnimation()) {
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
