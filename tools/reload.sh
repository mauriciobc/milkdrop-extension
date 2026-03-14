#!/bin/sh
set -eu

UUID="milkdrop@mauriciobc.github.io"

echo "Note: reload does not compile schemas. After .gschema.xml changes, run tools/install.sh or just install first."

gnome-extensions disable "$UUID" 2>/dev/null || true
gnome-extensions enable "$UUID"
