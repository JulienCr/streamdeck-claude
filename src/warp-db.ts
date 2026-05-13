import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { initWarpCwdNormalizer, normalizeWarpCwd } from "./warp-cwd.js";

/**
 * Warp stores per-pane cwd + per-tab/window structure in a sqlite DB under its
 * Group Container. Reading it (read-only, WAL-safe via `sqlite3 -readonly`)
 * lets us recover the `(window_id, tab_index)` for a given cwd — something
 * Warp does not expose via AX (its UI tree is empty to System Events) nor
 * AppleScript (no dictionary).
 *
 * Stable and Preview channels share the schema; we try Stable first.
 */
const WARP_DB_CANDIDATES = [
  join(homedir(), "Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Stable/warp.sqlite"),
  join(homedir(), "Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Preview/warp.sqlite"),
];

export interface WarpPaneRow {
  windowId: number;
  tabIndex: number;
  paneCwd: string;
}

export interface WarpSnapshot {
  panes: WarpPaneRow[];
  /** windowId → current active tab_index (used to compute cycle delta). */
  activeTabByWindow: Map<number, number>;
  /** windowId → total tab count (used to pick shorter cycle direction). */
  tabCountByWindow: Map<number, number>;
}

export type WarpDbResult =
  | { ok: true; snapshot: WarpSnapshot }
  | { ok: false; error: string };

export async function readWarpPanes(): Promise<WarpDbResult> {
  const db = WARP_DB_CANDIDATES.find((p) => existsSync(p));
  if (!db) return { ok: false, error: "warp-db-not-found" };

  // Two result blocks separated by a SECTION marker row, run in one sqlite3
  // invocation. SQL passed as a CLI arg (NOT via stdin) so `-separator $'\t'`
  // applies cleanly — stdin mode would need `.mode tabs` and dot-commands are
  // whitespace-sensitive in ways that bit us before.
  const sql =
    "SELECT 'PANES';" +
    "WITH tabs_ordered AS (" +
    "  SELECT id, window_id," +
    "    ROW_NUMBER() OVER (PARTITION BY window_id ORDER BY id) - 1 AS tab_index" +
    "  FROM tabs" +
    ") " +
    "SELECT t.window_id, t.tab_index, tp.cwd " +
    "FROM terminal_panes tp " +
    "JOIN pane_nodes pn ON pn.id = tp.id " +
    "JOIN tabs_ordered t ON t.id = pn.tab_id " +
    "WHERE tp.cwd IS NOT NULL AND tp.cwd != '' " +
    "ORDER BY t.window_id, t.tab_index;" +
    "SELECT 'WINDOWS';" +
    "SELECT w.id, w.active_tab_index, (SELECT COUNT(*) FROM tabs WHERE window_id = w.id) FROM windows w;";

  return new Promise((resolve) => {
    const child = spawn(
      "/usr/bin/sqlite3",
      ["-readonly", "-separator", "\t", db, sql],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, error: "timeout" });
    }, 1500);
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `spawn: ${err.message}` });
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, error: stderr.trim() || `exit-${code}` });
      try {
        resolve({ ok: true, snapshot: await parseSnapshot(stdout) });
      } catch (err) {
        resolve({ ok: false, error: `parse: ${(err as Error).message}` });
      }
    });
  });
}

async function parseSnapshot(stdout: string): Promise<WarpSnapshot> {
  await initWarpCwdNormalizer();

  const panes: WarpPaneRow[] = [];
  const activeTabByWindow = new Map<number, number>();
  const tabCountByWindow = new Map<number, number>();

  let section: "PANES" | "WINDOWS" | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    if (line === "PANES") { section = "PANES"; continue; }
    if (line === "WINDOWS") { section = "WINDOWS"; continue; }
    const parts = line.split("\t");
    if (section === "PANES" && parts.length >= 3) {
      const w = parseInt(parts[0], 10);
      const t = parseInt(parts[1], 10);
      if (Number.isInteger(w) && Number.isInteger(t)) {
        panes.push({ windowId: w, tabIndex: t, paneCwd: normalizeWarpCwd(parts.slice(2).join("\t")) });
      }
    } else if (section === "WINDOWS" && parts.length >= 3) {
      const w = parseInt(parts[0], 10);
      const a = parseInt(parts[1], 10);
      const c = parseInt(parts[2], 10);
      if (Number.isInteger(w)) {
        if (Number.isInteger(a)) activeTabByWindow.set(w, a);
        if (Number.isInteger(c)) tabCountByWindow.set(w, c);
      }
    }
  }
  return { panes, activeTabByWindow, tabCountByWindow };
}

/**
 * Pick the best (windowId, tabIndex) for the given cwd, by:
 *   1. Exact match — strongest signal.
 *   2. Prefix or parent match — handles `cd <subdir>` drift inside a pane.
 *   3. Token overlap on path components — fuzzy fallback.
 * Returns null if nothing scores > 0 or if the top score is tied across
 * different (window, tab) pairs.
 */
export function pickBestPane(
  cwd: string,
  rows: WarpPaneRow[],
): { windowId: number; tabIndex: number; score: number; paneCwd: string } | null {
  const target = normalize(cwd);
  if (!target) return null;
  const targetTokens = tokenize(target);

  const scored = rows.map((r) => {
    const p = normalize(r.paneCwd);
    let score = 0;
    if (p === target) score = 1000; // exact match wins outright
    else if (p.startsWith(target + "/") || target.startsWith(p + "/")) score = 500;
    else {
      for (const tok of tokenize(p)) if (targetTokens.has(tok)) score++;
    }
    return { row: r, score };
  });

  let top = { score: 0, row: null as WarpPaneRow | null };
  let tied = false;
  for (const s of scored) {
    if (s.score > top.score) {
      top = { score: s.score, row: s.row };
      tied = false;
    } else if (s.score === top.score && s.score > 0) {
      // Tie OK if it's the same (window, tab) seen via multiple panes.
      if (top.row && (s.row.windowId !== top.row.windowId || s.row.tabIndex !== top.row.tabIndex)) {
        tied = true;
      }
    }
  }
  if (!top.row || top.score === 0 || tied) return null;
  return { windowId: top.row.windowId, tabIndex: top.row.tabIndex, score: top.score, paneCwd: top.row.paneCwd };
}

function normalize(p: string): string {
  return p.replace(/\/+$/, "").trim();
}

function tokenize(p: string): Set<string> {
  return new Set(p.toLowerCase().split(/[\/\\\-_.\s:]+/).filter((t) => t.length >= 2));
}
