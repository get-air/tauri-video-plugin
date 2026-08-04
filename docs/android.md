# Android and Android TV runtime

The Android implementation stays in the existing Tauri activity. It does not launch a second Activity, player screen, canvas, or texture-copy bridge. Media3 reads and demuxes the URL, MediaCodec decodes it, and `PlayerView` presents directly into a `SurfaceView`. The Tauri WebView remains transparent above that surface for React controls and arbitrary HTML overlays.

The hidden `<video>` element is still the public layout anchor. The TypeScript controller synchronizes the native surface to its physical-pixel rectangle and exposes the same headless API as desktop. If Media3 cannot open a source before rendering its first frame, the controller tears the native surface down and tries the GStreamer/MediaSource compatibility backend.

## Supported baseline

- Android / Android TV API 24+
- arm64-v8a for production
- x86_64 for emulator smoke tests
- Media3 1.8.x for the native path
- GStreamer 1.28.x Android universal SDK for compatibility fallback
- Android NDK 28.2 for the currently qualified build
- Tauri 2.11+

## Native playback settings

```ts
await attachVideo(video, {
  source: { uri, headers, cookies, userAgent, referrer },
  deviceProfile: 'tv',
  platform: {
    android: {
      decoderFallback: true,
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

`build.rs` links the selected GStreamer static archives and their dependent libraries directly into Tauri's JNI library, and stages `libc++_shared.so` for the selected ABI. The current baseline covers:

```make
GSTREAMER_PLUGINS := \
  $(GSTREAMER_PLUGINS_CORE) \
  $(GSTREAMER_PLUGINS_PLAYBACK) \
  $(GSTREAMER_PLUGINS_CODECS) \
  app matroska isomp4 playback soup \
  videoparsersbad audioparsers dashdemux hls
G_IO_MODULES := gnutls
GSTREAMER_EXTRA_DEPS := gstreamer-app-1.0 gstreamer-pbutils-1.0
```

GStreamer is not in the native frame path. It remains packaged for extractors/codecs that Media3 cannot open and for consistent cross-platform fallback. `libav` materially increases the APK and has licensing implications, so production distributions should select only codecs they can legally ship.

The Rust `gstreamer-sys` crates must see the same ABI sysroot at link time (`PKG_CONFIG_SYSROOT_DIR`, ABI-specific `PKG_CONFIG_PATH`, and the NDK clang toolchain). The resulting Tauri JNI library and `libc++_shared.so` are staged under the generated app's `jniLibs/<abi>/` directory by the build.

The repository includes a strict environment wrapper for the Rust link step:

```sh
JAVA_HOME=/usr/lib/jvm/java-17-openjdk \
GSTREAMER_ROOT_ANDROID=/opt/gstreamer-1.28.5 \
  ./scripts/android-env.sh aarch64 \
  sh -c 'cd examples/tauri-app && npx tauri android build --debug --target aarch64 --apk --ci'
```

It intentionally fails if the ABI sysroot is missing instead of accidentally linking against the host GStreamer installation.

Do not check the SDK or generated `.so` files into the crate. Produce them in CI and cache by GStreamer version, NDK version, and ABI.

## Tauri app permissions

The plugin manifest declares `INTERNET` and `WAKE_LOCK`, the Leanback feature as optional, and touchscreen as optional. The host Android TV application should also include a Leanback launcher banner and D-pad focus states in its UI.

The example CSP permits loopback HTTP only for the compatibility broker. Remote media is fetched by Media3 or GStreamer, so it is not added to WebView CSP.

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

Capture `adb logcat | grep -E '(MediaCodec|ExoPlayer|GStreamer|tauri-plugin-video)'` and the `controller.stats()`/`playbackQuality()` snapshots with every failure report.
