# Qualification report

Run date: 2026-08-21

## Current result

Android has two explicitly selectable direct native rendering paths: Media3/MediaCodec and LibVLC on the same `SurfaceView` plane. Both an Android TV emulator and a constrained phone emulator progressively played all 20 HTTPS fixtures across the two selected modes.

No test downloaded a complete file before playback, converted video in JavaScript, or passed decoded frames through canvas. The final regression was emulator-only. No physical device was used after the user requested emulator-only testing.

Windows 11 VM qualification now covers D3D11 WebView2 TextureStream. Native
frames render on the real HTML video element with correct pixels and zero
decoded-frame IPC copies. MP4 playback sustained its native 24 FPS with zero
reported drops. The VM's Microsoft Basic Render Driver has neither hardware
decode nor a D3D11 video processor, so physical-GPU 4K60 remains a release gate.

## Rendering paths actually measured

| Target | Path | Decoded-frame copies across JS/native boundary |
| --- | --- | --- |
| Linux | GStreamer `playbin3` → VA-API → `glsinkbin`/`gtkglsink` | 0 |
| Windows | GStreamer decoder → NV12 `D3D11Memory` → WebView2 TextureStream → HTML video | 0 |
| Android fast path | Media3 extractor → MediaCodec → `SurfaceView` | 0 |
| Android explicit LibVLC | LibVLC demux/decode → `VLCVideoLayout`/`SurfaceView` | 0 |

React renders controls and overlays in the WebView. All three native paths keep
decoded frames outside JavaScript. On Windows, WebView2 consumes the pooled
D3D11 textures as a `MediaStream`, so video and controls share Chromium's DOM
compositor.

## Emulator profiles

| Target | Configuration | Result |
| --- | --- | --- |
| Phone | Android 16 x86_64, 2 cores, 2.5 GiB effective RAM, 1080×1920 | 20/20 HTTPS cases passed |
| TV | Android 16 TV x86_64, 4 cores, 1.5 GiB RAM, 1920×1080 | 20/20 HTTPS cases passed |
| Linux | KDE Wayland, GStreamer 1.28.5, VA-API/GL | Existing live UHD demo and integration suite passed |
| Windows | Windows 11 x86_64 VM, WebView2 151, GStreamer 1.28, Microsoft Basic Render Driver | TextureStream MP4 pixels, controls, source replacement, and 4K60 negotiation passed; hardware cadence unavailable |

The phone profile was deliberately CPU-constrained. Emulator software decoders and Goldfish codecs do not model production ARM MediaCodec performance, so this validates behavior and boundedness rather than physical-chip codec capability.

## Codec/container matrix

Both Android profiles presented real video frames for all 20 cases:

- H.264/AAC MKV at 30 FPS and 60 FPS;
- VP8/Vorbis and VP9/Opus WebM;
- HEVC/AC-3, HEVC Main10/E-AC-3, and HEVC Main10/TrueHD MKV;
- AV1/Opus MKV at two resolutions;
- MPEG-4 Part 2/MP3 AVI;
- H.264/AAC and MPEG-2/AC-3 MPEG-TS;
- H.264/FLAC, H.264/DTS, and H.264/Opus MKV;
- H.264 MKV with two audio tracks and a subtitle track;
- ProRes/PCM MOV;
- FFV1/FLAC MKV;
- MJPEG/PCM AVI.

The matrix rejects audio-only false positives by requiring the browser-reported presented-video-frame counter to advance. Formats supported by the emulator were tested on MediaCodec. Other formats were tested by explicitly selecting LibVLC; the current plugin does not switch engines automatically.

## Controls, tracks, layout, and overlays

The TV Media3 control run passed audio and subtitle selection, absolute seek, volume, zoom, fullscreen, buffer telemetry, HTML/SVG overlay visibility, scroll-follow layout, and D-pad focus without accidental seeking. The explicit LibVLC control run passed seek, volume, overlay visibility, fullscreen, and scroll-follow layout on the same native surface. The constrained phone run passed track selection, subtitles, seek, volume, overlay, fullscreen, and scroll-follow with zero reported drops during the interaction sequence.

Native commands carry a session key. Delayed React cleanup from a prior controller can no longer close or control a replacement native surface.

## HTTPS, buffering, and trust

All 20 cases streamed over a local HTTPS range server using a private qualification CA. The Android trust manager augments, rather than replaces, system roots. Public HTTPS therefore continues to use normal Android trust while `tlsCaFile: "bundled"` adds the explicitly bundled qualification root. Hostname verification remains enabled.

The APK build verifies that the bundled CA asset is staged even when only `TAURI_VIDEO_EXTRA_CA` is supplied. LibVLC receives the same app-private trust directory. Range requests remain progressive; neither backend waits for the full resource.

## Performance samples

On 2026-08-08, the desktop aperture fixture was also exercised in Firefox
153.0.3 against nested overflow clipping, rounded corners, gradient ancestor
backgrounds, an external control toolbar, an HTML overlay, and an unrelated
fixed opaque branch crossing the native rectangle. Pixel probes confirmed that
the crossing branch remained visible outside the aperture and was masked inside
it. After a 210 px nested scroll, the DOM anchor and simulated native surface
both reported `y = 248`, and the published clipped aperture was
`361,248`–`1237,682`.

