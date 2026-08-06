# Android and Android TV runtime

The Android implementation stays in the existing Tauri activity. It does not launch a second Activity, player screen, canvas, or texture-copy bridge. Media3 reads and demuxes the URL, MediaCodec decodes it, and `PlayerView` presents directly into a `SurfaceView`. The Tauri WebView remains transparent above that surface for React controls and arbitrary HTML overlays.

The hidden `<video>` element is still the public layout anchor. The TypeScript controller synchronizes the native surface to its physical-pixel rectangle and exposes the same headless API as desktop. If Media3 cannot expose and render a supported video track, the plugin switches the same native plane to LibVLC's direct `SurfaceView` backend. Neither path sends decoded frames through JavaScript or canvas.

## Supported baseline

- Android / Android TV API 24+
- arm64-v8a for production
- x86_64 for emulator smoke tests
- Media3 1.8.x for the native path
- LibVLC 3.7.x for direct-surface compatibility playback
- Android NDK 28.2 for the currently qualified build
- Tauri 2.11+

## Native playback settings

```ts
await attachVideo(video, {
  source: { uri, headers, cookies, userAgent, referrer },
  backend: 'auto',
  deviceProfile: 'tv',
  platform: {
    android: {
      decoderFallback: true,
      compatibilityFallback: 'libvlc',
      startupTimeoutSeconds: 8,
      dolbyVision: 'hevc-base-layer',
      buffer: { minSeconds: 12, maxSeconds: 45, playSeconds: 2.5, rebufferSeconds: 6, maxBytes: 96 * 1024 * 1024 },
    },
    androidTv: {
      buffer: { minSeconds: 14, maxSeconds: 50, playSeconds: 3, rebufferSeconds: 8 },
      tunneling: false,
    },
  },
})
```

Use `backend: 'media3'` to require Media3 without compatibility fallback, or
`backend: 'libvlc'` to open the stream directly with LibVLC. Both render into
the same native plane and retain the same headless controller and HTML overlay.

The byte limit is the last guardrail on small TV boxes. Tunneling is opt-in because vendor implementations vary. Dolby Vision profile 7 prefers the HEVC base-layer decoder; a physical-device matrix is still required because emulator HEVC decoders do not expose production 4K/DV capabilities.

For a private media PKI, stage the CA at build time and opt the source into it:

```sh
TAURI_VIDEO_EXTRA_CA=/secure/path/media-ca.pem npx tauri android build
```

```ts
source: { uri: 'https://media.internal/movie.mkv', tlsCaFile: 'bundled' }
```

This builds a real X.509 trust manager and keeps hostname verification enabled. It never installs a trust-all verifier.

## Compatibility runtime contents

The Android Gradle module includes LibVLC per ABI. Media3 remains the small, fast, hardware-decoded path for supported formats. LibVLC is activated only for unsupported tracks or decoder/startup failure and renders directly into `VLCVideoLayout`; it is not an HTTP proxy, transcoder, or full-file conversion stage.

LibVLC increases the APK substantially. Publish ABI-specific Android artifacts, review LGPL/source-offer obligations, and audit every bundled codec against the distribution's licensing requirements.

## Tauri app permissions

The plugin manifest declares `INTERNET` and `WAKE_LOCK`, the Leanback feature as optional, and touchscreen as optional. The host Android TV application should also include a Leanback launcher banner and D-pad focus states in its UI.

Remote media is fetched by Media3 or LibVLC, so it does not need to be added to WebView CSP.

## Device acceptance test

Run each case on an Android phone and physical Android TV device (not only an emulator):

1. HTTP MKV H.264/AAC starts progressively and reports `native-decode` plus a `media3/mediacodec/.../surface-view` backend.
2. MKV HEVC/AC-3 selects the device HEVC decoder without a CPU transcode when supported.
3. Unsupported hardware mode falls back once to software without a retry loop.
4. D-pad can reach play/pause, timeline, volume, and every track picker.
5. Seek at 10%, 50%, and 90% produces a new generation without old frames flashing.
6. Switch among two audio tracks and a text subtitle track at runtime.
7. Suspend/resume, background/foreground, HDMI hotplug, and audio-focus interruption recover.
8. Throttle near the source bitrate, inject latency/loss, and verify bounded memory plus conservative rebuffer/recovery.
9. Play a 4K source for 30 minutes and record thermal throttling, dropped frames, and RSS.
10. Confirm no second Activity/window is created and HTML remains visible over the video.

Capture `adb logcat | grep -E '(MediaCodec|ExoPlayer|VLC|tauri-plugin-video)'` and the `controller.stats()`/`playbackQuality()` snapshots with every failure report.
