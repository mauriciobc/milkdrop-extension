#!/bin/sh
set -eu

UUID="milkdrop@mauriciobc.github.io"

gnome-extensions disable "$UUID" 2>/dev/null || true
gnome-extensions enable "$UUID"
