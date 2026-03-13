set shell := ["bash", "-cu"]

uuid := "milkdrop@mauriciobc.github.io"

default:
    just --list

install:
    ./tools/install.sh

reinstall:
    ./tools/install.sh
    ./tools/reload.sh

enable:
    gnome-extensions enable {{uuid}}

disable:
    gnome-extensions disable {{uuid}}

reload:
    ./tools/reload.sh

uninstall:
    ./tools/uninstall.sh

test:
    gjs -m tests/run.js

renderer:
    gjs -m src/renderer/renderer.js --monitor 0 --width 1280 --height 720 --standalone

nested:
    dbus-run-session gnome-shell --devkit --wayland

logs:
    journalctl -f -o cat /usr/bin/gnome-shell

watch:
    ./tools/watch.sh
