#!/usr/bin/env bash
# Touch the reload-trigger file. The plugin's polling loop sees the new mtime
# within ~1 s, calls process.exit(0), and the Stream Deck app respawns it
# automatically — no need to quit the whole app.
set -euo pipefail
TRIGGER="${HOME}/.claude/.streamdeck-claude.reload"
mkdir -p "$(dirname "$TRIGGER")"
date +%s%N > "$TRIGGER"
echo "reload signaled: $TRIGGER"
echo "the plugin will exit + respawn within ~1 s"
