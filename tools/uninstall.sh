#!/bin/sh
set -eu

UUID="milkdrop@mauriciobc.github.io"
INSTALL_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

rm -rf "$INSTALL_DIR"
