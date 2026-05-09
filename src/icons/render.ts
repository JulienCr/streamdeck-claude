import {
  BORDER_INSET,
  BORDER_RADIUS,
  BORDER_SIZE,
  BORDER_STROKE,
  BOTTOM_FONT,
  BOTTOM_LINE1_Y,
  BOTTOM_LINE2_Y,
  TOP_BASELINE,
  TOP_FONT,
  VIEWPORT_W,
} from "./theme.js";
import { approxWidth, splitLabel, textLine, xmlEscape } from "./text.js";
import { STATES, type SessionState } from "./states.js";

export interface IconOptions {
  state: SessionState;
  slot: number;
  label: string;
  /** Animation frame, 0..ANIMATION_FRAMES-1. */
  frame?: number;
  /** Wall-clock ms; used for marquee. Defaults to Date.now() if omitted. */
  now?: number;
}

export function renderIcon({ state, slot, label, frame = 0, now }: IconOptions): string {
  const t = now ?? Date.now();
  const { bg, accent, label: labelColor } = STATES[state].palette;
  const slotText = state === "empty" ? "" : String(slot);
  const isEmpty = state === "empty";
  const { top, line1, line2 } = isEmpty
    ? { top: "free slot", line1: "", line2: "" }
    : splitLabel(label);

  const topLine = textLine({
    text: top,
    baseline: TOP_BASELINE,
    fontSize: TOP_FONT,
    weight: "700",
    color: accent,
    now: t,
    idSuffix: `t${slot}`,
  });

  const line1Svg = line1
    ? textLine({
        text: line1,
        baseline: BOTTOM_LINE1_Y,
        fontSize: BOTTOM_FONT,
        weight: "600",
        color: labelColor,
        now: t,
        idSuffix: `a${slot}`,
      })
    : "";
  const line2Svg = line2
    ? textLine({
        text: line2,
        baseline: BOTTOM_LINE2_Y,
        fontSize: BOTTOM_FONT,
        weight: "600",
        color: labelColor,
        now: t,
        idSuffix: `b${slot}`,
      })
    : "";

  // Slot number badge — inside the safe zone, away from the rounded corner.
  const slotBadge = isEmpty
    ? ""
    : `<text x="128" y="22" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="10" font-weight="700" fill="${accent}" opacity="0.8" text-anchor="end">${xmlEscape(slotText)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" fill="${bg}"/>
<rect x="${BORDER_INSET}" y="${BORDER_INSET}" width="${BORDER_SIZE}" height="${BORDER_SIZE}" rx="${BORDER_RADIUS}" fill="none" stroke="${accent}" stroke-width="${BORDER_STROKE}" stroke-linejoin="round" opacity="${isEmpty ? "0.45" : "0.95"}"/>
${slotBadge}
${topLine}
<g>${STATES[state].motif(frame, accent)}</g>
${line1Svg}
${line2Svg}
</svg>`;
}

/** True when the icon's visual depends on `frame` or `now` and must be re-rendered often. */
export function iconNeedsAnimation(state: SessionState, label: string): boolean {
  if (STATES[state].animated) return true;
  // Marquee may apply to label even on static states.
  const { top, line1, line2 } = state === "empty" ? { top: "free slot", line1: "", line2: "" } : splitLabel(label);
  if (approxWidth(top, TOP_FONT) > VIEWPORT_W) return true;
  if (line1 && approxWidth(line1, BOTTOM_FONT) > VIEWPORT_W) return true;
  if (line2 && approxWidth(line2, BOTTOM_FONT) > VIEWPORT_W) return true;
  return false;
}

/** True when the icon's motif uses `frame` (independent of marquee). */
export const isAnimated = (s: SessionState) => STATES[s].animated;
