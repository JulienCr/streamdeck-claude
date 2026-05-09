import streamDeck from "@elgato/streamdeck";
import { isAnimated, renderIcon } from "./icons/index.js";
import type { SlotAction } from "./slot-action.js";
import type { DisplayEntry } from "./state-tracker.js";

/**
 * Walks the ordered action instances and pushes the right SVG onto each key.
 * Per-slot dedup lives in `slotAction.getState(id).lastSvg` — if the SVG is
 * unchanged we skip the setImage call but still refresh the clipboard payload
 * (cwd may have moved underneath us between ticks for the same sessionId).
 */
export async function renderAll(
  slotAction: SlotAction,
  entries: DisplayEntry[],
  frame: number,
): Promise<void> {
  const ordered = slotAction.orderedActions();
  for (let i = 0; i < ordered.length; i++) {
    const action = ordered[i];
    const entry = entries[i];
    const slotIndex = i + 1;
    const state = entry?.state ?? "empty";
    const label = entry?.session.label ?? "";
    const useFrame = isAnimated(state) ? frame : 0;

    const svg = entry
      ? renderIcon({ state, slot: slotIndex, label, frame: useFrame })
      : renderIcon({ state: "empty", slot: slotIndex, label: "", frame: 0 });
    const dataUrl = "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");

    const slotState = slotAction.getState(action.id);
    if (!slotState) continue;
    if (slotState.lastSvg === dataUrl) {
      slotState.clipboardPayload = entry?.session.cwd;
      continue;
    }
    slotState.lastSvg = dataUrl;
    slotState.clipboardPayload = entry?.session.cwd;
    try {
      await action.setImage(dataUrl);
    } catch (err) {
      streamDeck.logger.error(`setImage failed for slot ${slotIndex}`, err);
    }
  }
}
