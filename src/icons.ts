const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const xmlEscape = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

export const ANIMATION_FRAMES = 12;

// Layout constants (canvas is 144x144). The Stream Deck button has rounded
// corners (radius ~20px on hardware), so we keep all content inside a safe
// inset and use a matching corner radius for our own border.
const BORDER_INSET = 5;     // outer rect x/y offset
const BORDER_SIZE = 144 - 2 * BORDER_INSET;
const BORDER_RADIUS = 20;
const BORDER_STROKE = 5;    // user requested +2 over previous 3px
const VIEWPORT_X = 10;
const VIEWPORT_W = 144 - 2 * VIEWPORT_X;
const TOP_BASELINE = 30;
const TOP_FONT = 19;
const BOTTOM_LINE1_Y = 100;
const BOTTOM_LINE2_Y = 122;
const BOTTOM_FONT = 17;

// Marquee timing.
const MARQUEE_PX_PER_S = 30;       // scroll speed
const MARQUEE_GAP = 28;            // gap between text repeats

/** Approximate rendered width for a proportional sans/mono mix at the given px size. */
function approxWidth(text: string, fontSize: number): number {
  // Tuned for Segoe UI / system fonts at our weights; close enough for overflow detection.
  return text.length * fontSize * 0.58;
}

/** Splits a project label by `-` into (top, line1, line2). */
export function splitLabel(label: string): { top: string; line1: string; line2: string } {
  const tokens = label.split(/-+/).filter(Boolean);
  if (tokens.length === 0) return { top: label, line1: "", line2: "" };
  const top = tokens[0];
  const rest = tokens.slice(1);
  if (rest.length === 0) return { top, line1: "", line2: "" };
  if (rest.length === 1) return { top, line1: rest[0], line2: "" };
  if (rest.length === 2) return { top, line1: rest[0], line2: rest[1] };
  const mid = Math.ceil(rest.length / 2);
  return {
    top,
    line1: rest.slice(0, mid).join("-"),
    line2: rest.slice(mid).join("-"),
  };
}

/** Returns the SVG fragment for one centered/marqueed line. `idSuffix` must be unique
 *  per call within the same icon (the SVG <clipPath> ids are scoped to that document). */
function textLine(opts: {
  text: string;
  baseline: number;
  fontSize: number;
  weight: string;
  color: string;
  now: number;
  idSuffix: string;
}): string {
  const { text, baseline, fontSize, weight, color, now, idSuffix } = opts;
  if (!text) return "";
  const fontFamily = "-apple-system,Segoe UI,Roboto,sans-serif";
  const w = approxWidth(text, fontSize);
  const fits = w <= VIEWPORT_W;

  if (fits) {
    return `<text x="72" y="${baseline}" font-family="${fontFamily}" font-size="${fontSize}" font-weight="${weight}" fill="${color}" text-anchor="middle">${xmlEscape(text)}</text>`;
  }

  // Marquee: continuous left scroll with gap-padded repeat.
  const stripWidth = w + MARQUEE_GAP;
  const period = (stripWidth / MARQUEE_PX_PER_S) * 1000;
  const offset = ((now % period) / period) * stripWidth;
  const startX = VIEWPORT_X - offset;
  const clipId = `c${idSuffix}`;
  // Vertical clip box covers cap-top to descender.
  const clipY = baseline - Math.round(fontSize * 0.85);
  const clipH = Math.round(fontSize * 1.2);

  return `<defs><clipPath id="${clipId}"><rect x="${VIEWPORT_X}" y="${clipY}" width="${VIEWPORT_W}" height="${clipH}"/></clipPath></defs>
<g clip-path="url(#${clipId})" font-family="${fontFamily}" font-size="${fontSize}" font-weight="${weight}" fill="${color}">
  <text x="${startX.toFixed(2)}" y="${baseline}">${xmlEscape(text)}</text>
  <text x="${(startX + stripWidth).toFixed(2)}" y="${baseline}">${xmlEscape(text)}</text>
</g>`;
}

function spinnerArc(frame: number, color: string): string {
  const cx = 72, cy = 60, r = 22;
  const startDeg = (frame * 360) / ANIMATION_FRAMES;
  const sweep = 240;
  const endDeg = startDeg + sweep;
  const toXY = (deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)] as const;
  };
  const [x1, y1] = toXY(startDeg);
  const [x2, y2] = toXY(endDeg);
  const largeArc = sweep > 180 ? 1 : 0;
  return `<path d="M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round"/>`;
}

