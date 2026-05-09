import streamDeck from "@elgato/streamdeck";
import { stat } from "node:fs/promises";
import { platform } from "node:os";
import { WSL_RELOAD_FILE, WSL_RELOAD_FILE_FROM_WIN } from "./env.js";

/**
 * Self-reload trigger: when the mtime of this file changes, exit the plugin.
 * The Stream Deck app respawns it automatically (faster than quitting + relaunching
 * the whole app, and avoids the WSL `readlink` issue that blocks `streamdeck restart`).
 *
 * Touch with `pnpm sd:reload` from the dev box.
 */
const RELOAD_FILE = platform() === "win32" ? WSL_RELOAD_FILE_FROM_WIN : WSL_RELOAD_FILE;

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

/**
 * Polls the reload trigger file on its own interval. Self-contained: caller just
 * fires this once at startup and forgets about it. No teardown needed because
 * triggering exits the process.
 */
export function watchForReload(opts: { pollMs: number }): void {
  setInterval(() => {
    checkReload().catch((err) => {
      streamDeck.logger.error("reload check failed", err);
    });
  }, opts.pollMs);
}
