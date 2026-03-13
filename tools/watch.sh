#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if ! command -v inotifywait >/dev/null 2>&1; then
    echo "inotifywait is required for watch.sh" >&2
    exit 1
fi

echo "Watching source files for changes"

while inotifywait -r -e close_write,create,delete,move \
    "$ROOT/src" \
    "$ROOT/tools" \
    "$ROOT/docs" \
    "$ROOT/.github"; do
    "$ROOT/tools/install.sh"
    "$ROOT/tools/reload.sh"
done
