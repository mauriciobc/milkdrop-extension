# gnome-milkdrop

gnome-milkdrop is a GNOME Shell extension and companion renderer process for MilkDrop-style desktop visualizations.

The current implementation target is GNOME Shell 47, 48, and 49 on Wayland, with local manual installation first. The architecture follows a split-process model: the extension manages lifecycle, monitor ownership, and orchestration inside gnome-shell, while a standalone GTK4 renderer process owns OpenGL rendering.

## Current Status

The repository currently contains the first implementation scaffold:

- project-local GNOME extension skill and research notes
- extension metadata, lifecycle skeleton, prefs skeleton, and schema
- standalone renderer skeleton built around GTK4
- Meson and just-based local workflow

## Key Decisions

- UUID: milkdrop@mauriciobc.github.io
- Shell versions: 47, 48, 49
- Local/manual install first
- Wayland-first renderer subprocess architecture

## Next Milestones

1. Validate renderer launch and shell-side ownership
2. Add Unix-socket IPC
3. Add GtkGLArea render loop and shader fallback
4. Add audio ingestion and preset orchestration