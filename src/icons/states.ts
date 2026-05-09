import {
  awaitingPulse,
  emptyDashed,
  finishedCheck,
  idleArrow,
  planPulse,
  spinnerArc,
} from "./motifs.js";

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
