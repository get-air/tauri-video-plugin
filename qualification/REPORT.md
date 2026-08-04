# Qualification report

Run date: 2026-08-04

## Current result

Linux native playback and the Android Media3 path are functional. Android phone and TV x86_64 emulators progressively played HTTPS MKV, WebM, AVI, and MPEG-TS with HTML/SVG overlays above a native `SurfaceView`. The post-control-fix phone and low-memory TV matrices each passed all 11 selected cases with zero decoder-reported dropped frames.

This remains a developer preview. Windows and physical ARM hardware are not qualified. The final regression described below was emulator-only; no physical-device commands were issued after the user requested emulator-only testing.

## Rendering paths actually measured

| Target | Path | Frame copies |
| --- | --- | --- |
| Linux | GStreamer `playbin3` → VA-API → `glsinkbin`/`gtkglsink` | 0 across the JS/Rust boundary |
| Android phone/TV | Media3 extractor → MediaCodec → `SurfaceView` | 0 across the JS/Rust boundary |
| Android fallback | GStreamer → bounded fMP4 → WebView MediaSource | Encoded fragments only |

React renders controls and overlays. It never receives video frames and no canvas is involved.

## Emulator profiles

| Target | Configuration | Result |
| --- | --- | --- |
| Phone | Android 16 x86_64, 2 cores, 2.5 GiB effective RAM, 1080×1920 | 11/11 post-fix matrix cases passed |
| TV | Android 16 TV x86_64, 4 cores, 1.5 GiB RAM, 1920×1080 | 11/11 post-fix matrix cases passed |
| Linux | KDE Wayland, GStreamer 1.28.5, VA-API/GL | Live UHD demo and integration suite passed |
| Windows | Not available | Not tested |

The TV emulator is intentionally memory-constrained to approximate a low-cost streaming box, but its Goldfish codecs do not model an Amlogic/Mali production decoder. Emulator success is not a substitute for ARM device qualification.

## Codec/container matrix

Both Android profiles passed:

- H.264/AAC in Matroska at 30 FPS
- VP8/Vorbis in WebM
- VP9/Opus in WebM
- HEVC/AC-3 in Matroska at 24 FPS
- MPEG-4 Part 2/MP3 in AVI
- H.264/AAC in MPEG-TS
- AV1/Opus in Matroska
- H.264/FLAC in Matroska
- H.264 with two audio tracks and a text subtitle track

The constrained TV additionally presented H.264 at 60.01 FPS with zero drops. The second AV1 fixture presented at approximately its source cadence with zero drops. Every primary case reported a `android-mediacodec:<decoder>:surface-view` backend.

## Controls, tracks, focus, and overlays

The final TV control run passed:

- play and continuously updating current position/duration;
- Japanese audio selection without returning to zero;
- text subtitle selection and native subtitle rendering;
- absolute seek to 13 seconds;
- volume change to 35%;
- buffer-distance UI backed by native telemetry;
- HTML/SVG overlay visibility above the native video plane;
- native 1.1× video zoom while the HTML overlay remains fixed above the video;
- no fullscreen button on Android TV;
- D-pad focus from Play to the seek timeline through Norigin spatial navigation without an unintended seek;
- zero dropped frames through the control sequence.

The TV URL form now leaves the focus tree after loading, so remote input cannot accidentally open the on-screen keyboard. TV subtitles use a larger bottom safe area and remain clear of the controls.

## HTTPS, buffering, and memory

The private qualification origin uses a local CA. Media3 uses an explicit X.509 trust manager only when the source requests `tlsCaFile: "bundled"`; hostname verification stays enabled.

The post-fix 30-second long-stream TV soak measured:

- average 30.06 FPS, minimum 27.99 FPS;
- 0 dropped frames;
- maximum process PSS 257.6 MiB;
- maximum Media3 encoded allocation 29.44 MiB;
- native reserve initially about 48 seconds and remained at 17.0 seconds after the 30-second sample, bounded by the 50-second TV setting.

At 6 Mbps plus 250 ms server latency, the 20-second TV soak measured:

- average 30.08 FPS, minimum 29.33 FPS;
- 0 dropped frames;
- maximum process PSS 209.8 MiB;
- a 3.8–7.0 second playable reserve;
- no playback errors.

