#!/usr/bin/env bash
# Thin wrapper around the @elgato/cli `streamdeck` binary. On WSL the Elgato
# CLI needs HOME pointed at the Windows user dir so it finds the SD app's
# config + Plugins folder; on macOS it just runs native and HOME must stay
# the real macOS home (overriding it to /mnt/c/... would 404). Pure passthrough
# of remaining args.
set -euo pipefail

case "$(uname -s)" in
  Linux*)
    # WSL detection: /mnt/c exists. Plain Linux without /mnt/c → no override.
    if [ -d "/mnt/c" ]; then
      WIN_USER="${WIN_USER:-julie}"
      WIN_HOME="/mnt/c/Users/${WIN_USER}"
      if [ ! -d "$WIN_HOME" ]; then
        echo "error: Windows user dir not found at $WIN_HOME (set WIN_USER=<name>)" >&2
        exit 1
      fi
      export HOME="$WIN_HOME"
    fi
    ;;
  Darwin*|MINGW*|MSYS*|CYGWIN*) ;;  # no-op: CLI runs native
esac

exec pnpm exec streamdeck "$@"