function awaitingPulse(frame: number, color: string): string {
  const phase = frame / ANIMATION_FRAMES;
  const t = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  const r = 26 + t * 5;
  const opacity = 0.55 + t * 0.45;
  return `<circle cx="72" cy="60" r="${r.toFixed(1)}" fill="none" stroke="${color}" stroke-width="${(3.5 + t * 1.5).toFixed(1)}" opacity="${opacity.toFixed(2)}"/>
<path d="M62 50 Q62 40 72 40 Q82 40 82 50 Q82 58 75 62 Q72 64 72 70" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round"/>
<circle cx="72" cy="78" r="3" fill="${color}"/>`;
}

function planPulse(frame: number, color: string): string {
  // Pulsing document/clipboard outline with a checklist inside, signalling
  // "approve this plan". Same beat as awaitingPulse so the two read as a
  // matched pair (orange = permission, violet = plan approval).
  const phase = frame / ANIMATION_FRAMES;
  const t = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  const opacity = 0.55 + t * 0.45;
  const stroke = (3 + t * 1.5).toFixed(1);
  // Document body (rounded rect 44x52) with a folded corner.
  return `<g opacity="${opacity.toFixed(2)}">
<path d="M50 38 H86 a4 4 0 0 1 4 4 V82 a4 4 0 0 1 -4 4 H54 a4 4 0 0 1 -4 -4 V42 a4 4 0 0 1 4 -4 z" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linejoin="round"/>
<path d="M82 38 V46 H90" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linejoin="round"/>
</g>
<path d="M58 56 L62 60 L70 52" fill="none" stroke="${color}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
<line x1="58" y1="68" x2="80" y2="68" stroke="${color}" stroke-width="3" stroke-linecap="round" opacity="0.7"/>
<line x1="58" y1="76" x2="76" y2="76" stroke="${color}" stroke-width="3" stroke-linecap="round" opacity="0.5"/>`;
}

function idleArrow(_frame: number, color: string): string {
  return `<path d="M72 32 L72 70 M56 54 L72 72 L88 54" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
<rect x="46" y="80" width="52" height="5" rx="2.5" fill="${color}"/>`;
}

function finishedCheck(_frame: number, color: string): string {
  return `<circle cx="72" cy="60" r="28" fill="${color}" opacity="0.18"/>
<circle cx="72" cy="60" r="28" fill="none" stroke="${color}" stroke-width="3.5" opacity="0.85"/>
<path d="M58 61 L68 71 L88 51" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function emptyDashed(_frame: number, color: string): string {
  return `<rect x="22" y="34" width="100" height="56" rx="9" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="4 4"/>
<path d="M72 46 L72 78 M56 62 L88 62" stroke="${color}" stroke-width="4.5" stroke-linecap="round"/>`;
}

type Palette = { bg: string; accent: string; label: string };
type MotifFn = (frame: number, color: string) => string;

interface StateDef {
  palette: Palette;
  /** True if the motif itself uses `frame` (independent of marquee on labels). */
  animated: boolean;
  motif: MotifFn;
}

export const STATES = {
  working:       { palette: { bg: "#0f1115", accent: "#fbbf24", label: "#fde68a" }, animated: true,  motif: spinnerArc },
  idle:          { palette: { bg: "#0f1115", accent: "#3b82f6", label: "#bfdbfe" }, animated: false, motif: idleArrow },
  awaiting:      { palette: { bg: "#1a1208", accent: "#f97316", label: "#fed7aa" }, animated: true,  motif: awaitingPulse },
  awaiting_plan: { palette: { bg: "#15102a", accent: "#a78bfa", label: "#ddd6fe" }, animated: true,  motif: planPulse },
  finished:      { palette: { bg: "#0a1410", accent: "#22c55e", label: "#bbf7d0" }, animated: false, motif: finishedCheck },
  empty:         { palette: { bg: "#0a0b0e", accent: "#374151", label: "#4b5563" }, animated: false, motif: emptyDashed },
} satisfies Record<string, StateDef>;

export type SessionState = keyof typeof STATES;

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