At an intentionally insufficient 1.44 Mbps, playback correctly exhausted its reserve and entered rebuffering without frame drops, crashes, or unbounded allocation. This is an expected throughput failure, not a passing cadence test.

## UHD/Dolby Vision result

The provided Dune UHD remux reached Media3, but the Android TV emulator rejected its 3840×2160 Dolby Vision profile 7 stream as exceeding the Goldfish HEVC decoder capability and then returned a codec error. Native startup now waits for the first rendered frame, so this class of decoder failure can trigger the compatibility fallback instead of being reported as a usable native player.

That fallback did stream and play the remux rather than downloading it first. During the first seven samples it presented about 23.7–23.9 FPS with zero drops. As the software 4K HEVC-to-H.264 path exhausted its sub-second reserve, it fell to 18.46 FPS, accumulated 12 drops, and reached 720.6 MiB PSS. It therefore fails the low-memory/performance acceptance gate. OpenH264 is now correctly classified as software transcode in telemetry; it is not presented as a hardware backend.

This does not prove that the stream fails on a 4K Android TV chipset; the physical device was intentionally excluded. It remains an ARM hardware release gate.

## Automated checks

- TypeScript ESM/CJS builds and declaration emit: passed.
- TypeScript declaration checking, Vitest, and npm publish dry-run: passed.
- Rust `cargo test --all-targets --features gstreamer-runtime`: 15 passed, 5 network fixtures intentionally ignored.
- Rust Clippy with warnings denied: passed.
- Android Kotlin compilation with Java 17: passed.
- Android x86_64 debug APK build/install: passed.
- Phone native matrix: passed.
- Low-memory TV native matrix: passed.
- Phone control/track/overlay test: passed.
- TV control/overlay/zoom/D-pad no-seek test: passed.
- TV unthrottled and 6 Mbps soak tests: passed.

## Evidence

- Post-fix phone matrix: `artifacts/logs/android-phone-post-controls-matrix-matrix.json`
- Post-fix TV matrix: `artifacts/logs/android-tv-post-controls-matrix-matrix.json`
- Post-fix phone controls: `artifacts/logs/android-phone-post-controls-final-native-controls.json`
- Post-fix TV controls: `artifacts/logs/android-tv-dpad-zoom-final-native-controls.json`
- Post-fix TV soak: `artifacts/logs/android-tv-post-controls-soak-native-soak.json`
- TV controls: `artifacts/logs/android-tv-low-memory-final-native-controls.json`
- Final headed API/label control run: `artifacts/logs/android-tv-final-api-native-controls.json`
- TV long soak: `artifacts/logs/android-tv-low-memory-native-soak.json`
- TV 6 Mbps soak: `artifacts/logs/android-tv-throttled-6mbps-native-soak.json`
- Representative TV subtitle capture: `artifacts/android-tv-low-memory-final/controls-03-subtitle-overlay.png`
- Representative D-pad focus capture: `artifacts/android-tv-low-memory-final/controls-06-dpad-focus.png`
- Final readable track controls and overlay: `artifacts/android-tv-final-api/controls-03-subtitle-overlay.png`
- Post-fix TV zoom capture: `artifacts/android-tv-dpad-zoom-final/controls-06-zoom.png`
- Post-fix TV D-pad timeline focus capture: `artifacts/android-tv-dpad-zoom-final/controls-07-dpad-focus.png`
- Post-fix phone subtitle/overlay capture: `artifacts/android-phone-post-controls-final/controls-03-subtitle-overlay.png`

## Remaining release gates

1. Qualify Windows 11 with the bundled MSVC GStreamer runtime.
2. Run the same suite on ARM64 phones and at least two physical Android TV chipsets.
3. Qualify 4K HEVC/Dolby Vision, HDR policy, surround passthrough, HDMI changes, and thermal behavior on those devices.
4. Finish PGS/VobSub rendering and chapter extraction.
5. Add multi-hour, network-loss/recovery, and multi-session memory tests.
6. Reduce release APK size by shipping ABI-specific, codec-licensed GStreamer bundles instead of the universal debug runtime.
