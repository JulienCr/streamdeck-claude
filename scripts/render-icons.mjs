#!/usr/bin/env node
// Re-renders icons/<state>.svg from the same templates the runtime uses.
// Run with:  pnpm icons:render   (which invokes the local `tsx` devDep).
//
// Why tsx? The icons modules use `.js` specifiers for ESM imports (project
// convention) but the underlying files are `.ts`. Node's bare
// --experimental-strip-types loader doesn't rewrite those specifiers, so we
// route through tsx instead. The SVGs already in icons/ are the canonical
// preview, so most users don't need to run this at all — tweak src/icons/*
// and re-run only if the design changes.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outDir = resolve(root, "icons");
mkdirSync(outDir, { recursive: true });

const { renderIcon } = await import(resolve(root, "src/icons/index.ts"));

// Pinned `now` so the rendered SVG is reproducible (marquee offset stays put).
const FROZEN_NOW = 0;

const SAMPLES = [
  { state: "working",       slot: 1, label: "streamdeck-claude-sessions", frame: 3, now: FROZEN_NOW },
  { state: "idle",          slot: 2, label: "wolfgangparis",              frame: 0, now: FROZEN_NOW },
  { state: "awaiting",      slot: 3, label: "ascory-website",             frame: 6, now: FROZEN_NOW },
  { state: "awaiting_plan", slot: 4, label: "publish-streamdeck-claude",  frame: 6, now: FROZEN_NOW },
  { state: "finished",      slot: 5, label: "loadtestvideo",              frame: 0, now: FROZEN_NOW },
  { state: "empty",         slot: 5, label: "",                           frame: 0, now: FROZEN_NOW },
  // Bonus: a long single segment that triggers the marquee on the top line.
  { state: "working",       slot: 1, label: "very-long-singleword-that-overflows", frame: 0, now: FROZEN_NOW },
];

for (const sample of SAMPLES) {
  // Distinguish the "long-name overflow" sample by file name.
  const overflow = sample.label.includes("overflows");
  const filename = overflow ? `${sample.state}-marquee.svg` : `${sample.state}.svg`;
  writeFileSync(resolve(outDir, filename), renderIcon(sample));
  console.log(`wrote icons/${filename}`);
}
