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

export function idleArrow(_frame: number, color: string): string {
  return `<path d="M72 32 L72 70 M56 54 L72 72 L88 54" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
<rect x="46" y="80" width="52" height="5" rx="2.5" fill="${color}"/>`;
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
