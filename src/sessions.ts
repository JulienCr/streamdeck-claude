import { readdir, readFile, unlink } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import type { SessionState } from "./icons/index.js";
import { WIN_SESSIONS_DIR, WSL_SESSIONS_DIR, WSL_SESSIONS_DIR_FROM_WIN } from "./env.js";
import { parseEventLog, reduceEvents } from "./session-events.js";

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
  /** Awaiting a permission/input notification from the user. */
  awaiting: boolean;
  /** Awaiting plan approval (ExitPlanMode tool used). */
  awaitingPlan: boolean;
  /** Last turn ended with StopFailure and no UserPromptSubmit since. */
  errored: boolean;
  /** At least one subagent currently running. */
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

        let derived = { awaiting: false, awaitingPlan: false, errored: false, subagentDepth: 0 };
        try {
          const text = await readFile(join(src.path, `${raw.sessionId}.events.ndjson`), "utf8");
          derived = reduceEvents(parseEventLog(text));
        } catch {
          // no event log yet — defaults are fine
        }

        out.push({
          pid: raw.pid,
          sessionId: raw.sessionId,
          cwd: raw.cwd,
          label: raw.name?.trim() || basename(raw.cwd),
          startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
          rawStatus: status,
          awaiting: derived.awaiting,
          awaitingPlan: derived.awaitingPlan,
          errored: derived.errored,
          subagentActive: derived.subagentDepth > 0,
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

/** Unlinks every `<sid>.events.ndjson` across all configured source dirs.
 *  Safe to call any time: hooks just recreate the files on the next event.
 *  Used by the Setup action to force every slot back to a clean idle state. */
export async function wipeAllEventLogs(): Promise<{ wiped: number; errors: string[] }> {
  let wiped = 0;
  const errors: string[] = [];
  await Promise.all(
    SESSION_SOURCES.map(async (src) => {
      let entries: string[];
      try {
        entries = await readdir(src.path);
      } catch (err) {
        errors.push(`${src.origin}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      const targets = entries.filter((f) => f.endsWith(".events.ndjson"));
      await Promise.all(
        targets.map(async (f) => {
          try {
            await unlink(join(src.path, f));
            wiped++;
          } catch (err) {
            errors.push(`${src.origin}/${f}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }),
      );
    }),
  );
  return { wiped, errors };
}

/** State for the icon, derived from session status + event-log projection + liveness.
 *  Priority: dead > error > plan-approval > permission-prompt > subagent > working > idle.
 *  An errored session may already be back to idle by the time we see it,
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
