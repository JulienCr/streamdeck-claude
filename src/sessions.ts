import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { SessionState } from "./icons.js";

/** WSL or Windows-native Claude Code session — they live in different folders
 *  with different process namespaces and need different liveness checks. */
export type SessionOrigin = "wsl" | "windows";

export interface SessionSourceDir {
  origin: SessionOrigin;
  path: string;
}

/** Where Claude Code writes per-pid session state. From a Windows-side plugin
 *  we read both the WSL home (over the `\\wsl.localhost\Ubuntu` UNC) and the
 *  Windows home. From a Linux-side plugin only WSL sessions are visible. */
export const SESSION_SOURCES: SessionSourceDir[] = platform() === "win32"
  ? [
      { origin: "wsl", path: `\\\\wsl.localhost\\Ubuntu\\home\\julien\\.claude\\sessions` },
      { origin: "windows", path: `C:\\Users\\julie\\.claude\\sessions` },
    ]
  : [
      { origin: "wsl", path: join(homedir(), ".claude", "sessions") },
    ];

/** Surface readdir errors to the polling loop so it can log them once. */
export let lastReadError: string | undefined;

/** "Awaiting permission" notify file is considered fresh for this long. */
const NOTIFY_TTL_MS = 60_000;

interface RawSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  status?: string;
  updatedAt?: number;
  name?: string;
}

export interface SessionInfo {
  pid: number;
  sessionId: string;
  cwd: string;
  /** Project label = name field if set, else basename(cwd). */
  label: string;
  startedAt: number;
  rawStatus: "busy" | "idle";
  awaiting: boolean;
  origin: SessionOrigin;
}

const isPositiveInt = (x: unknown): x is number =>
  typeof x === "number" && Number.isInteger(x) && x > 0;

function basename(p: string): string {
  if (!p) return "";
  // Handle both `/` and `\` since Windows sessions report `D:\dev\foo`.
  const m = p.replace(/[\\/]+$/, "").match(/[^\\/]+$/);
  return m ? m[0] : p;
}

async function readOneSource(src: SessionSourceDir): Promise<SessionInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(src.path);
  } catch (err) {
    lastReadError = `${src.origin}: ${err instanceof Error ? err.message : String(err)}`;
    return [];
  }
  const out: SessionInfo[] = [];
  await Promise.all(
    entries
      .filter((f) => /^\d+\.json$/.test(f))
      .map(async (f) => {
        const path = join(src.path, f);
        let raw: RawSession;
        try {
          raw = JSON.parse(await readFile(path, "utf8"));
        } catch {
          return;
        }
        if (!isPositiveInt(raw.pid) || typeof raw.sessionId !== "string" || typeof raw.cwd !== "string") {
          return;
        }
        const status = raw.status === "busy" ? "busy" : "idle";

        let awaiting = false;
        try {
          const notifyStat = await stat(join(src.path, `${raw.sessionId}.notify.json`));
          awaiting = Date.now() - notifyStat.mtimeMs < NOTIFY_TTL_MS;
        } catch {
          // no notify file
        }

        out.push({
          pid: raw.pid,
          sessionId: raw.sessionId,
          cwd: raw.cwd,
          label: raw.name?.trim() || basename(raw.cwd),
          startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
          rawStatus: status,
          awaiting,
          origin: src.origin,
        });
      }),
  );
  return out;
}

/** Reads every <pid>.json across all configured source directories. Stale
 *  (dead-pid) files are still returned; liveness filtering happens upstream. */
export async function readAllSessions(): Promise<SessionInfo[]> {
  lastReadError = undefined;
  const results = await Promise.all(SESSION_SOURCES.map(readOneSource));
  return results.flat();
}

/** State for the icon, derived from session status + notify presence + liveness. */
export function deriveState(s: SessionInfo, alive: boolean): SessionState {
  if (!alive) return "finished";
  if (s.awaiting && s.rawStatus === "idle") return "awaiting";
  if (s.rawStatus === "busy") return "working";
  return "idle";
}
