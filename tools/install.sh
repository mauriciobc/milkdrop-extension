#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUILD_DIR="$ROOT/build"
PREFIX="$HOME/.local"
UUID="milkdrop@mauriciobc.github.io"
SCHEMA_DIR="$PREFIX/share/gnome-shell/extensions/$UUID/schemas"

if [ -d "$BUILD_DIR" ]; then
    meson setup "$BUILD_DIR" --prefix="$PREFIX" --reconfigure
else
    meson setup "$BUILD_DIR" --prefix="$PREFIX"
fi

meson install -C "$BUILD_DIR"

if [ -d "$SCHEMA_DIR" ]; then
    glib-compile-schemas "$SCHEMA_DIR"
fi
