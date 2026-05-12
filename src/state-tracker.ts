import streamDeck from "@elgato/streamdeck";
import { iconNeedsAnimation, type SessionState } from "./icons/index.js";
import {
  deriveState,
  readAllSessions,
  SESSION_SOURCES,
  lastReadError,
  type SessionInfo,
} from "./sessions.js";
import { filterLiveSessions } from "./live-pids.js";

const FINISHED_TTL_MS = 3_000;

export interface DisplayEntry {
  session: SessionInfo;
  state: SessionState;
  /** When state became "finished"; used to expire the entry after FINISHED_TTL_MS. */
  finishedAt?: number;
}

/**
 * Owns the cross-tick bookkeeping needed to keep "just died" sessions on screen
 * for FINISHED_TTL_MS after their process exits. Pure given inputs (sessions,
 * live PIDs, now) but mutates its private maps to track transitions.
 */
export function createStateTracker() {
  /** Carry-over map keyed by sessionId so a session stays visible briefly after its process dies. */
  const recentlyFinished = new Map<string, DisplayEntry>();
  /** Sessions seen alive in the previous tick — used to detect "just died" transitions. */
  let prevLiveIds = new Set<string>();
  /** Sorted display entries from the last tick; consumed by render(). */
  let cachedEntries: DisplayEntry[] = [];

  let lastDiag = "";
  function maybeLog(msg: string): void {
    // Avoid spamming the same line every second.
    if (msg !== lastDiag) {
      streamDeck.logger.info(msg);
      lastDiag = msg;
    }
  }

  /**
   * Reads sessions, filters by live PIDs, promotes "just died" into the
   * recently-finished bucket, expires stale carry-overs, and returns the
   * sorted display entries. Also caches the entries internally for
   * `getEntries()` and `needsAnimation()`.
   */
  async function tick(actionCount: number): Promise<DisplayEntry[]> {
    const sessions = await readAllSessions();
    const livenessResult = await filterLiveSessions(sessions);
    const live = livenessResult.live;
    const sourceList = SESSION_SOURCES.map((s) => s.origin).join("+");
    maybeLog(
      `tick: sources=${sourceList} sessions=${sessions.length} live=${live.size}` +
        (livenessResult.fromCache ? " (cached)" : "") +
        ` actions=${actionCount}` +
        (livenessResult.error ? ` livenessError="${livenessResult.error}"` : "") +
        (lastReadError ? ` readError=${lastReadError}` : ""),
    );

    const liveEntries: DisplayEntry[] = sessions
      .filter((s) => live.has(s.sessionId))
      .map((session) => ({ session, state: deriveState(session, true) }));

    // Promote a session into "finished" only if it was alive last tick and is gone now.
    // Stale session files (whose process hasn't been seen alive since we started)
    // are simply ignored — those are junk left over from previous CC runs.
    const liveIds = new Set(liveEntries.map((e) => e.session.sessionId));
    for (const session of sessions) {
      if (prevLiveIds.has(session.sessionId) && !liveIds.has(session.sessionId) && !recentlyFinished.has(session.sessionId)) {
        recentlyFinished.set(session.sessionId, { session, state: "finished", finishedAt: Date.now() });
      }
    }
    for (const [sid, entry] of recentlyFinished) {
      if (liveIds.has(sid) || (entry.finishedAt && Date.now() - entry.finishedAt > FINISHED_TTL_MS)) {
        recentlyFinished.delete(sid);
      }
    }
    prevLiveIds = liveIds;

    cachedEntries = [...liveEntries, ...recentlyFinished.values()].sort(
      (a, b) => a.session.startedAt - b.session.startedAt,
    );
    return cachedEntries;
  }

  function getEntries(): DisplayEntry[] {
    return cachedEntries;
  }

  /**
   * Whether anything on screen needs frame-to-frame redraw (animated motif
   * OR a marquee-overflowing label). Lets the animation loop short-circuit
   * the render call when nothing would actually change.
   */
  function needsAnimation(): boolean {
    return cachedEntries.some((e) => iconNeedsAnimation(e.state, e.session.label, e.session.todos));
  }

  return { tick, getEntries, needsAnimation };
}
