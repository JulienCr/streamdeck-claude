import streamDeck, {
  action,
  KeyDownEvent,
  KeyUpEvent,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
  type KeyAction,
} from "@elgato/streamdeck";
import { platform } from "node:os";
import type { SessionOrigin } from "./sessions.js";
import { focusWarpTabForCwd } from "./warp-focus.js";
import { spawnCapture } from "./spawn-capture.js";

/** Hold ≥ this long → wipe just this agent's event log (palier 1). */
export const LONG_PRESS_MS = 500;
/** Hold ≥ this long → kill the agent process (palier 2). Le wipe à
 *  LONG_PRESS_MS a déjà eu lieu quand on atteint ce seuil. */
export const KILL_PRESS_MS = 3000;

/** Per-instance state we render onto each key. */
export interface SlotState {
  /** SVG already rendered last tick — used to skip redundant setImage calls. */
  lastSvg?: string;
  /** What we copy to the clipboard when the key is short-pressed. */
  clipboardPayload?: string;
  /** Bound session — used by long-press to wipe just this agent's event log. */
  sessionId?: string;
  origin?: SessionOrigin;
  /** Bound session pid — required to kill the process on a ≥3s hold. */
  pid?: number;
  /** Wall-clock ms du début d'arming (≥LONG_PRESS_MS tenu). undefined = pas en
   *  arming. Lu par le render-loop pour dessiner l'anneau "KILL". */
  killArmingSince?: number;
}

