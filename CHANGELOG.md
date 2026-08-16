# Changelog

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
