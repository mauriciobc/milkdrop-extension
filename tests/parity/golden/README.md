# Golden files for parity tests

Golden files store reference inputs and outputs for deterministic comparison. The per-frame golden format is used to validate that our expression evaluator produces the same results frame-by-frame as a reference (our own engine for regression, or projectM when available).

## Per-frame goldens (`frame/`)

### Source presets

Only **projectM test presets** are used, to keep data small. Presets are read from:

- `projectm/presets/tests/` when the projectM repo is present, or
- `tests/parity/golden/frame/presets/` (optional copy for CI without cloning projectM).

List of preset files (same as in preset-parser parity):

- `000-empty.milk`
- `001-line.milk`
- `100-square.milk`
- `101-per_frame.milk`
- `102-per_frame3.milk`
- `103-multiple-eqn.milk`
- `104-continued-eqn.milk`
- `105-per_frame_init.milk`
- `110-per_pixel.milk`
- `200-wave.milk`
- `240-wave-smooth-00.milk`

Goldens are generated only for presets that have evaluable `frame_eqs` (or `per_frame_*` code blocks). Presets that are empty or key-only may be skipped or get a single-frame golden.

### Schema (v1)

One JSON file per preset: `tests/parity/golden/frame/<presetId>.golden.json` where `presetId` is the filename without `.milk` (e.g. `101-per_frame`).

```json
{
  "version": 1,
  "presetId": "101-per_frame",
  "sourceFile": "101-per_frame.milk",
  "description": "projectM test preset",
  "seed": 12345,
  "frames": [
    {
      "frame": 0,
      "time": 0,
      "inputs": {
        "time": 0,
        "frame": 0,
        "fps": 30,
        "progress": 0,
        "bass": 0,
        "mid": 0,
        "treb": 0,
        "high": 0,
        "bass_att": 0,
        "mid_att": 0,
        "treb_att": 0,
        "energy": 0,
        "beat": 0
      },
      "outputs": {
        "zoom": 1.046,
        "rot": 0.02,
        "dx": 0,
        "dy": 0,
        "decay": 0.97
      }
    }
  ]
}
```

**Fields:**

- `version` (number): Schema version; currently 1.
- `presetId` (string): Identifier (filename without `.milk`).
- `sourceFile` (string): Basename of the `.milk` file.
- `description` (string, optional): Short description.
- `seed` (number, optional): If present, generator and test use this for deterministic rand; the test calls `setRandForTesting()` with values derived from this (or stored in the golden).
- `frames` (array): One entry per frame.

**Per-frame entry:**

- `frame` (number): Frame index.
- `time` (number): Time in seconds (typically `frame / 30`).
- `inputs` (object): Exact inputs passed to `evaluateFrame()`. Keys must include: `time`, `frame`, `fps`, `progress`, `bass`, `mid`, `treb`, `high`, `bass_att`, `mid_att`, `treb_att`, `energy`, `beat`. Omitted keys are treated as 0.
- `outputs` (object): Expected context values after evaluation. Typically a subset of: `zoom`, `rot`, `dx`, `dy`, `decay`, and optionally `q1`–`q32` and other RW variables that the preset modifies. Only keys listed here are compared (epsilon tolerance).

**Determinism:** Before running frames, the test (and generator) call `ev.setRandForTesting(randStart, randPreset)` after `loadPreset()` and before `runInit()` if the golden includes a `seed` or stored rand values, so that `rand_start` / `rand_preset` are fixed and reproducible.

### Generating goldens

From repo root, with `projectm/presets/tests/` available (or presets in `tests/parity/golden/frame/presets/`):

```bash
gjs -m tools/generate-golden-frames.js
```

Output is written to `tests/parity/golden/frame/<presetId>.golden.json`.

### Running the parity test

The golden-frame test is part of the parity suite:

```bash
gjs -m tests/run-parity.js
```

It loads each `.golden.json` in `tests/parity/golden/frame/`, parses the corresponding `.milk` preset, runs the evaluator with the same inputs, and compares outputs with tolerance `1e-5`.
