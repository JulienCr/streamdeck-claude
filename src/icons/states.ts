import {
  awaitingPulse,
  clawdIdleLook,
  emptyDashed,
  errorBolt,
  finishedCheck,
  permissionPulse,
  planPulse,
  questionPulse,
  spinnerArc,
  subagentBranch,
} from "./motifs.js";

type Palette = { bg: string; accent: string; label: string };
type MotifFn = (frame: number, color: string) => string;

interface StateDef {
  palette: Palette;
  /** True if the motif itself uses `frame` (independent of marquee on labels). */
  animated: boolean;
  /** When true, render.ts overlays the accent color on top of `bg` at a frame-driven
   *  opacity, so the whole tile pulses to "full colour" while the user is being
   *  asked to do something — much easier to spot from a distance than the motif
   *  alone. */
  pulseBg: boolean;
  motif: MotifFn;
}

export const STATES = {
  working:       { palette: { bg: "#0f1115", accent: "#fbbf24", label: "#fde68a" }, animated: true,  pulseBg: false, motif: spinnerArc },
  subagent:      { palette: { bg: "#0f1115", accent: "#fbbf24", label: "#fde68a" }, animated: true,  pulseBg: false, motif: subagentBranch },
  idle:          { palette: { bg: "#0f1115", accent: "#3b82f6", label: "#bfdbfe" }, animated: true,  pulseBg: false, motif: clawdIdleLook },
  awaiting:            { palette: { bg: "#1a1208", accent: "#f97316", label: "#fed7aa" }, animated: true,  pulseBg: true,  motif: awaitingPulse },
  awaiting_permission: { palette: { bg: "#1a1308", accent: "#f59e0b", label: "#fde68a" }, animated: true,  pulseBg: true,  motif: permissionPulse },
  awaiting_question:   { palette: { bg: "#08191c", accent: "#06b6d4", label: "#a5f3fc" }, animated: true,  pulseBg: true,  motif: questionPulse },
  awaiting_plan:       { palette: { bg: "#15102a", accent: "#a78bfa", label: "#ddd6fe" }, animated: true,  pulseBg: true,  motif: planPulse },
  error:         { palette: { bg: "#1a0a0a", accent: "#ef4444", label: "#fecaca" }, animated: true,  pulseBg: true,  motif: errorBolt },
  finished:      { palette: { bg: "#0a1410", accent: "#22c55e", label: "#bbf7d0" }, animated: false, pulseBg: false, motif: finishedCheck },
  empty:         { palette: { bg: "#0a0b0e", accent: "#374151", label: "#4b5563" }, animated: false, pulseBg: false, motif: emptyDashed },
} satisfies Record<string, StateDef>;

export type SessionState = keyof typeof STATES;
