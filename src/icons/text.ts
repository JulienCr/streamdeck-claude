import { VIEWPORT_X, VIEWPORT_W } from "./theme.js";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const xmlEscape = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

// Marquee timing.
const MARQUEE_PX_PER_S = 30;       // scroll speed
const MARQUEE_GAP = 28;            // gap between text repeats

/** Approximate rendered width for a proportional sans/mono mix at the given px size. */
export function approxWidth(text: string, fontSize: number): number {
  // Tuned for Segoe UI / system fonts at our weights; close enough for overflow detection.
  return text.length * fontSize * 0.58;
}

/** Splits a project label by `-` or whitespace into (top, line1, line2). */
export function splitLabel(label: string): { top: string; line1: string; line2: string } {
  const tokens = label.split(/[-\s]+/).filter(Boolean);
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
export function textLine(opts: {
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
