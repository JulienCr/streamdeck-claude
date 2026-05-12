import streamDeck, {
  action,
  KeyDownEvent,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
  type KeyAction,
} from "@elgato/streamdeck";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { pickBestPane, readWarpPanes } from "./warp-db.js";

/** Per-instance state we render onto each key. */
export interface SlotState {
  /** SVG already rendered last tick — used to skip redundant setImage calls. */
  lastSvg?: string;
  /** What we copy to the clipboard when the key is pressed. */
  clipboardPayload?: string;
}

@action({ UUID: "com.julien.claudesessions.slot" })
export class SlotAction extends SingletonAction {
  /** All currently-visible action instances, keyed by their Stream Deck instance id. */
  private readonly instances = new Map<string, KeyAction>();
  /** Per-instance render bookkeeping. */
  private readonly state = new Map<string, SlotState>();

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
    streamDeck.logger.info(`willDisappear: id=${ev.action.id} total=${this.instances.size}`);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const slot = this.state.get(ev.action.id);
    if (!slot?.clipboardPayload) {
      await ev.action.showAlert();
      return;
    }
    const cwd = slot.clipboardPayload;
    try {
      await copyToClipboard(cwd);
      if (platform() === "darwin") {
        const res = await focusWarpTabOnMac(cwd);
        streamDeck.logger.info(`warp focus: ${res.reason} for cwd=${cwd}`);
      }
      await ev.action.showOk();
    } catch (err) {
      streamDeck.logger.error("clipboard copy failed", err);
      await ev.action.showAlert();
    }
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
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
      child.stdin.end(text);
    });
    if (ok) return;
  }
  throw new Error("no clipboard tool succeeded");
}

/**
 * Best-effort focus of the Warp tab corresponding to `cwd` on macOS.
 *
 * Warp exposes no AX content (its UI tree is empty to System Events) and no
 * AppleScript dictionary (warpdotdev/Warp#3364). Workaround: read Warp's local
 * sqlite DB to map cwd → (window_id, tab_index), then activate Warp and send
 * `Cmd+<tabIndex+1>` as a keystroke (System Events keystroke works even when
 * the target app has no AX content).
 *
 * Requires Stream Deck.app to be granted Accessibility (for the keystroke) in
 * System Settings → Privacy & Security → Accessibility. macOS prompts on the
 * first call.
 */
interface WarpFocusResult { matched: boolean; reason: string }

async function focusWarpTabOnMac(cwd: string): Promise<WarpFocusResult> {
  const open = await activateWarp();
  if (!open.ok) return { matched: false, reason: `activate-failed: ${open.error}` };

  const db = await readWarpPanes();
  if (!db.ok) return { matched: false, reason: `db-read-failed: ${db.error}` };
  if (db.snapshot.panes.length === 0) return { matched: false, reason: "db-empty" };

  const best = pickBestPane(cwd, db.snapshot.panes);
  if (!best) return { matched: false, reason: `no-match (rows=${db.snapshot.panes.length})` };

  // Multi-window: we can't reliably target a specific Warp window since AX is
  // empty (no per-window raise). The keystroke goes to whichever Warp window
  // is frontmost — user can Cmd+\` to cycle windows if it lands wrong.
  const windowCount = new Set(db.snapshot.panes.map((r) => r.windowId)).size;
  if (windowCount > 1) {
    streamDeck.logger.info(`warp: ${windowCount} windows in DB — keystroke goes to frontmost only`);
  }

  // Tabs 1..9 have direct Cmd+<digit> shortcuts; beyond that we fall back to
  // Cmd+Option+→/← cycling, computing the shortest path from the currently
  // active tab in the target window.
  if (best.tabIndex <= 8) {
    const digit = String(best.tabIndex + 1);
    const sent = await sendKeystrokeToWarp({ kind: "cmd-digit", digit });
    if (!sent.ok) return { matched: false, reason: `keystroke-failed: ${sent.error}` };
    return { matched: true, reason: `Cmd+${digit} → window=${best.windowId} tab=${best.tabIndex} score=${best.score} pane="${best.paneCwd}"` };
  }

  const active = db.snapshot.activeTabByWindow.get(best.windowId);
  const total = db.snapshot.tabCountByWindow.get(best.windowId);
  if (active === undefined || total === undefined || total <= 0) {
    return { matched: false, reason: `cycle-needs-active+total (window=${best.windowId} active=${active} total=${total})` };
  }
  const { direction, steps } = shortestCycle(active, best.tabIndex, total);
  if (steps === 0) {
    return { matched: true, reason: `already-on-tab window=${best.windowId} tab=${best.tabIndex}` };
  }
  const sent = await sendKeystrokeToWarp({ kind: "cycle", direction, steps });
  if (!sent.ok) return { matched: false, reason: `cycle-keystroke-failed: ${sent.error}` };
  return { matched: true, reason: `cycle ${direction} x${steps} → window=${best.windowId} tab=${best.tabIndex} (from ${active}/${total}) pane="${best.paneCwd}"` };
}

/** Pick the shorter direction around a circular tab strip of `total` tabs. */
function shortestCycle(
  from: number,
  to: number,
  total: number,
): { direction: "next" | "prev"; steps: number } {
  if (total <= 0 || from === to) return { direction: "next", steps: 0 };
  const forward = (to - from + total) % total;
  const backward = (from - to + total) % total;
  return forward <= backward
    ? { direction: "next", steps: forward }
    : { direction: "prev", steps: backward };
}

function activateWarp(): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/open", ["-a", "Warp"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", (err) => resolve({ ok: false, error: err.message }));
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: stderr.trim() || `exit-${code}` });
    });
  });
}

type KeystrokeSpec =
  | { kind: "cmd-digit"; digit: string }
  | { kind: "cycle"; direction: "next" | "prev"; steps: number };

async function sendKeystrokeToWarp(spec: KeystrokeSpec): Promise<{ ok: true } | { ok: false; error: string }> {
  // arrow key codes: 123 = ←, 124 = →
  const body = spec.kind === "cmd-digit"
    ? `keystroke "${spec.digit}" using command down`
    : `repeat ${spec.steps} times
         key code ${spec.direction === "next" ? 124 : 123} using {command down, option down}
         delay 0.02
       end repeat`;

  // Brief delay so Warp is fully frontmost before the key reaches it.
  const script = `
    delay 0.1
    tell application "System Events"
      if not (exists process "Warp") then return "ERROR: warp-not-running"
      tell process "Warp" to set frontmost to true
      ${body}
      return "OK"
    end tell
  `;
  // Cycling N tabs needs ~(steps*20ms + 100ms) + osascript startup. Give it
  // headroom proportional to step count.
  const timeoutMs = 1500 + (spec.kind === "cycle" ? spec.steps * 25 : 0);
  const r = await runOsa(script, timeoutMs);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.out === "OK") return { ok: true };
  return { ok: false, error: r.out };
}

function runOsa(script: string, timeoutMs: number): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, error: "timeout" });
    }, timeoutMs);
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `spawn: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true, out: stdout.trim() });
      resolve({ ok: false, error: stderr.trim() || `exit-${code}` });
    });
  });
}
