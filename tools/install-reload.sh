#!/bin/sh
set -eu

ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
UUID="milkdrop@mauriciobc.github.io"

echo "Disabling extension..."
gnome-extensions disable "$UUID" 2>/dev/null || true

echo "Running install.sh..."
"$ROOT/tools/install.sh"

echo "Restarting Gnome shell session..."
gnome-session-quit --logout --no-prompt
