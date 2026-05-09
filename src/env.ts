import { join } from "node:path";

/**
 * Single source of truth for user-, distro- and host-specific paths used by
 * the plugin. Resolved once at module load via env vars (HOME, USERPROFILE,
 * WSL_DISTRO_NAME) with sensible fallbacks, so no runtime path string
 * elsewhere in the codebase has to know who/where we are.
 */

/**
 * WSL/Linux-side home directory. Used both directly (when running inside WSL)
 * and as the basis for the `\\wsl.localhost\…` UNC path the Windows-side plugin
 * reads. The fallback MUST stay Linux-shaped because on Windows-native Node the
 * `HOME` env var is typically unset and `homedir()` would return `C:\Users\…`,
 * which would corrupt the UNC path construction below.
 */
export const WSL_HOME = process.env.HOME ?? "/home/julien";

/** WSL distro name as known by `wsl.exe -d <distro>`. */
export const WSL_DISTRO = process.env.WSL_DISTRO_NAME ?? "Ubuntu";

/** Windows user profile dir. Only meaningful when running on win32. */
export const WIN_HOME = process.env.USERPROFILE ?? "C:\\Users\\julie";

/** Where Claude Code stores per-pid session JSON, viewed from the WSL side. */
export const WSL_SESSIONS_DIR = join(WSL_HOME, ".claude", "sessions");
export const WSL_RELOAD_FILE = join(WSL_HOME, ".claude", ".streamdeck-claude.reload");

/** Same dir, but as a UNC path the Windows-side plugin can read. */
export const WSL_SESSIONS_DIR_FROM_WIN =
  `\\\\wsl.localhost\\${WSL_DISTRO}${WSL_HOME.replace(/\//g, "\\")}\\.claude\\sessions`;
export const WSL_RELOAD_FILE_FROM_WIN =
  `\\\\wsl.localhost\\${WSL_DISTRO}${WSL_HOME.replace(/\//g, "\\")}\\.claude\\.streamdeck-claude.reload`;

/** Windows-native sessions dir (no WSL involved). */
export const WIN_SESSIONS_DIR = `${WIN_HOME}\\.claude\\sessions`;
