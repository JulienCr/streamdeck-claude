import { spawn } from "node:child_process";
import { platform } from "node:os";
import type { SessionInfo, SessionOrigin } from "./sessions.js";

/**
 * Returns the subset of sessions whose process is currently running.
 *
 * WSL sessions are checked via `wsl.exe -d Ubuntu -- kill -0`. Windows-native
 * sessions are checked via `tasklist.exe /FI "PID eq <n>"` — those PIDs live
 * in a different process namespace and aren't visible to WSL. Both checks run
 * in parallel.
 *
 * Both spawn paths can be flaky on a busy host (cold-start latency or transient
 * empty output), so we cache the previous good answer per origin and reuse it
 * for up to CACHE_FALLBACK_MS to absorb hiccups without flickering all slots
 * to "finished".
 */

type SpawnResult = { stdout: string; stderr: string; code: number | null; err?: string };

async function spawnCapture(cmd: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", (err) => resolve({ stdout, stderr, code: null, err: err.message }));
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

interface OriginCache {
  lastLive: Set<number>;
  lastLiveAt: number;
}
const CACHE_FALLBACK_MS = 10_000;
const cache: Record<SessionOrigin, OriginCache> = {
  wsl: { lastLive: new Set(), lastLiveAt: 0 },
  windows: { lastLive: new Set(), lastLiveAt: 0 },
};

async function checkWslLive(pids: number[]): Promise<{ live: Set<number>; error?: string; fromCache: boolean }> {
  if (pids.length === 0) return { live: new Set(), fromCache: false };
  const script = pids.map((p) => `kill -0 ${p} 2>/dev/null && echo ${p}`).join("; ");
  const cmd = platform() === "win32" ? "wsl.exe" : "bash";
  const args = platform() === "win32" ? ["-d", "Ubuntu", "--", "bash", "-c", script] : ["-c", script];
  return parseAndCache("wsl", await spawnCapture(cmd, args), pids, parsePidsFromLines);
}

async function checkWindowsLive(pids: number[]): Promise<{ live: Set<number>; error?: string; fromCache: boolean }> {
  if (pids.length === 0) return { live: new Set(), fromCache: false };
  if (platform() !== "win32") {
    // Linux-side plugin can't enumerate Windows processes; assume alive (best-effort).
    return { live: new Set(pids), fromCache: false, error: "windows-liveness skipped on linux host" };
  }
  // tasklist treats multiple `/FI "PID eq <n>"` filters as AND (no row matches
  // multiple PIDs simultaneously), so we can't batch-filter. Cheaper to dump
  // every process once and intersect ourselves than to spawn N processes.
  const all = await spawnCapture("tasklist.exe", ["/NH", "/FO", "CSV"]);
  const result = await parseAndCache("windows", all, pids, parsePidsFromCsv);
  // parseAndCache stored *every* live windows pid in the cache; pare it down
  // to the ones we were actually asked about so the cache stays small.
  const filtered = new Set<number>();
  const candidateSet = new Set(pids);
  for (const p of result.live) if (candidateSet.has(p)) filtered.add(p);
  return { ...result, live: filtered };
}

function parsePidsFromLines(stdout: string): Set<number> {
  const out = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    const n = Number.parseInt(line.trim(), 10);
    if (Number.isInteger(n) && n > 0) out.add(n);
  }
  return out;
}

function parsePidsFromCsv(stdout: string): Set<number> {
  // tasklist CSV row:  "claude.exe","109164","Console","1","443 040 Ko"
  const out = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^"[^"]*","(\d+)"/);
    if (m) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isInteger(n) && n > 0) out.add(n);
    }
  }
  return out;
}

function parseAndCache(
  origin: SessionOrigin,
  result: SpawnResult,
  candidates: number[],
  parser: (stdout: string) => Set<number>,
): { live: Set<number>; error?: string; fromCache: boolean } {
  const slot = cache[origin];

  if (result.err) {
    if (Date.now() - slot.lastLiveAt < CACHE_FALLBACK_MS) {
      return { live: slot.lastLive, fromCache: true, error: `${origin}: spawn ${result.err}` };
    }
    return { live: new Set(), fromCache: false, error: `${origin}: spawn ${result.err}` };
  }

  const live = parser(result.stdout);
  // Empty stdout on a non-empty candidate list is suspicious — bias toward the
  // last good answer if it's recent.
  if (live.size === 0 && slot.lastLive.size > 0 && Date.now() - slot.lastLiveAt < CACHE_FALLBACK_MS) {
    const stillCandidates = new Set<number>();
    for (const p of slot.lastLive) if (candidates.includes(p)) stillCandidates.add(p);
    if (stillCandidates.size > 0) {
      return {
        live: stillCandidates,
        fromCache: true,
        error: `${origin}: empty stdout (code=${result.code} stderr=${result.stderr.trim().slice(0, 80)})`,
      };
    }
  }

  slot.lastLive = live;
  slot.lastLiveAt = Date.now();
  return { live, fromCache: false };
}

export interface LivenessResult {
  /** Set of sessionIds whose process is currently alive. */
  live: Set<string>;
  /** Whether any portion of the answer came from a cached fallback. */
  fromCache: boolean;
  /** Diagnostic when something went wrong. */
  error?: string;
}

export async function filterLiveSessions(sessions: SessionInfo[]): Promise<LivenessResult> {
  const byOrigin: Record<SessionOrigin, number[]> = { wsl: [], windows: [] };
  for (const s of sessions) byOrigin[s.origin].push(s.pid);

  const [wslRes, winRes] = await Promise.all([
    checkWslLive(byOrigin.wsl),
    checkWindowsLive(byOrigin.windows),
  ]);

  const live = new Set<string>();
  for (const s of sessions) {
    const livePids = s.origin === "wsl" ? wslRes.live : winRes.live;
    if (livePids.has(s.pid)) live.add(s.sessionId);
  }

  const errors = [wslRes.error, winRes.error].filter(Boolean) as string[];
  return {
    live,
    fromCache: wslRes.fromCache || winRes.fromCache,
    error: errors.length ? errors.join("; ") : undefined,
  };
}
