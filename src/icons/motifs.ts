/** Frame count of one motif-animation period. Re-exported from states.ts as the
 *  public name; defined here because the motif functions are its only consumers. */
export const ANIMATION_FRAMES = 12;

export function spinnerArc(frame: number, color: string): string {
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

export function awaitingPulse(frame: number, color: string): string {
  const phase = frame / ANIMATION_FRAMES;
  const t = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  const r = 26 + t * 5;
  const opacity = 0.55 + t * 0.45;
  return `<circle cx="72" cy="60" r="${r.toFixed(1)}" fill="none" stroke="${color}" stroke-width="${(3.5 + t * 1.5).toFixed(1)}" opacity="${opacity.toFixed(2)}"/>
<path d="M62 50 Q62 40 72 40 Q82 40 82 50 Q82 58 75 62 Q72 64 72 70" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round"/>
<circle cx="72" cy="78" r="3" fill="${color}"/>`;
}

export function questionPulse(frame: number, color: string): string {
  // Pulsing speech-bubble with "?" inside, for AskUserQuestion (PreToolUse).
  // Same pulse beat as the rest of the "needs you" family so the four read as
  // a set: orange ? = generic awaiting, amber padlock = permission, cyan bubble
  // = UI question, violet doc = plan approval.
  const phase = frame / ANIMATION_FRAMES;
  const t = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  const opacity = 0.55 + t * 0.45;
  const stroke = (3 + t * 1.5).toFixed(1);
  // Rounded rectangle bubble (44×34) with a small tail pointing down-left,
  // and a "?" glyph centred inside.
  return `<g opacity="${opacity.toFixed(2)}">
<path d="M50 40 H94 a4 4 0 0 1 4 4 V72 a4 4 0 0 1 -4 4 H66 L58 86 L60 76 H54 a4 4 0 0 1 -4 -4 V44 a4 4 0 0 1 4 -4 z" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linejoin="round"/>
</g>
<path d="M64 54 Q64 46 72 46 Q80 46 80 54 Q80 60 74 63 Q72 65 72 69" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round"/>
<circle cx="72" cy="74" r="2.5" fill="${color}"/>`;
}

export function permissionPulse(frame: number, color: string): string {
  // Pulsing padlock for permission_prompt. Same beat as awaitingPulse / planPulse
  // so the three "needs you" states read as a family (orange = elicitation,
  // amber padlock = tool permission, violet doc = plan approval).
  const phase = frame / ANIMATION_FRAMES;
  const t = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  const opacity = 0.55 + t * 0.45;
  const stroke = (3 + t * 1.5).toFixed(1);
  // Shackle (∩) sits above the body; body is a rounded rect; keyhole is a
  // small filled circle with a tapered line beneath, centred at cx=72.
  return `<g opacity="${opacity.toFixed(2)}">
<path d="M60 60 V50 Q60 38 72 38 Q84 38 84 50 V60" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"/>
<rect x="52" y="58" width="40" height="34" rx="4" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linejoin="round"/>
</g>
<circle cx="72" cy="72" r="3.5" fill="${color}"/>
<path d="M72 75 L72 82" stroke="${color}" stroke-width="3.5" stroke-linecap="round"/>`;
}

export function planPulse(frame: number, color: string): string {
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

/** Clawd, the Claude Code mascot, derived from `assets/clawd/clawd-idle-look.svg`
 *  (AGPL-3.0 — see assets/clawd/NOTICE.md). Two channels of life:
 *    - breathe (scaleY 0.98..1 on the upper body, two beats per 12-frame loop)
 *      — driven by `frame`, naturally fits the 1.44 s motif cycle.
 *    - blink (~150 ms every 4 s) — driven by `Date.now()` because that cadence
 *      doesn't divide our 12-frame counter; the 120 ms animation tick is fast
 *      enough to catch the blink window and render-loop dedups between blinks.
 *  `color` is unused — keeping Clawd's native peach preserves the character
 *  while the idle palette drives chrome. */
export function clawdIdleLook(frame: number, _color: string): string {
  const breathePhase = ((frame * 2) % ANIMATION_FRAMES) / ANIMATION_FRAMES;
  const breatheTri = breathePhase < 0.5 ? breathePhase * 2 : (1 - breathePhase) * 2;
  const breatheY = (1 - 0.02 * breatheTri).toFixed(3);
  const blinking = Date.now() % 4000 < 150;
  const eyeScaleY = blinking ? "0.1" : "1";
  const c = "#DE886D";
  return `<g transform="translate(42 16) scale(4)">
<rect x="3" y="15" width="9" height="1" fill="#000" opacity="0.45"/>
<rect x="3" y="12" width="1" height="3" fill="${c}"/>
<rect x="5" y="12" width="1" height="3" fill="${c}"/>
<rect x="9" y="12" width="1" height="3" fill="${c}"/>
<rect x="11" y="12" width="1" height="3" fill="${c}"/>
<g transform="translate(7.5 13) scale(1 ${breatheY}) translate(-7.5 -13)">
<rect x="2" y="6" width="11" height="7" fill="${c}"/>
<rect x="0" y="9" width="2" height="2" fill="${c}"/>
<rect x="13" y="9" width="2" height="2" fill="${c}"/>
<g transform="translate(7.5 9) scale(1 ${eyeScaleY}) translate(-7.5 -9)">
<rect x="4" y="8" width="1" height="2" fill="#000"/>
<rect x="10" y="8" width="1" height="2" fill="#000"/>
</g>
</g>
</g>`;
}

export function finishedCheck(_frame: number, color: string): string {
  return `<circle cx="72" cy="60" r="28" fill="${color}" opacity="0.18"/>
<circle cx="72" cy="60" r="28" fill="none" stroke="${color}" stroke-width="3.5" opacity="0.85"/>
<path d="M58 61 L68 71 L88 51" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`;
}

export function emptyDashed(_frame: number, color: string): string {
  return `<rect x="22" y="34" width="100" height="56" rx="9" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="4 4"/>
<path d="M72 46 L72 78 M56 62 L88 62" stroke="${color}" stroke-width="4.5" stroke-linecap="round"/>`;
}

export function errorBolt(frame: number, color: string): string {
  // Warning triangle with `!` glyph, pulsing in time with awaitingPulse so the
  // family relationship reads as "needs attention" — but the red palette in
  // states.ts makes the urgency unmistakable.
  const phase = frame / ANIMATION_FRAMES;
  const t = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  const opacity = 0.6 + t * 0.4;
  const stroke = (4 + t * 1.5).toFixed(1);
  return `<path d="M72 32 L100 82 a4 4 0 0 1 -3.5 6 H47.5 a4 4 0 0 1 -3.5 -6 Z" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linejoin="round" opacity="${opacity.toFixed(2)}"/>
<rect x="69" y="50" width="6" height="18" rx="2.5" fill="${color}"/>
<circle cx="72" cy="76" r="3.2" fill="${color}"/>`;
}

export function subagentBranch(frame: number, color: string): string {
  // A spinner arc + an orbiting satellite — visually rhymes with `spinnerArc`
  // (same core spin) but the satellite reads as "delegated work running in
  // parallel". Used while a Task tool / subagent is active.
  const cx = 72, cy = 60;
  const mainR = 18;
  const mainStartDeg = (frame * 360) / ANIMATION_FRAMES;
  const mainSweep = 220;
  const mainEndDeg = mainStartDeg + mainSweep;
  const toXY = (r: number, deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)] as const;
  };
  const [mx1, my1] = toXY(mainR, mainStartDeg);
  const [mx2, my2] = toXY(mainR, mainEndDeg);
  const mainLargeArc = mainSweep > 180 ? 1 : 0;
  // Satellite spins twice as fast, opposite direction.
  const satDeg = -(frame * 720) / ANIMATION_FRAMES;
  const orbitR = 30;
  const [sx, sy] = toXY(orbitR, satDeg);
  return `<path d="M ${mx1.toFixed(2)} ${my1.toFixed(2)} A ${mainR} ${mainR} 0 ${mainLargeArc} 1 ${mx2.toFixed(2)} ${my2.toFixed(2)}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round"/>
<circle cx="${sx.toFixed(2)}" cy="${sy.toFixed(2)}" r="5" fill="${color}"/>`;
}
