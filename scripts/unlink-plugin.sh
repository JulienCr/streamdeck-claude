#!/usr/bin/env bash
# Removes the Windows-side symlink created by link-plugin.sh.
set -euo pipefail

PLUGIN_NAME="com.julien.claudesessions.sdPlugin"
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
