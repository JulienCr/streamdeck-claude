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
/** "Errored turn" stays visible just long enough to notice, then fades.
 *  Mirrors NOTIFY_TTL_MS — same surface-then-clear cadence. */
const ERROR_TTL_MS = 60_000;
/** "Subagent active" file is explicitly cleared by SubagentStop; TTL is a
 *  safety net for cases where Stop never fires (subagent crash, killed CC). */
const SUBAGENT_TTL_MS = 30 * 60_000;
/** If the session JSON was updated more than this many ms after a notify/plan/
 *  error sidecar was dropped, the sidecar is stale and we ignore it — Claude
 *  has clearly moved on (status flipped, tool ran, etc.) since the wait point.
 *  Catches the case where the matching `Stop`/`PostToolUse` hook didn't run
 *  (timed out, blocked behind another slow hook, CC bug) so the file lingered
 *  for up to its TTL. Grace absorbs clock skew between hook fire and the
 *  status-flip write to the session JSON. */
const SIDECAR_GRACE_MS = 1500;

function sidecarFresh(mtimeMs: number, ttlMs: number, sessionUpdatedAt: number | undefined, now: number): boolean {
  if (now - mtimeMs >= ttlMs) return false;
  if (sessionUpdatedAt !== undefined && mtimeMs < sessionUpdatedAt - SIDECAR_GRACE_MS) return false;
  return true;
}

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
  /** Set if a fresh "errored turn" file exists (StopFailure hook). */
  errored: boolean;
  /** Set if a fresh "subagent active" file exists (SubagentStart hook). */
  subagentActive: boolean;
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
        const now = Date.now();

        let awaiting = false;
        try {
          const notifyStat = await stat(join(src.path, `${raw.sessionId}.notify.json`));
          awaiting = sidecarFresh(notifyStat.mtimeMs, NOTIFY_TTL_MS, raw.updatedAt, now);
        } catch {
          // no notify file
        }

        let awaitingPlan = false;
        try {
          const planStat = await stat(join(src.path, `${raw.sessionId}.plan.json`));
          // Plan approval can sit untouched for a long time — be more permissive than notify.
          awaitingPlan = sidecarFresh(planStat.mtimeMs, PLAN_TTL_MS, raw.updatedAt, now);
        } catch {
          // no plan file
        }

        let errored = false;
        try {
          const errorStat = await stat(join(src.path, `${raw.sessionId}.error.json`));
          errored = sidecarFresh(errorStat.mtimeMs, ERROR_TTL_MS, raw.updatedAt, now);
        } catch {
          // no error file
        }

        // Subagent state intentionally skips the updatedAt staleness check: the
        // session is busy *because* of the subagent, so updatedAt advances past
        // subagent.mtime during normal operation — that would falsely invalidate
        // the active state mid-run. SubagentStop + the safety-net TTL handle it.
        let subagentActive = false;
        try {
          const subagentStat = await stat(join(src.path, `${raw.sessionId}.subagent.json`));
          subagentActive = now - subagentStat.mtimeMs < SUBAGENT_TTL_MS;
        } catch {
          // no subagent file
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
          errored,
          subagentActive,
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

/** State for the icon, derived from session status + sidecar presence + liveness.
 *  Priority: dead > error > plan-approval > permission-prompt > subagent > working > idle.
 *  An errored session may already be back to idle by the time we see the file,
 *  so error wins regardless of busy/idle. */
export function deriveState(s: SessionInfo, alive: boolean): SessionState {
  if (!alive) return "finished";
  if (s.errored) return "error";
  if (s.rawStatus === "idle" && s.awaitingPlan) return "awaiting_plan";
  if (s.rawStatus === "idle" && s.awaiting) return "awaiting";
  if (s.rawStatus === "busy" && s.subagentActive) return "subagent";
  if (s.rawStatus === "busy") return "working";
  return "idle";
}
