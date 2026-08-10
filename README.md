# tauri-plugin-video

Native video playback for Tauri on Linux, Windows, Android, and Android TV. The WebView
owns layout and controls while the platform player renders directly into a
native surface underneath it. Decoded frames never pass through JavaScript,
canvas, a localhost media bridge, or a plugin-owned transcoder.

## Backends

| Platform | `auto` | Explicit alternatives |
| --- | --- | --- |
| Linux | GStreamer | `mpv` when compiled with `mpv-runtime` |
| Android / TV | Media3 / MediaCodec | `libvlc` |
| Windows | GStreamer | None |

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

GStreamer is the default Linux and Windows feature. On Windows, install the
official MSVC x86-64 GStreamer runtime and development files. To make mpv
available as an explicit Linux setting, install libmpv development files and
enable both features:

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
  controlRegions: document.querySelectorAll('[data-player-ui]'),
})

await player.play()
await player.seek(60)
```

The `<video>` is a layout/API anchor. The controller mirrors standard media
state and events onto it while synchronizing the native surface to its CSS box.
No page, root, or player wrapper needs a transparent background: the package
opens and maintains the exact aperture automatically, including nested scrolling
clips. Mark HTML that is intentionally allowed over the video through
`controlRegions`, `controller.registerControls()`, or
`data-tauri-video-controls`. Unrelated page content is cut out only where it
crosses the aperture.

For an explicit alternative:

```ts
await attachVideo(anchor, { source: movieUrl, backend: 'mpv' })    // Linux
await attachVideo(anchor, { source: movieUrl, backend: 'libvlc' }) // Android
```

## React

```tsx
import { VideoPlayer } from 'tauri-plugin-video-api/react'

export function Player({ url }: { url: string }) {
  return <VideoPlayer source={url} autoPlay style={{ aspectRatio: '16 / 9' }} />
}
```

The React entry installs its scoped player styles automatically. Use
`VideoControlRegion` or `useVideoControlRegion()` for controls mounted elsewhere
in the page, such as a portal or application toolbar. The headless equivalent is
`controller.registerControls(element)`.

See [API](docs/api.md), [Linux](docs/linux.md), [Windows](docs/windows.md), and
[Android](docs/android.md).

## License

MIT or Apache-2.0, at your option.
