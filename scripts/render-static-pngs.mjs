#!/usr/bin/env node
/**
 * Rasterize the manifest's required PNG assets from hand-authored SVG sources.
 * Stream Deck's validator rejects SVG for these specific manifest fields, so we
 * ship PNGs. Run with: pnpm icons:static
 */
import { Resvg } from "@resvg/resvg-js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = resolve(ROOT, "assets/svg");
const OUT = resolve(ROOT, "com.julien.claudesessions.sdPlugin/imgs");

const TARGETS = [
  { svg: "marketplace.svg",        out: "plugin/marketplace.png",         size: 144 },
  { svg: "marketplace.svg",        out: "plugin/marketplace@2x.png",      size: 288 },
  { svg: "category-icon.svg",      out: "plugin/category-icon.png",       size: 28 },
  { svg: "category-icon.svg",      out: "plugin/category-icon@2x.png",    size: 56 },
  { svg: "action-picker-icon.svg", out: "actions/slot/icon.png",          size: 40 },
  { svg: "action-picker-icon.svg", out: "actions/slot/icon@2x.png",       size: 80 },
  { svg: "default-key.svg",        out: "actions/slot/key.png",           size: 144 },
  { svg: "default-key.svg",        out: "actions/slot/key@2x.png",        size: 288 },
  { svg: "setup-action-icon.svg",  out: "actions/setup/icon.png",         size: 40 },
  { svg: "setup-action-icon.svg",  out: "actions/setup/icon@2x.png",      size: 80 },
  { svg: "setup-default-key.svg",  out: "actions/setup/key.png",          size: 144 },
  { svg: "setup-default-key.svg",  out: "actions/setup/key@2x.png",       size: 288 },
];

for (const t of TARGETS) {
  const svg = await readFile(resolve(ASSETS, t.svg), "utf8");
  const png = new Resvg(svg, { fitTo: { mode: "width", value: t.size } }).render().asPng();
  const outPath = resolve(OUT, t.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, png);
  console.log(`  ${relative(ROOT, outPath)} (${t.size}x${t.size})`);
}
