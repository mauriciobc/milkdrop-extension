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
    ./tools/nested.sh

logs:
    journalctl -f -o cat /usr/bin/gnome-shell

watch:
    ./tools/watch.sh

bench:
    @echo "── Micro-benchmarks ──"
    gjs -m tests/bench/run.js
    @echo ""
    @echo "── Renderer benchmark ──"
    @echo "Run: gjs -m src/renderer/renderer.js --benchmark --standalone --width 1280 --height 720"

visual-expr preset="0":
    gjs -m tests/visual-expr.js --preset {{preset}}

bench-json:
    gjs -m tests/bench/run.js -- --json

golden-frames:
    gjs -m tools/generate-golden-frames.js

profile:
    sysprof-cli --session -- dbus-run-session gnome-shell --devkit --wayland
