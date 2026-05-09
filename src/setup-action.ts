import streamDeck, {
  action,
  type KeyDownEvent,
  type SendToPluginEvent,
  type JsonObject,
  type JsonValue,
  SingletonAction,
} from "@elgato/streamdeck";

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

  constructor(private readonly refreshNow: () => Promise<RefreshResult>) {
    super();
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
