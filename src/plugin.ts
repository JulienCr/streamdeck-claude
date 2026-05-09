import streamDeck, { LogLevel } from "@elgato/streamdeck";
import { ANIMATION_FRAMES, iconNeedsAnimation, isAnimated, renderIcon, type SessionState } from "./icons.js";
import { SlotAction } from "./slot-action.js";
import {
  deriveState,
  readAllSessions,
  SESSION_SOURCES,
  lastReadError,
  type SessionInfo,
} from "./sessions.js";
import { filterLiveSessions } from "./live-pids.js";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:os";

streamDeck.logger.setLevel(LogLevel.DEBUG);

/**
 * Self-reload trigger: when the mtime of this file changes, exit the plugin.
 * The Stream Deck app respawns it automatically (faster than quitting + relaunching
 * the whole app, and avoids the WSL `readlink` issue that blocks `streamdeck restart`).
 *
 * Touch with `pnpm sd:reload` from the dev box.
 */
const RELOAD_FILE = platform() === "win32"
  ? `\\\\wsl.localhost\\Ubuntu\\home\\julien\\.claude\\.streamdeck-claude.reload`
  : join(process.env.HOME ?? "/home/julien", ".claude", ".streamdeck-claude.reload");

// Anything newer than this counts as a reload trigger. Captured at process start
// so a fresh file written *after* startup is correctly detected as an event.
const PROCESS_START_MS = Date.now();
let lastReloadMtime = 0;
async function checkReload(): Promise<void> {
  try {
    const s = await stat(RELOAD_FILE);
    // Treat the *first* sighting as a trigger only if the file was modified after we started.
    // Otherwise the plugin would loop on startup if the file exists from a previous reload.
    if (lastReloadMtime === 0) {
      lastReloadMtime = s.mtimeMs;
      if (s.mtimeMs > PROCESS_START_MS) {
        streamDeck.logger.info(
          `reload triggered (file appeared post-start), exiting; mtime=${s.mtimeMs} start=${PROCESS_START_MS}`,
        );
        process.exit(0);
      }
      return;
    }
    if (s.mtimeMs !== lastReloadMtime) {
      streamDeck.logger.info("reload triggered (mtime changed), exiting; SD will respawn");
      process.exit(0);
    }
  } catch {
    // file doesn't exist — fine
  }
}

const slotAction = new SlotAction();
streamDeck.actions.registerAction(slotAction);
await streamDeck.connect();

const POLL_MS = 1000;
const ANIMATION_MS = 120;
const FINISHED_TTL_MS = 3_000;

interface DisplayEntry {
  session: SessionInfo;
  state: SessionState;
  /** When state became "finished"; used to expire the entry after FINISHED_TTL_MS. */
  finishedAt?: number;
}

/** Carry-over map keyed by sessionId so a session stays visible briefly after its process dies. */
const recentlyFinished = new Map<string, DisplayEntry>();
/** Sessions seen alive in the previous tick — used to detect "just died" transitions. */
let prevLiveIds = new Set<string>();
/** Sorted display entries from the last slowTick; consumed by render(). */
let cachedEntries: DisplayEntry[] = [];
let frame = 0;

let lastDiag = "";
function maybeLog(msg: string): void {
  // Avoid spamming the same line every second.
  if (msg !== lastDiag) {
    streamDeck.logger.info(msg);
    lastDiag = msg;
  }
}

async function tick(): Promise<void> {
  const sessions = await readAllSessions();
  const livenessResult = await filterLiveSessions(sessions);
  const live = livenessResult.live;
  const ordered = slotAction.orderedActions();
  const sourceList = SESSION_SOURCES.map((s) => s.origin).join("+");
  maybeLog(
    `tick: sources=${sourceList} sessions=${sessions.length} live=${live.size}` +
      (livenessResult.fromCache ? " (cached)" : "") +
      ` actions=${ordered.length}` +
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
  await render();
}

async function render(): Promise<void> {
  const ordered = slotAction.orderedActions();
  for (let i = 0; i < ordered.length; i++) {
    const action = ordered[i];
    const entry = cachedEntries[i];
    const slotIndex = i + 1;
    const state = entry?.state ?? "empty";
    const label = entry?.session.label ?? "";
    const useFrame = isAnimated(state) ? frame : 0;

    const svg = entry
      ? renderIcon({ state, slot: slotIndex, label, frame: useFrame })
      : renderIcon({ state: "empty", slot: slotIndex, label: "", frame: 0 });
    const dataUrl = "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");

    const slotState = slotAction.getState(action.id);
    if (!slotState) continue;
    if (slotState.lastSvg === dataUrl) {
      slotState.clipboardPayload = entry?.session.cwd;
      continue;
    }
    slotState.lastSvg = dataUrl;
    slotState.clipboardPayload = entry?.session.cwd;
    try {
      await action.setImage(dataUrl);
    } catch (err) {
      streamDeck.logger.error(`setImage failed for slot ${slotIndex}`, err);
    }
  }
}

let slowTickRunning = false;
setInterval(async () => {
  if (slowTickRunning) return;
  slowTickRunning = true;
  try {
    await checkReload();
    await tick();
  } catch (err) {
    streamDeck.logger.error("tick failed", err);
  } finally {
    slowTickRunning = false;
  }
}, POLL_MS);

let animateRunning = false;
setInterval(async () => {
  if (animateRunning) return;
  animateRunning = true;
  frame = (frame + 1) % ANIMATION_FRAMES;
  // Skip render if nothing on screen needs to change frame-to-frame
  // (no animated motif AND no marquee-overflowing label).
  const needs = cachedEntries.some((e) => iconNeedsAnimation(e.state, e.session.label));
  if (!needs) {
    animateRunning = false;
    return;
  }
  try {
    await render();
  } catch (err) {
    streamDeck.logger.error("animation render failed", err);
  } finally {
    animateRunning = false;
  }
}, ANIMATION_MS);

streamDeck.logger.info(`claude-sessions plugin started, polling=${POLL_MS}ms anim=${ANIMATION_MS}ms`);
