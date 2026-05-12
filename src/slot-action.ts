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
    try {
      await copyToClipboard(slot.clipboardPayload);
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
