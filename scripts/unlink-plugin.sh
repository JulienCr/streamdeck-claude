#!/usr/bin/env bash
# Removes the symlink created by link-plugin.sh, for whichever host OS.
set -euo pipefail

PLUGIN_NAME="com.julien.claudesessions.sdPlugin"

# --- macOS branch ---------------------------------------------------------
if [ "$(uname -s)" = "Darwin" ]; then
  MAC_LINK="${HOME}/Library/Application Support/com.elgato.StreamDeck/Plugins/${PLUGIN_NAME}"
  if [ -L "$MAC_LINK" ] || [ -e "$MAC_LINK" ]; then
    rm -rf "$MAC_LINK"
    echo "Unlinked: $MAC_LINK"
  else
    echo "Nothing to unlink at $MAC_LINK"
  fi
  exit 0
fi

# --- WSL → Windows branch -------------------------------------------------
WIN_USER="${WIN_USER:-julie}"
WIN_LINK="C:\\Users\\${WIN_USER}\\AppData\\Roaming\\Elgato\\StreamDeck\\Plugins\\${PLUGIN_NAME}"
WIN_LINUX_PARENT="/mnt/c/Users/${WIN_USER}"

CMD_FILE="${WIN_LINUX_PARENT}/.streamdeck-claude-rmlink.cmd"
trap 'rm -f "$CMD_FILE"' EXIT

cat > "$CMD_FILE" <<EOF
@echo off
if exist "${WIN_LINK}" (
  rmdir "${WIN_LINK}"
  echo Unlinked.
) else (
  echo Nothing to unlink.
)
EOF

( cd "$WIN_LINUX_PARENT" && cmd.exe /c .streamdeck-claude-rmlink.cmd )
