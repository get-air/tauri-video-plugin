# Changelog

Release numbering follows the
[versioning and compatibility policy](VERSIONING.md).

## Unreleased

- Fix Windows audio-only playback while preserving over-video HTML controls by
  presenting D3D11 in a non-activating window behind a transparent Tauri window.
- Add a Windows native smoke test for decoded frames, seek, pause, resume, and
  overlay geometry.

## 0.3.0

- Remove the `auto` native-engine option and automatic engine-priority configuration.
- Default omitted engine selection to Media3 on Android and GStreamer on desktop platforms.
- Open the `@get-air/video` peer compatibility line to `>=0.2.0 <0.3.0` and test against exact core `0.2.0`.

## 0.2.0

- Made `@get-air/video` a required peer (`>=0.1.1 <0.2.0`) so applications
  own one shared core instance while the adapter tests an exact published core.
- Added a cached, retryable JS↔Rust protocol handshake and bidirectional
  `native_open` validation before native player allocation.
- Added schema-backed `VideoNativeProtocolMismatchError` diagnostics that retain
  their tag and npm/crate fields through the shared Promise and Effect clients.
- Added generated permissions for read-only native diagnostics and enforced
  npm/Cargo version, peer-range, protocol, changelog, and tag consistency.
- Documented the independent core and lockstep adapter/crate versioning policy,
  and added clone-safe contributor guidance and release skills.

## 0.1.0

- Published the JavaScript adapter as `@get-air/video-tauri`, implementing the
  same client/controller contract as `@get-air/video` without putting Tauri in
  the DOM package.
- Added native-surface playback on Linux and Windows with GStreamer, plus
  optional explicit mpv on Linux.
- Added native-surface playback on Android and Android TV with Media3 and
  optional explicit LibVLC.
- Added CSS aperture synchronization, visibility suspension, track controls,
  and native playback telemetry behind the shared Air controller.
- Kept buffering under the selected player by default, with optional backend-specific tuning.
- Added emulator and Linux qualification tooling.
