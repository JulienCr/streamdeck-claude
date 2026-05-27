import {
  BORDER_INSET,
  BORDER_RADIUS,
  BORDER_SIZE,
  BORDER_STROKE,
  BOTTOM_FONT,
  BOTTOM_LINE1_Y,
  BOTTOM_LINE2_Y,
  MOTIF_DY,
  TOP_BASELINE,
  TOP_FONT,
  VIEWPORT_W,
} from "./theme.js";
import { approxWidth, splitLabel, textLine, xmlEscape } from "./text.js";
import { STATES, type SessionState } from "./states.js";
import { ANIMATION_FRAMES } from "./motifs.js";
import type { TodoStatus } from "../session-events.js";

/** Peak opacity of the accent-on-bg overlay used by `pulseBg` states. */
const PULSE_BG_PEAK = 0.75;
/** How many bg-pulse cycles fit into one motif period. >1 makes the tile flash
 *  faster than the motif beats — reads as "urgent / hurry up". */
const PULSE_BG_SPEED = 2;

export interface IconOptions {
  state: SessionState;
  slot: number;
  label: string;
  /** Animation frame, 0..ANIMATION_FRAMES-1. */
  frame?: number;
  /** Wall-clock ms; used for marquee. Defaults to Date.now() if omitted. */
  now?: number;
  /** TodoWrite snapshot — renders a left-edge progress column when non-empty. */
  todos?: TodoStatus[];
}

// Left-edge progress column geometry. The column sits at x=2..7, outside the
// VIEWPORT_X=10 text band, so it never overlaps marquee'd labels.
const TODO_X = 2;
const TODO_BAND_Y0 = 18;
const TODO_BAND_Y1 = 130;
const TODO_BAND_H = TODO_BAND_Y1 - TODO_BAND_Y0;
const TODO_MAX_W = 5;
const TODO_MIN_W = 2;
const TODO_COLORS: Record<TodoStatus, string> = {
  pending:     "#374151",
  in_progress: "#fbbf24",
  completed:   "#22c55e",
};

function renderTodoColumn(todos: readonly TodoStatus[], frame: number): string {
  if (todos.length === 0) return "";
  // Auto-shrink: pick the largest size that fits N stacked squares in BAND_H.
  // stride = W + gap, with gap = max(1, floor(W/3)).
  let w = TODO_MAX_W;
  for (; w >= TODO_MIN_W; w--) {
    const gap = Math.max(1, Math.floor(w / 3));
    if (todos.length * (w + gap) - gap <= TODO_BAND_H) break;
  }
  const gap = Math.max(1, Math.floor(w / 3));
  const stride = w + gap;
  // In-progress pulse — same triangle wave as motifs/pulseBg so beats align.
  const phase = (frame % ANIMATION_FRAMES) / ANIMATION_FRAMES;
  const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  const pulseOpacity = (0.4 + tri * 0.6).toFixed(3);
  const rects = todos.map((status, i) => {
    const y = TODO_BAND_Y0 + i * stride;
    const fill = TODO_COLORS[status];
    const opacity = status === "in_progress" ? pulseOpacity : "1";
    return `<rect x="${TODO_X}" y="${y}" width="${w}" height="${w}" fill="${fill}" opacity="${opacity}"/>`;
  });
  return rects.join("");
}

function renderSlotBadge(slotText: string, accent: string): string {
  return `<text x="128" y="22" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="10" font-weight="700" fill="${accent}" opacity="0.8" text-anchor="end">${xmlEscape(slotText)}</text>`;
}

