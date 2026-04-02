#!/bin/sh
set -eu

# Use an isolated keyfile backend so settings changes propagate between
# gnome-shell and prefs in nested tests without touching host dconf.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP_BASE=${XDG_RUNTIME_DIR:-/tmp}
NESTED_DIR=$(mktemp -d "$TMP_BASE/milkdrop-nested.XXXXXX")

cleanup() {
    rm -rf "$NESTED_DIR"
}
trap cleanup EXIT INT TERM

mkdir -p "$NESTED_DIR/config" "$NESTED_DIR/cache"

export XDG_CONFIG_HOME="$NESTED_DIR/config"
export XDG_CACHE_HOME="$NESTED_DIR/cache"
export GSETTINGS_BACKEND=keyfile
export MUTTER_DEBUG_DUMMY_MODE_SPECS=${MUTTER_DEBUG_DUMMY_MODE_SPECS:-1280x720}
export G_MESSAGES_DEBUG=${G_MESSAGES_DEBUG:-all}
export SHELL_DEBUG=${SHELL_DEBUG:-all}

cd "$ROOT"

# Ensure the latest extension build/schema is installed before launching
# the nested shell session used for manual testing.
"$ROOT/tools/install.sh"

exec dbus-run-session gnome-shell --devkit --wayland
