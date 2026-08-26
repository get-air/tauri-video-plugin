# Tauri platform for Air video

This repository is the Tauri platform implementation for
[`@get-air/video`](https://github.com/get-air/video), not a separate player.
It publishes both halves of the `tauri` backend:

| Package | Role |
| --- | --- |
| `@get-air/video` | Owns the shared controller and browser/TV backends |
| `@get-air/video-tauri` | Plugs `backend: 'tauri'` into that controller |
| `tauri-plugin-video` | Runs the native engines behind the adapter |

`createTauriVideoClient()` returns the regular `@get-air/video` client with
the Tauri backend installed. The DOM still owns layout, controls, and overlays.

## Platform support

| Target | Support | `auto` engine | Alternative |
| --- | --- | --- | --- |
| [Linux](docs/linux.md) | Supported | GStreamer | mpv with `mpv-runtime` |
| [Windows](docs/windows.md) | Supported | GStreamer | — |
| [Android / Android TV](docs/android.md) | Supported, API 24+ | Media3 / MediaCodec | LibVLC |
| macOS | Not supported | — | — |
| iOS | Not supported | — | — |

Linux and Android present directly into native surfaces. Windows passes pooled
D3D11 textures through WebView2 TextureStream to the real HTML `<video>`, so
video, controls, tooltips, resize, scrolling, and Snap Layouts share Chromium's
compositor without decoded-frame IPC.
Containers, codecs, DRM, HDR, and UHD limits depend on the selected engine and
target hardware.

All engines provide playback, live-stream detection, volume, tracks, custom
headers, and telemetry. HLS and DASH live playback is available when the active
engine has its corresponding runtime components; Media3 ships both modules.
Live state is exposed through `controller.media.live`, and DVR windows expose
`controller.media.seekable`. Crop-to-cover and zoom are supported on Android,
Windows, and Linux mpv; playback-rate changes and frame-accurate seeking are not
currently supported.

For a live controller, `media.durationSeconds` is `undefined` and the attached
HTML video's `duration` is `Infinity`. Seekable live windows publish their
current native bounds through `video.seekable`; direct seeks are clamped to that
window. Non-seekable feeds reject `seek()` with the shared typed unsupported
feature error and never report an ended state.

## Install

```sh
npm install @get-air/video @get-air/video-tauri
```

```toml
[dependencies]
tauri-plugin-video = "0.4"
```

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_video::init())
    .run(tauri::generate_context!())?;
```

Add `video:default` to the Tauri capability used by your window.

Linux uses GStreamer by default. To make mpv selectable:

```toml
tauri-plugin-video = { version = "0.4", features = ["gstreamer-runtime", "mpv-runtime"] }
```

## Use

```ts
import { createTauriVideoClient } from '@get-air/video-tauri'

const video = createTauriVideoClient()

const player = await video.attach(document.querySelector('video')!, {
  source: movieUrl,
  backend: 'tauri',
  backendOptions: {
    tauri: { engine: 'gstreamer' },
  },
})

await player.play()
```

Omit `engine` to use the platform default: Media3 on Android and GStreamer on
desktop builds that include it.

## Core integrations

All `@get-air/video` integrations can use the installed Tauri backend:

| Core integration | Connect Tauri with |
| --- | --- |
| Promise API | `createTauriVideoClient()` |
| Effect | `layerTauriVideoBackend()` from `@get-air/video-tauri/effect` |
| React / TV focus | `client` prop |
| Canvas | `client` option |
| Blits | `client` option |

Keep importing shared helpers from `@get-air/video/*`; only the client or
Effect layer comes from the Tauri adapter. Canvas and Blits also
need the transparent aperture shown in the [examples](examples) on Linux and
Android; Windows TextureStream remains ordinary DOM video.

## Compatibility

`@get-air/video-tauri` and `tauri-plugin-video` must use the same version.

| Adapter + crate | `@get-air/video` | Native protocol |
| --- | --- | --- |
| `0.2.x` | `>=0.1.1 <0.2.0` | `1` |
| `0.3.x` | `>=0.2.0 <0.3.0` | `1` |
| `0.4.x` | `>=0.3.0 <0.4.0` | `1` |

[API](docs/api.md) · [Examples](examples) · [Versioning](VERSIONING.md) ·
[Contributing](CONTRIBUTING.md)

MIT OR Apache-2.0
