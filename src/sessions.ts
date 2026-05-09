import { readdir, readFile, stat } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import type { SessionState } from "./icons/index.js";
import { WIN_SESSIONS_DIR, WSL_SESSIONS_DIR, WSL_SESSIONS_DIR_FROM_WIN } from "./env.js";

/** WSL or Windows-native Claude Code session — they live in different folders
 *  with different process namespaces and need different liveness checks. */
export type SessionOrigin = "wsl" | "windows";

export interface SessionSourceDir {
  origin: SessionOrigin;
  path: string;
}

/** Where Claude Code writes per-pid session state. From a Windows-side plugin
 *  we read both the WSL home (over the `\\wsl.localhost\<distro>` UNC) and the
 *  Windows home. From a Linux-side plugin only WSL sessions are visible. */
export const SESSION_SOURCES: SessionSourceDir[] = platform() === "win32"
  ? [
      { origin: "wsl", path: WSL_SESSIONS_DIR_FROM_WIN },
      { origin: "windows", path: WIN_SESSIONS_DIR },
    ]
  : [
      { origin: "wsl", path: WSL_SESSIONS_DIR },
    ];

/** Surface readdir errors to the polling loop so it can log them once. */
export let lastReadError: string | undefined;

/** "Awaiting permission" notify file is considered fresh for this long. */
const NOTIFY_TTL_MS = 60_000;
/** "Awaiting plan approval" file gets more leeway — users sometimes leave plans
 *  un-approved while they read other things, and we explicitly clear the file
 *  on PostToolUse so TTL is just a safety net. */
const PLAN_TTL_MS = 30 * 60_000;

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
  /** Set if a fresh "awaiting permission" notify file exists. */
  awaiting: boolean;
  /** Set if a fresh "awaiting plan approval" notify file exists. */
  awaitingPlan: boolean;
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

        let awaitingPlan = false;
        try {
          const planStat = await stat(join(src.path, `${raw.sessionId}.plan.json`));
          // Plan approval can sit untouched for a long time — be more permissive than notify.
          awaitingPlan = Date.now() - planStat.mtimeMs < PLAN_TTL_MS;
        } catch {
          // no plan file
        }

        out.push({
          pid: raw.pid,
          sessionId: raw.sessionId,
          cwd: raw.cwd,
          label: raw.name?.trim() || basename(raw.cwd),
          startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
          rawStatus: status,
          awaiting,
          awaitingPlan,
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

/** State for the icon, derived from session status + notify/plan presence + liveness.
 *  Priority when idle: plan-approval > permission-prompt > plain idle. */
export function deriveState(s: SessionInfo, alive: boolean): SessionState {
  if (!alive) return "finished";
  if (s.rawStatus === "idle" && s.awaitingPlan) return "awaiting_plan";
  if (s.rawStatus === "idle" && s.awaiting) return "awaiting";
  if (s.rawStatus === "busy") return "working";
  return "idle";
}
