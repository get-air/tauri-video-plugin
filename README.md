# tauri-plugin-video

Native video playback for Tauri on Linux, Android, and Android TV. The WebView
owns layout and controls while the platform player renders directly into a
native surface underneath it. Decoded frames never pass through JavaScript,
canvas, a localhost media bridge, or a plugin-owned transcoder.

## Backends

| Platform | `auto` | Explicit alternatives |
| --- | --- | --- |
| Linux | GStreamer | `mpv` when compiled with `mpv-runtime` |
| Android / TV | Media3 / MediaCodec | `libvlc` |
| Windows | Not supported | None |

Alternative backends are never selected automatically. Media3's
`decoderFallback` setting may try another installed MediaCodec decoder, but it
does not switch to LibVLC.

## Install

The npm and crates.io packages are not published yet. Register the Rust plugin
and add `video:default` to the Tauri capability:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_video::init())
    .run(tauri::generate_context!())?;
```

GStreamer is the default Linux feature. To make mpv available as an explicit
setting, install libmpv development files and enable both features:

```toml
tauri-plugin-video = { version = "0.1", features = ["gstreamer-runtime", "mpv-runtime"] }
```

## Headless API

```ts
import { attachVideo } from 'tauri-plugin-video-api/headless'

const anchor = document.querySelector('video')!
const player = await attachVideo(anchor, {
  source: movieUrl,
  backend: 'auto',
})

await player.play()
await player.seek(60)
```

The `<video>` is a layout/API anchor. The controller mirrors standard media
state and events onto it while synchronizing the native surface to its CSS box.
Ordinary HTML controls and overlays remain above the native video.

For an explicit alternative:

```ts
await attachVideo(anchor, { source: movieUrl, backend: 'mpv' })    // Linux
await attachVideo(anchor, { source: movieUrl, backend: 'libvlc' }) // Android
```

## React

```tsx
import { VideoPlayer } from 'tauri-plugin-video-api/react'
import 'tauri-plugin-video-api/react/styles.css'

export function Player({ url }: { url: string }) {
  return <VideoPlayer source={url} autoPlay />
}
```

See [API](docs/api.md), [Linux](docs/linux.md), and [Android](docs/android.md).

## License

MIT or Apache-2.0, at your option.
