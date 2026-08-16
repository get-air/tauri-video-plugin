# Air video for Tauri

Native playback for Tauri 2 using the same
[`@get-air/video`](https://github.com/get-air/video) API. Video renders on a
native surface while the DOM owns layout, controls, and overlays.

## Platform support

| Target | Support | `auto` engine | Alternative |
| --- | --- | --- | --- |
| [Linux](docs/linux.md) | Supported | GStreamer | mpv with `mpv-runtime` |
| [Windows](docs/windows.md) | Supported | GStreamer | — |
| [Android / Android TV](docs/android.md) | Supported, API 24+ | Media3 / MediaCodec | LibVLC |
| macOS | Not supported | — | — |
| iOS | Not supported | — | — |

Native frames never cross JavaScript or the WebView. Containers, codecs, DRM,
HDR, and UHD limits depend on the selected engine and target hardware.

All engines provide playback, seeking, volume, tracks, custom headers, and
telemetry. Crop-to-cover and zoom require Android or Linux mpv; playback-rate
changes and frame-accurate seeking are not currently supported.

## Install

```sh
npm install @get-air/video @get-air/video-tauri
```

```toml
[dependencies]
tauri-plugin-video = "0.2"
```

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_video::init())
    .run(tauri::generate_context!())?;
```

Add `video:default` to the Tauri capability used by your window.

Linux uses GStreamer by default. To make mpv selectable:

```toml
tauri-plugin-video = { version = "0.2", features = ["gstreamer-runtime", "mpv-runtime"] }
```

## Use

```ts
import { createTauriVideoClient } from '@get-air/video-tauri'

const video = createTauriVideoClient()

const player = await video.attach(document.querySelector('video')!, {
  source: movieUrl,
  backend: ['mediabunny', 'tauri'],
  backendOptions: {
    tauri: { engine: 'auto' },
  },
})

await player.play()
```

The ordered list tries direct DOM/WebCodecs playback, then native playback,
without changing the controller API. Use `backend: 'tauri'` to force native.
The Effect-native entrypoint is `@get-air/video-tauri/effect`.

## Compatibility

`@get-air/video-tauri` and `tauri-plugin-video` must use the same version.

| Adapter + crate | `@get-air/video` | Native protocol |
| --- | --- | --- |
| `0.2.x` | `>=0.1.1 <0.2.0` | `1` |

[API](docs/api.md) · [Examples](examples) · [Versioning](VERSIONING.md) ·
[Contributing](CONTRIBUTING.md)

MIT OR Apache-2.0
