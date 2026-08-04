# Changelog

## 0.1.0 — developer preview

- Added a Tauri 2 Rust plugin with GStreamer discovery, remux/transcode selection, bounded sessions, and a locked-down loopback fragment broker.
- Added a typed JavaScript controller that attaches MediaSource transport to any `HTMLVideoElement`.
- Added live seek generations, playback state, visibility suspension, telemetry, audio/video selection, and streamed text subtitle cues.
- Added Linux runtime tests that generate and remux a real Matroska fixture.
- Added Android/Android TV plugin scaffolding, audio focus, screen-awake coordination, ABI environment tooling, and a generated example project.
- Added the responsive Signal Bench reference application and publish checks.

Known gaps: physical Windows/Android/TV validation, GStreamer release bundling, image subtitle rendering, chapters, HDR policy, and long-duration/network-fault stress testing.
