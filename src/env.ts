import { homedir, userInfo } from "node:os";
import { join } from "node:path";

/**
 * Single source of truth for user-, distro- and host-specific paths used by
 * the plugin. Resolved once at module load via env vars (HOME, USERPROFILE,
 * WSL_DISTRO_NAME) with sensible fallbacks, so no runtime path string
 * elsewhere in the codebase has to know who/where we are.
 */

/** Username and home dir on the WSL/Linux side. */
export const WSL_USERNAME = userInfo().username;
export const WSL_HOME = process.env.HOME ?? homedir();

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
