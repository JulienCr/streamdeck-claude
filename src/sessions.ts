import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import streamDeck from "@elgato/streamdeck";
import type { SessionState } from "./icons/index.js";
import { WIN_SESSIONS_DIR, WSL_SESSIONS_DIR, WSL_SESSIONS_DIR_FROM_WIN } from "./env.js";
import { parseEventLog, reduceEvents, type DerivedState, type TodoStatus } from "./session-events.js";

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

/** Cache of derived state per event-log path. Re-reading + reducing the NDJSON
 *  every tick is wasteful since the log only grows when a hook fires; gate it
 *  on (mtimeMs, size) so unchanged logs short-circuit. Keyed by full path so
 *  wsl/windows source dirs with the same sessionId don't collide. */
interface EventLogCacheEntry {
  mtimeMs: number;
  size: number;
  derived: DerivedState;
}
const eventLogCache = new Map<string, EventLogCacheEntry>();

interface RawSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  status?: string;
  updatedAt?: number;
  name?: string;
  /** "interactive" | "bg" (Claude Code 2.1.x). Absent sur les anciennes versions. */
  kind?: string;
  /** Pour les bg en attente : ex. "permission prompt". */
  waitingFor?: string;
}

export interface SessionInfo {
  pid: number;
  sessionId: string;
  cwd: string;
  /** Project label = name field if set, else basename(cwd). */
  label: string;
  startedAt: number;
  rawStatus: "busy" | "idle";
  /** Awaiting a generic input notification from the user (elicitation_dialog,
   *  or any in-turn Notification with no/unknown notifType). */
  awaiting: boolean;
  /** Awaiting tool-permission approval (Notification[permission_prompt]). */
  awaitingPermission: boolean;
  /** Awaiting answer to an AskUserQuestion UI prompt (PreToolUse fired but no
   *  matching PostToolUse yet). */
  awaitingQuestion: boolean;
  /** Awaiting plan approval (ExitPlanMode tool used). */
  awaitingPlan: boolean;
  /** Last turn ended with StopFailure and no UserPromptSubmit since. */
  errored: boolean;
  /** At least one subagent currently running. */
  subagentActive: boolean;
  /** Snapshot of the last TodoWrite call's statuses; empty if none seen. */
  todos: TodoStatus[];
  origin: SessionOrigin;
  /** "interactive" par défaut si le json n'a pas de champ `kind`. */
  kind: "interactive" | "bg";
  /** Statut brut NON coercé du json pour les bg (ex. "waiting", "running"). undefined pour interactive ; à ne pas confondre avec rawStatus (coercé "busy"|"idle", inutilisé pour les bg). */
  bgStatus?: string;
  /** `waitingFor` du json pour les bg (ex. "permission prompt"). */
  bgWaitingFor?: string;
  /** mtime logique du json (ms) si le json l'expose. Utilisé pour la liveness des bg (fraîcheur). */
  updatedAt?: number;
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
        const kind: "interactive" | "bg" = raw.kind === "bg" ? "bg" : "interactive";

