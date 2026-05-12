#!/usr/bin/env bash
# Symlinks this plugin's `.sdPlugin/` directory into the Stream Deck app's
# Plugins folder for the current host OS.
#
# macOS:
#   Plain `ln -s` into ~/Library/Application Support/com.elgato.StreamDeck/Plugins/.
#
# WSL → Windows:
#   `streamdeck link` from the Elgato CLI almost works from WSL but creates a
#   Linux-style symlink (target = `/home/...`) that the Windows-side Stream Deck
#   app can't follow. We instead generate a temporary `.cmd` file and execute
#   `mklink /D` via `cmd.exe`, which produces a proper Windows symlink with a
#   `\\wsl.localhost\<distro>\...` target the SD app can read. Requires Windows
#   Developer Mode enabled (or Administrator) so non-elevated `mklink /D` is
#   allowed.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_NAME="com.julien.claudesessions.sdPlugin"
PLUGIN_DIR="${ROOT}/${PLUGIN_NAME}"

# Sanity: plugin folder must exist
if [ ! -d "$PLUGIN_DIR" ]; then
  echo "error: plugin folder not found at $PLUGIN_DIR" >&2
  exit 1
fi

# --- macOS branch ---------------------------------------------------------
if [ "$(uname -s)" = "Darwin" ]; then
  MAC_PLUGINS_DIR="${HOME}/Library/Application Support/com.elgato.StreamDeck/Plugins"
  MAC_LINK="${MAC_PLUGINS_DIR}/${PLUGIN_NAME}"
  mkdir -p "$MAC_PLUGINS_DIR"
  if [ -L "$MAC_LINK" ] || [ -e "$MAC_LINK" ]; then
    rm -rf "$MAC_LINK"
  fi
  ln -s "$PLUGIN_DIR" "$MAC_LINK"
  echo "✓ symlink: ${MAC_LINK} → ${PLUGIN_DIR}"
  exit 0
fi

# --- WSL → Windows branch -------------------------------------------------
WSL_DISTRO="${WSL_DISTRO_NAME:-Ubuntu}"
WIN_USER="${WIN_USER:-julie}"
WIN_PLUGINS_DIR="C:\\Users\\${WIN_USER}\\AppData\\Roaming\\Elgato\\StreamDeck\\Plugins"
WIN_LINK="${WIN_PLUGINS_DIR}\\${PLUGIN_NAME}"
WIN_TARGET="\\\\wsl.localhost\\${WSL_DISTRO}${PLUGIN_DIR//\//\\}"

# Build a tiny .cmd file in a Windows-accessible location and run it via cmd.exe.
WIN_LINUX_PARENT="/mnt/c/Users/${WIN_USER}"
if [ ! -d "$WIN_LINUX_PARENT" ]; then
  echo "error: Windows user dir not found at $WIN_LINUX_PARENT (set WIN_USER env var)" >&2
  exit 1
fi

CMD_FILE="${WIN_LINUX_PARENT}/.streamdeck-claude-mklink.cmd"
trap 'rm -f "$CMD_FILE"' EXIT

cat > "$CMD_FILE" <<EOF
@echo off
if exist "${WIN_LINK}" (
  rmdir "${WIN_LINK}"
)
mklink /D "${WIN_LINK}" "${WIN_TARGET}"
EOF

# cmd.exe doesn't like UNC working directories — pin CWD to a real Windows path.
( cd "$WIN_LINUX_PARENT" && cmd.exe /c .streamdeck-claude-mklink.cmd ) 2>&1

# Verify by listing the linked directory through Windows.
( cd "$WIN_LINUX_PARENT" && cmd.exe /c "dir AppData\\Roaming\\Elgato\\StreamDeck\\Plugins\\${PLUGIN_NAME}\\manifest.json" ) > /dev/null 2>&1 \
  && echo "✓ symlink resolves through Windows: ${WIN_LINK}" \
  || { echo "✗ symlink created but Windows can't follow it" >&2; exit 2; }