The steady-state compositor loop completed 1,000 measure/commit iterations in
36 ms (0.036 ms per iteration) with zero CSS property writes after the first
commit. A deliberately adversarial synchronous scroll loop, which alternated
the nested scroll position and forced layout on every iteration, completed 240
updates in 186 ms (0.775 ms per update). These are local regression measurements,
not general device performance claims.

The Android TV MediaCodec soak ran for 20 seconds at 29.91 average presented FPS for a 30 FPS source, with 0 dropped frames, 29.33 minimum sampled FPS, 234.6 MiB maximum process PSS, 26.8 MiB maximum encoded-buffer allocation, and at least 23.1 seconds of reserve.

The Android TV explicit LibVLC soak ran for 20 seconds at 24.43 average presented FPS for a 24 FPS source, advanced 20.14 seconds, and reported 0 dropped frames. Maximum PSS was 277.1 MiB and minimum estimated reserve was 7.8 seconds. One instantaneous FPS sample fell to 14.0 because the counter is sampled over short asynchronous windows. Average cadence and the zero-drop counter were healthy, but the saved run is correctly marked failed against its strict 18 FPS minimum-sample threshold.

The constrained phone MediaCodec soak ran for 15 seconds at 29.75 average presented FPS, 28.43 minimum sampled FPS, 0 dropped frames, 230.0 MiB maximum process PSS, 27.4 MiB maximum encoded allocation, and at least 29 seconds of reserve.

The Windows TextureStream run negotiated and displayed 3840×2160 at 60 FPS
with correct DOM pixel readback and zero decoded-frame IPC copies. GStreamer
selected `avdec_h264`; Microsoft Basic Render Driver also lacks the D3D11 video
processor needed for GPU colorspace conversion. Depending on the generated
source, the fallback delivered roughly 20–44 FPS at 1.1–1.4 CPU cores. This
validates resolution, format negotiation, GPU texture sharing, and fallback
behavior—not the hardware 4K60 performance target. That target must be measured
where `d3d11h264dec` and GPU NV12 conversion are available.

In the full constrained-phone matrix, the hardest LibVLC fixtures incurred one or two drops while still sustaining source cadence. Production 4K HDR/Dolby Vision performance remains an ARM hardware qualification gate; x86 emulator software-decoder results must not be represented as physical TV performance.

## Automated checks

- TypeScript ESM/CJS builds and declaration emit: passed.
- Firefox complex-DOM aperture, external-controls, and nested-scroll fixture: passed.
- TypeScript declaration checking, Vitest, and npm publish dry-run: passed.
- Rust tests and Clippy with warnings denied: passed.
- Windows x86-64 Rust build and Clippy with warnings denied: passed.
- Windows 4K60 TextureStream negotiation and pixel check: passed; physical-GPU
  cadence remains required.
- Windows in-motion resize and scroll capture: 48/48 frames in each run kept
  video and controls in one compositor surface with no exposed client-area gap.
- Windows fullscreen and tooltip captures: passed with DOM chrome above the
  TextureStream video.
- Android Kotlin compilation with Java 17: passed.
- Android x86_64 debug APK build/install: passed.
- Android TV 20-format HTTPS matrix: passed.
- Constrained phone 20-format HTTPS matrix: passed.
- TV MediaCodec and LibVLC control/overlay/layout tests: passed.
- Phone MediaCodec control/overlay/layout test: passed.
- TV MediaCodec and constrained-phone soak tests: passed.
- TV LibVLC soak: sustained average source cadence with zero drops, but failed the strict minimum-window threshold because one sample measured 14.0 FPS.

## Evidence

- TV complete matrix: `artifacts/logs/android-tv-complete-matrix.json`
- Constrained phone complete matrix: `artifacts/logs/android-phone-constrained-complete-matrix.json`
- TV MediaCodec controls: `artifacts/logs/android-emulator-native-controls-native-controls.json`
- TV LibVLC controls: `artifacts/logs/android-emulator-compatibility-controls-native-controls.json`
- Constrained phone controls: `artifacts/logs/android-phone-constrained-controls-native-controls.json`
- TV MediaCodec soak: `artifacts/logs/android-tv-hardware-soak-native-soak.json`
- TV LibVLC soak: `artifacts/logs/android-tv-compatibility-soak-native-soak.json`
- Constrained phone soak: `artifacts/logs/android-phone-constrained-soak-native-soak.json`
- Windows TextureStream DOM pixels: `artifacts/windows/texture-stream-30s.png`
- Windows 1.3× zoom and overlay: `artifacts/windows/texture-stream-zoom-1.3.png`
- Windows resize contact sheet: `artifacts/windows/texture-stream-resize-color-contact-sheet.png`
- Windows scroll contact sheet: `artifacts/windows/texture-stream-scroll-contact-sheet.png`
- Windows fullscreen: `artifacts/windows/texture-stream-fullscreen.png`
- Windows tooltip overlay: `artifacts/windows/texture-stream-tooltip.png`

## Remaining release gates

1. Qualify Windows on physical hardware with a GStreamer D3D11 hardware
   decoder, including GPU/CPU telemetry and device-loss recovery.
2. Run the same suite on ARM64 phones and at least two physical Android TV chipsets when physical-device testing is explicitly resumed.
3. Qualify 4K HEVC/Dolby Vision, HDR policy, surround passthrough, HDMI changes, and thermal behavior on those devices.
4. Finish PGS/VobSub rendering and chapter extraction.
5. Add multi-hour, network-loss/recovery, and multi-session memory tests.
6. Publish ABI-specific Android artifacts and complete the LibVLC/codec licensing audit before a production release.
