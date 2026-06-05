import { join } from "node:path";
import { platform, userInfo } from "node:os";

/**
 * Single source of truth for user-, distro- and host-specific paths used by
 * the plugin.
 *
 * The plugin runs inside the Stream Deck app on Windows, where neither `HOME`
 * nor `WSL_DISTRO_NAME` is set. To keep the bundle portable, rollup's
 * `inject-build-env` transform replaces the two `__BUILD_*__` sentinels below
 * with whatever values were live at build time (which always runs from WSL).
 * At runtime, real env vars take precedence; the baked defaults are the
 * fallback.
 *
 * If the sentinels somehow survived the build (e.g. running an unbuilt module
 * directly), `assertResolved` catches it before any path is constructed.
 */

const BUILD_WSL_HOME = "__BUILD_WSL_HOME__";
const BUILD_WSL_DISTRO = "__BUILD_WSL_DISTRO__";

function assertResolved(name: string, value: string): string {
  if (value.startsWith("__BUILD_") && value.endsWith("__")) {
    throw new Error(
      `streamdeck-claude env: ${name} was never replaced — run \`pnpm build\` from WSL with HOME and WSL_DISTRO_NAME set, or set ${name} in the runtime env.`,
    );
  }
  return value;
}

/** WSL/Linux-side home directory. Used directly inside WSL and as the basis
 *  for the UNC path the Windows-side plugin reads. */
export const WSL_HOME = process.env.HOME
  ?? (platform() === "win32" ? assertResolved("HOME", BUILD_WSL_HOME) : `/home/${userInfo().username}`);

/** WSL distro name as known by `wsl.exe -d <distro>`. */
export const WSL_DISTRO = process.env.WSL_DISTRO_NAME ?? assertResolved("WSL_DISTRO_NAME", BUILD_WSL_DISTRO);

/** Windows user profile dir. Always set by Windows; we refuse to fall back. */
export const WIN_HOME = platform() === "win32"
  ? (process.env.USERPROFILE ?? (() => { throw new Error("streamdeck-claude env: USERPROFILE is not set on win32"); })())
  : (process.env.USERPROFILE ?? "");

/** Where Claude Code stores per-pid session JSON, viewed from the WSL side. */
export const WSL_SESSIONS_DIR = join(WSL_HOME, ".claude", "sessions");
export const WSL_RELOAD_FILE = join(WSL_HOME, ".claude", ".streamdeck-claude.reload");
/** Claude Code user-global settings.json (where install-hook.sh writes the hook). */
export const WSL_SETTINGS_FILE = join(WSL_HOME, ".claude", "settings.json");

/** Same paths, but as UNC the Windows-side plugin can read. */
export const WSL_SESSIONS_DIR_FROM_WIN =
  `\\\\wsl.localhost\\${WSL_DISTRO}${WSL_HOME.replace(/\//g, "\\")}\\.claude\\sessions`;
export const WSL_RELOAD_FILE_FROM_WIN =
  `\\\\wsl.localhost\\${WSL_DISTRO}${WSL_HOME.replace(/\//g, "\\")}\\.claude\\.streamdeck-claude.reload`;
export const WSL_SETTINGS_FILE_FROM_WIN =
  `\\\\wsl.localhost\\${WSL_DISTRO}${WSL_HOME.replace(/\//g, "\\")}\\.claude\\settings.json`;

/** Windows-native sessions dir + settings.json (no WSL involved). */
export const WIN_SESSIONS_DIR = `${WIN_HOME}\\.claude\\sessions`;
export const WIN_SETTINGS_FILE = `${WIN_HOME}\\.claude\\settings.json`;
