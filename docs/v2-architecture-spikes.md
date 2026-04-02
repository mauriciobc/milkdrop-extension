# V2 Architecture Spikes

This document records the two planned v2 spikes and the go/no-go criteria.

## Spike A: complementary D-Bus control channel

### Motivation

Current socket IPC is efficient for frame streaming, but control/diagnostics messages are loosely typed. A small D-Bus control surface can improve observability and external automation.

### Candidate scope

- keep socket for `frame`
- expose D-Bus methods for non-hot-path control (pause/resume, preset select, diagnostics)
- mirror key telemetry on D-Bus signals

### References

- `docs/reference-codebases/hanabi/src/dbus.js`
- current project status endpoint in `src/extension/monitor.js` (`GetWindowStatus`)

### Success metrics

- median command response latency not worse than current control path
- stable automation via `busctl` for control and status
- no measurable frame-pump slowdown

### Risks

- duplicated control paths increase complexity
- schema drift if socket and D-Bus diverge

## Spike B: optional `cava` analysis mode

### Motivation

`audio.js` currently keeps analysis in-process with GStreamer. Optional external analysis mode can reduce shell-process risk in problematic environments.

### Candidate scope

- add optional mode behind setting/feature flag
- use subprocess lifecycle and bounded queues
- keep existing GStreamer mode as default

### References

- `docs/reference-codebases/dynamic-music-pill/src/visualizerEngine.js`
- `docs/reference-codebases/cava/input/pipewire.c`
- `docs/reference-codebases/cava/input/pulse.c`

### Success metrics

- lower or equal shell CPU in stress scenarios
- no regression in visual responsiveness
- better recovery after source restarts/suspend-resume

### Risks

- dependency on external binary availability
- distribution/package differences
- potential latency increase vs in-process path

## Decision gate

Promote a spike only if at least 2 criteria improve versus baseline:

1. shell CPU
2. responsiveness/latency
3. recovery after audio failures
4. stability (crash/restart behavior)
