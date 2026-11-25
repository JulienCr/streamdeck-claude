import streamDeck, {
  action,
  type KeyDownEvent,
  type SendToPluginEvent,
  type WillAppearEvent,
  type JsonObject,
  type JsonValue,
  SingletonAction,
} from "@elgato/streamdeck";
import { renderHookWarning } from "./icons/index.js";
import { checkHooks, HOOK_FIX_HINT } from "./hook-check.js";

const HOOK_WARNING_IMAGE =
  "data:image/svg+xml;base64," + Buffer.from(renderHookWarning(), "utf8").toString("base64");

/** Minimal shape we need off a Stream Deck action to badge the Setup key.
 *  `setImage()` with no argument reverts to the manifest-defined image. */
interface BadgeableAction {
  setImage(image?: string): Promise<void>;
}

/** Result of one refresh cycle, surfaced to the PI for a brief status line. */
export interface RefreshResult {
  wiped: number;
  errors: string[];
}

/** Setup action: lives next to slot keys on the Stream Deck, exposes
 *  maintenance affordances. Today the only operation is "refresh states"
 *  (key press OR PI button) — wipe every <sid>.events.ndjson and force an
 *  immediate re-tick so every slot reflects the freshly-empty log. The
 *  property inspector keeps a placeholder section for future controls. */
@action({ UUID: "com.julien.claudesessions.setup" })
export class SetupAction extends SingletonAction {
  private refreshing = false;
  /** Last hook-check problem set we logged, to avoid warning on every appear. */
  private lastHookProblems = "";

  constructor(private readonly refreshNow: () => Promise<RefreshResult>) {
    super();
  }

  /** Reflect hook-registration health on the key: a warning tile when the hook
   *  is stale/missing (the silent-degradation case), else the manifest icon. */
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!ev.action.isKey()) return;
    await this.applyHookBadge(ev.action);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const result = await this.runRefresh();
    if (!result) {
      // already in flight — no-op rather than queueing a second pass
      return;
    }
    try {
      if (result.errors.length === 0) {
        await ev.action.showOk();
      } else {
        await ev.action.showAlert();
      }
    } catch (err) {
      streamDeck.logger.warn(`setup key feedback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // showOk/showAlert is a transient overlay; re-assert the persistent hook
    // badge underneath it so a stale-config warning survives the press.
    await this.applyHookBadge(ev.action);
  }

  private async applyHookBadge(action: BadgeableAction): Promise<void> {
    try {
      const { ok, problems } = await checkHooks();
      if (ok) {
        this.lastHookProblems = "";
        await action.setImage(); // revert to manifest icon
        return;
      }
      const key = problems.join("|");
      if (key !== this.lastHookProblems) {
        this.lastHookProblems = key;
        streamDeck.logger.warn(`hook config check failed — ${HOOK_FIX_HINT}\n  ${problems.join("\n  ")}`);
      }
      await action.setImage(HOOK_WARNING_IMAGE);
    } catch (err) {
      streamDeck.logger.warn(`hook badge update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, JsonObject>): Promise<void> {
    const payload = ev.payload as { event?: unknown };
    if (payload?.event !== "refresh-states") return;

    const result = await this.runRefresh();
    try {
      await streamDeck.ui.current?.sendToPropertyInspector({
        event: "refresh-done",
        wiped: result?.wiped ?? 0,
        skipped: result === undefined,
        errors: result?.errors ?? [],
      });
    } catch (err) {
      streamDeck.logger.warn(`setup PI reply failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async runRefresh(): Promise<RefreshResult | undefined> {
    if (this.refreshing) return undefined;
    this.refreshing = true;
    try {
      return await this.refreshNow();
    } catch (err) {
      streamDeck.logger.error("refreshNow threw", err);
      return { wiped: 0, errors: [err instanceof Error ? err.message : String(err)] };
    } finally {
      this.refreshing = false;
    }
  }
}