export function renderIcon({ state, slot, label, frame = 0, now, todos }: IconOptions): string {
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

  // When there's a single bottom line, drop it to BOTTOM_LINE2_Y so it sits
  // visually anchored to the lower edge instead of floating in the middle gap.
  const singleBottom = line1 && !line2;
  const line1Svg = line1
    ? textLine({
        text: line1,
        baseline: singleBottom ? BOTTOM_LINE2_Y : BOTTOM_LINE1_Y,
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
  const slotBadge = isEmpty ? "" : renderSlotBadge(slotText, accent);

  let pulseOverlay = "";
  if (STATES[state].pulseBg) {
    // Same triangle wave the motifs use (motifs.ts), but ticked PULSE_BG_SPEED×
    // faster so the tile flashes urgently while the motif keeps its calmer beat.
    const phase = ((frame * PULSE_BG_SPEED) % ANIMATION_FRAMES) / ANIMATION_FRAMES;
    const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
    const opacity = (tri * PULSE_BG_PEAK).toFixed(3);
    pulseOverlay = `<rect width="144" height="144" fill="${accent}" opacity="${opacity}"/>`;
  }

  const todoColumn = todos && todos.length > 0 ? renderTodoColumn(todos, frame) : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" fill="${bg}"/>
${pulseOverlay}
<rect x="${BORDER_INSET}" y="${BORDER_INSET}" width="${BORDER_SIZE}" height="${BORDER_SIZE}" rx="${BORDER_RADIUS}" fill="none" stroke="${accent}" stroke-width="${BORDER_STROKE}" stroke-linejoin="round" opacity="${isEmpty ? "0.45" : "0.95"}"/>
${slotBadge}
${topLine}
<g transform="translate(0,${MOTIF_DY})">${STATES[state].motif(frame, accent)}</g>
${line1Svg}
${line2Svg}
${todoColumn}
</svg>`;
}

/** True when the icon's visual depends on `frame` or `now` and must be re-rendered often. */
export function iconNeedsAnimation(state: SessionState, label: string, todos?: readonly TodoStatus[]): boolean {
  if (STATES[state].animated) return true;
  if (todos && todos.some((s) => s === "in_progress")) return true;
  // Marquee may apply to label even on static states.
  const { top, line1, line2 } = state === "empty" ? { top: "free slot", line1: "", line2: "" } : splitLabel(label);
  if (approxWidth(top, TOP_FONT) > VIEWPORT_W) return true;
  if (line1 && approxWidth(line1, BOTTOM_FONT) > VIEWPORT_W) return true;
  if (line2 && approxWidth(line2, BOTTOM_FONT) > VIEWPORT_W) return true;
  return false;
}

/** True when the icon's motif uses `frame` (independent of marquee). */
export const isAnimated = (s: SessionState) => STATES[s].animated;

/** Palette dédiée à l'état "kill en cours d'armement" (hors registre STATES :
 *  ce n'est pas un SessionState, juste un overlay éphémère pendant le hold). */
const KILL_BG = "#1a0606";
const KILL_ACCENT = "#ef4444";

export interface KillArmingOptions {
  slot: number;
  label: string;
  /** 0..1 — fraction du hold écoulée entre LONG_PRESS_MS et KILL_PRESS_MS. */
  progress: number;
  /** Wall-clock ms; used for marquee. Defaults to Date.now() if omitted. */
  now?: number;
}

/** Tile rouge avec un anneau de progression + label "KILL", affichée pendant
 *  que l'utilisateur maintient la touche entre 500ms et 3s. À 1.0 l'anneau est
 *  plein → le kill part. Relâcher avant ramène le slot à son état normal. */
export function renderKillArming({ slot, label, progress, now }: KillArmingOptions): string {
  const t = now ?? Date.now();
  const p = Math.max(0, Math.min(1, progress));
  const cx = 72;
  const cy = 80;
  const r = 28;
  const circ = 2 * Math.PI * r;
  const offset = (circ * (1 - p)).toFixed(2);
  const overlayOpacity = (0.15 + p * 0.45).toFixed(3);
  const { top } = splitLabel(label);
  const topLine = textLine({
    text: top,
    baseline: TOP_BASELINE,
    fontSize: TOP_FONT,
    weight: "700",
    color: KILL_ACCENT,
    now: t,
    idSuffix: `k${slot}`,
  });
  const slotBadge = renderSlotBadge(String(slot), KILL_ACCENT);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" fill="${KILL_BG}"/>
<rect width="144" height="144" fill="${KILL_ACCENT}" opacity="${overlayOpacity}"/>
<rect x="${BORDER_INSET}" y="${BORDER_INSET}" width="${BORDER_SIZE}" height="${BORDER_SIZE}" rx="${BORDER_RADIUS}" fill="none" stroke="${KILL_ACCENT}" stroke-width="${BORDER_STROKE}" stroke-linejoin="round" opacity="0.95"/>
${slotBadge}
${topLine}
<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#3a1414" stroke-width="6"/>
<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${KILL_ACCENT}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${offset}" transform="rotate(-90 ${cx} ${cy})"/>
<text x="${cx}" y="${cy + 6}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="17" font-weight="700" fill="${KILL_ACCENT}" text-anchor="middle">KILL</text>
</svg>`;
}