        let derived: DerivedState = {
          awaiting: false, awaitingPermission: false, awaitingQuestion: false, awaitingPlan: false, errored: false, subagentDepth: 0, todos: [],
        };
        // Un agent bg tourne en headless et ne nourrit pas le pipeline de hooks :
        // son json (status/waitingFor) est la source de vérité. On saute donc
        // entièrement la lecture/réduction de l'event-log pour les bg.
        if (kind !== "bg") {
          const eventsPath = join(src.path, `${raw.sessionId}.events.ndjson`);
          try {
            const st = await stat(eventsPath);
            const cached = eventLogCache.get(eventsPath);
            if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
              derived = cached.derived;
            } else {
              const text = await readFile(eventsPath, "utf8");
              derived = reduceEvents(parseEventLog(text));
              eventLogCache.set(eventsPath, { mtimeMs: st.mtimeMs, size: st.size, derived });
            }
          } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code !== "ENOENT") {
              streamDeck.logger.warn(
                `event-log read failed ${src.origin}/${raw.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            // no event log yet (ENOENT) — defaults are fine; don't cache
          }
        }

        out.push({
          pid: raw.pid,
          sessionId: raw.sessionId,
          cwd: raw.cwd,
          label: raw.name?.trim() || basename(raw.cwd),
          startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
          rawStatus: status,
          kind,
          bgStatus: kind === "bg" ? raw.status : undefined,
          bgWaitingFor: kind === "bg" ? raw.waitingFor : undefined,
          updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : undefined,
          awaiting: derived.awaiting,
          awaitingPermission: derived.awaitingPermission,
          awaitingQuestion: derived.awaitingQuestion,
          awaitingPlan: derived.awaitingPlan,
          errored: derived.errored,
          subagentActive: derived.subagentDepth > 0,
          todos: derived.todos,
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
  const sessions = results.flat();
  // Prune cache entries whose session is gone (SessionEnd unlinked the log, or
  // the .json disappeared) so the map stays bounded by live-session count.
  const expected = new Set<string>();
  for (const s of sessions) {
    const src = SESSION_SOURCES.find((d) => d.origin === s.origin);
    if (src) expected.add(join(src.path, `${s.sessionId}.events.ndjson`));
  }
  for (const key of eventLogCache.keys()) {
    if (!expected.has(key)) eventLogCache.delete(key);
  }
  return sessions;
}

/** Unlinks one `<sid>.events.ndjson` from the source dir matching `origin`.
 *  Idempotent (ENOENT counts as success) so a long-press reset on a slot whose
 *  agent hasn't emitted anything yet still feels like it "worked". */
export async function wipeSessionEventLog(
  sessionId: string,
  origin: SessionOrigin,
): Promise<{ wiped: boolean; error?: string }> {
  const src = SESSION_SOURCES.find((s) => s.origin === origin);
  if (!src) return { wiped: false, error: `no source for origin=${origin}` };
  try {
    await unlink(join(src.path, `${sessionId}.events.ndjson`));
    return { wiped: true };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { wiped: true };
    return { wiped: false, error: err instanceof Error ? err.message : String(err) };
  }
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
 *  Priority: finished > error > awaiting_plan > awaiting_permission >
 *  awaiting_question > awaiting > subagent > working > idle. Plan approval ranks
 *  first among "needs you" states because users can sit on it longest; the more
 *  specific flags (permission, question) win over the generic catch-all so the
 *  distinct icon shows up. All awaiting* flags win over rawStatus="busy" since
 *  CC keeps the session marked busy while waiting — the event log is the source
 *  of truth for "needs input." Spurious idle-reminder Notifications fired after
 *  Stop are already filtered upstream in reduceEvents via its inTurn guard. */
export function deriveState(s: SessionInfo, alive: boolean): SessionState {
  if (!alive) return "finished";
  if (s.kind === "bg") return deriveBgState(s);
  if (s.errored) return "error";
  if (s.awaitingPlan) return "awaiting_plan";
  if (s.awaitingPermission) return "awaiting_permission";
  if (s.awaitingQuestion) return "awaiting_question";
  if (s.awaiting) return "awaiting";
  if (s.rawStatus === "busy" && s.subagentActive) return "subagent";
  if (s.rawStatus === "busy") return "working";
  return "idle";
}

/** Mappe le json d'un agent bg vers un état bg_*. Table best-effort (un seul
 *  échantillon connu : status="waiting"/waitingFor="permission prompt") ; tout
 *  statut non-terminal inconnu retombe sur bg_idle. Les statuts terminaux sont
 *  déjà filtrés en amont par la liveness (→ finished/retiré), donc absents ici. */
function deriveBgState(s: SessionInfo): SessionState {
  const waitingFor = (s.bgWaitingFor ?? "").toLowerCase();
  if (waitingFor.includes("permission")) return "bg_awaiting_permission";
  const status = (s.bgStatus ?? "").toLowerCase();
  if (status === "waiting") return "bg_awaiting";
  if (status === "busy" || status === "running") return "bg_working";
  return "bg_idle";
}