@action({ UUID: "com.julien.claudesessions.slot" })
export class SlotAction extends SingletonAction {
  /** All currently-visible action instances, keyed by their Stream Deck instance id. */
  private readonly instances = new Map<string, KeyAction>();
  /** Per-instance render bookkeeping. */
  private readonly state = new Map<string, SlotState>();
  /** Armed long-press timers. Presence = key is currently held but threshold
   *  not yet reached. Cleared on KeyUp (short press) or when the timer fires. */
  private readonly pressTimers = new Map<string, NodeJS.Timeout>();
  /** Armed kill timers (fire at KILL_PRESS_MS). Same lifecycle as pressTimers. */
  private readonly killTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly resetSlot: (sessionId: string, origin: SessionOrigin) => Promise<void>,
    private readonly killSlot: (pid: number, sessionId: string, origin: SessionOrigin) => Promise<void>,
  ) {
    super();
  }

  override onWillAppear(ev: WillAppearEvent): void | Promise<void> {
    if (!ev.action.isKey()) {
      streamDeck.logger.warn(`willAppear: not a key, id=${ev.action.id}`);
      return;
    }
    this.instances.set(ev.action.id, ev.action);
    this.state.set(ev.action.id, {});
    const c = ev.action.coordinates;
    streamDeck.logger.info(
      `willAppear: id=${ev.action.id} coords=${c ? `(${c.row},${c.column})` : "none"} total=${this.instances.size}`,
    );
  }

  override onWillDisappear(ev: WillDisappearEvent): void | Promise<void> {
    this.instances.delete(ev.action.id);
    this.state.delete(ev.action.id);
    const t = this.pressTimers.get(ev.action.id);
    if (t) {
      clearTimeout(t);
      this.pressTimers.delete(ev.action.id);
    }
    const k = this.killTimers.get(ev.action.id);
    if (k) {
      clearTimeout(k);
      this.killTimers.delete(ev.action.id);
    }
    streamDeck.logger.info(`willDisappear: id=${ev.action.id} total=${this.instances.size}`);
  }

  override onKeyDown(ev: KeyDownEvent): void {
    const slot = this.state.get(ev.action.id);
    if (!slot?.clipboardPayload || !slot.sessionId || !slot.origin || slot.pid === undefined) {
      // Empty slot — keep the "nothing to do here" feedback. No timer armed, so
      // KeyUp is also a no-op.
      void ev.action.showAlert();
      return;
    }
    const id = ev.action.id;
    const sessionId = slot.sessionId;
    const origin = slot.origin;
    const pid = slot.pid;
    const wipeTimer = setTimeout(() => {
      this.pressTimers.delete(id);
      // Palier 1 atteint : wipe le log ET arme le feedback visuel + la fenêtre kill.
      slot.killArmingSince = Date.now();
      void this.runLongPress(ev, sessionId, origin);
    }, LONG_PRESS_MS);
    this.pressTimers.set(id, wipeTimer);
    const killTimer = setTimeout(() => {
      this.killTimers.delete(id);
      slot.killArmingSince = undefined;
      void this.runKill(ev, pid, sessionId, origin);
    }, KILL_PRESS_MS);
    this.killTimers.set(id, killTimer);
  }

  override async onKeyUp(ev: KeyUpEvent): Promise<void> {
    const id = ev.action.id;
    const wipeTimer = this.pressTimers.get(id);
    const killTimer = this.killTimers.get(id);
    if (wipeTimer) {
      // Relâché avant 500ms → short press (copie + Warp). Annule tout.
      clearTimeout(wipeTimer);
      this.pressTimers.delete(id);
      if (killTimer) {
        clearTimeout(killTimer);
        this.killTimers.delete(id);
      }
      await this.runShortPress(ev);
      return;
    }
    if (killTimer) {
      // Relâché entre 500ms et 3s → le wipe a déjà eu lieu. Annule le kill et
      // l'arming visuel ; le render-loop reprend l'état normal au prochain tick.
      clearTimeout(killTimer);
      this.killTimers.delete(id);
      const slot = this.state.get(id);
      if (slot) slot.killArmingSince = undefined;
      return;
    }
    // Relâché après 3s → kill déjà fired, no-op.
  }

  private async runShortPress(ev: KeyUpEvent): Promise<void> {
    const slot = this.state.get(ev.action.id);
    const cwd = slot?.clipboardPayload;
    if (!cwd) {
      await ev.action.showAlert();
      return;
    }
    try {
      await copyToClipboard(cwd);
      const res = await focusWarpTabForCwd(cwd);
      streamDeck.logger.info(`warp focus: ${res.reason} for cwd=${cwd}`);
      await ev.action.showOk();
    } catch (err) {
      streamDeck.logger.error("clipboard copy failed", err);
      await ev.action.showAlert();
    }
  }

  private async runLongPress(
    ev: KeyDownEvent,
    sessionId: string,
    origin: SessionOrigin,
  ): Promise<void> {
    try {
      await this.resetSlot(sessionId, origin);
      await ev.action.showOk();
    } catch (err) {
      streamDeck.logger.error(`long-press reset failed for ${origin}/${sessionId}`, err);
      await ev.action.showAlert();
    }
  }

  private async runKill(
    ev: KeyDownEvent,
    pid: number,
    sessionId: string,
    origin: SessionOrigin,
  ): Promise<void> {
    try {
      await this.killSlot(pid, sessionId, origin);
      await ev.action.showOk();
    } catch (err) {
      streamDeck.logger.error(`kill failed for ${origin}/${sessionId} pid=${pid}`, err);
      await ev.action.showAlert();
    }
  }

  /** True if any visible slot is mid-hold past LONG_PRESS_MS — consumed by the
   *  animation tick so the progress ring keeps advancing. */
  anyKillArming(): boolean {
    for (const s of this.state.values()) {
      if (s.killArmingSince !== undefined) return true;
    }
    return false;
  }

  /**
   * Returns the action instances ordered by physical position on the deck
   * (top-to-bottom, left-to-right). This ordering is what defines slot 1..N.
   */
  orderedActions(): KeyAction[] {
    return [...this.instances.values()]
      .filter((a) => a.coordinates) // skip multi-action contexts
      .sort((a, b) => {
        const A = a.coordinates!;
        const B = b.coordinates!;
        return A.row !== B.row ? A.row - B.row : A.column - B.column;
      });
  }

  getState(id: string): SlotState | undefined {
    return this.state.get(id);
  }
}

/**
 * Writes `text` to the host clipboard. Windows pipes to `clip.exe`; macOS to
 * `pbcopy`; Linux tries `wl-copy`, then `xclip`, then `xsel` (best-effort).
 */
async function copyToClipboard(text: string): Promise<void> {
  const p = platform();
  const candidates: [string, string[]][] =
    p === "win32" ? [["clip.exe", []]]
    : p === "darwin" ? [["pbcopy", []]]
    : [
        ["wl-copy", []],
        ["xclip", ["-selection", "clipboard"]],
        ["xsel", ["--clipboard", "--input"]],
      ];

  for (const [cmd, args] of candidates) {
    const r = await spawnCapture(cmd, args, { stdin: text });
    if (!r.err && r.code === 0) return;
  }
  throw new Error("no clipboard tool succeeded");
}

