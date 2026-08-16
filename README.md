# Air video for Tauri

This repository contains the native Tauri adapter for Air video:

- the npm package `@get-air/video-tauri`;
- the Rust crate `tauri-plugin-video`;
- native playback engines for Linux, Windows, Android, and Android TV.

The platform-neutral player lives in
[`get-air/video`](https://github.com/get-air/video) and is published as
`@get-air/video`. That package owns the common controller, Effect service,
React/SolidTV/Blits integrations, HTML media, Tizen AVPlay, webOS/Vizio, and
MediaBunny's direct DOM/WebCodecs canvas playback. It has no Tauri dependency.

This adapter installs one additional backend ID, `tauri`, into the same API.
Applications can therefore switch between native and DOM backends without
forking their player UI.

## Native engines

| Target | Default native engine | Explicit alternative |
| --- | --- | --- |
| Linux | GStreamer | mpv with the `mpv-runtime` crate feature |
| Windows | GStreamer | — |
| Android / Android TV | Media3 / MediaCodec | LibVLC |

Decoded native frames stay outside JavaScript and the WebView. The plugin
renders into a platform surface below the WebView while the DOM remains
responsible for layout, controls, and overlays.

## Install

Install the common API and this adapter:

```sh
npm install @get-air/video @get-air/video-tauri
```

Add and register the Rust plugin:

```toml
[dependencies]
tauri-plugin-video = "0.1"
```

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_video::init())
    .run(tauri::generate_context!())?;
```

Add `video:default` to the Tauri capability used by the window.

GStreamer is enabled by default only on Linux and Windows; the desktop system
dependencies are target-scoped and are not built into Android applications. To
make mpv selectable on Linux, install libmpv development files and enable its
feature:

```toml
tauri-plugin-video = { version = "0.1", features = ["gstreamer-runtime", "mpv-runtime"] }
```

## Inject the Tauri backend

Create one client and pass it wherever the common package accepts a
`VideoClient`:

```ts
import { createTauriVideoClient } from '@get-air/video-tauri'

export const videoClient = createTauriVideoClient({
  playback: {
    android: { decoderFallback: true },
  },
})
```

The client exposes the same `attach` contract as `@get-air/video`:

```ts
const player = await videoClient.attach(document.querySelector('video')!, {
  source: movieUrl,
  backend: 'tauri',
  backendOptions: {
    tauri: { engine: 'auto' },
  },
})

await player.play()
await player.seek(60)
```

`createTauriVideoClient` includes every browser/TV backend from
`@get-air/video`; it only adds the native adapter. An ordered chain can give
MediaBunny first chance at an MKV and then fall back to the native player:

```ts
const player = await videoClient.attach(anchor, {
  source: movieUrl,
  backend: ['mediabunny', 'tauri'],
  backendOptions: {
    mediabunny: { maxCacheBytes: 32 * 1024 * 1024, parallelism: 2 },
    tauri: { engine: 'gstreamer' },
  },
})
```

MediaBunny still executes entirely inside `@get-air/video` as a DOM/WebCodecs
backend. This repository neither wraps nor reimplements it, and the adapter adds
no MediaBunny dependency of its own. The core package keeps that backend
runtime-lazy until selected.

For a compact Tauri-only import, `@get-air/video-tauri` also exports
`attachVideo` and `attachTauriVideo` backed by a default Tauri client.

## React

The React component stays in the platform-neutral package. Inject the client:

```tsx
import { VideoPlayer } from '@get-air/video/react'
import { createTauriVideoClient } from '@get-air/video-tauri'

const client = createTauriVideoClient()

export function Player({ url }: { url: string }) {
  return (
    <VideoPlayer
      client={client}
      source={url}
      options={{
        backend: 'tauri',
        backendOptions: { tauri: { engine: 'auto' } },
      }}
      autoPlay
    />
  )
}
```

The same client can be passed to `TvVideoPlayer`, `attachCanvasVideo`,
`attachBlitsVideo`, and the SolidTV adapter.

## Effect

`@get-air/video-tauri/effect` re-exports the common Effect API and contributes
the native backend layer:

```ts
import { layerHttpTransport } from '@get-air/http/effect'
import {
  attachVideoEffect,
  layerTauriVideoBackend,
  VideoPlayerService,
} from '@get-air/video-tauri/effect'
import { Effect, Layer } from 'effect'

const InfrastructureLive = Layer.mergeAll(
  layerHttpTransport({ fetch: (request) => fetch(request) }),
  layerTauriVideoBackend({ linux: { buffer: { maxSeconds: 15 } } }),
)
const VideoLive = VideoPlayerService.Default.pipe(
  Layer.provideMerge(InfrastructureLive),
)

const program = attachVideoEffect(anchor, {
  source: movieUrl,
  backend: 'tauri',
  backendOptions: { tauri: { engine: 'gstreamer' } },
})

const controller = await Effect.runPromise(program.pipe(Effect.provide(VideoLive)))
await Effect.runPromise(controller.play())
```

The returned `EffectVideoController` keeps playback, `load`, telemetry, and
lifecycle operations in the Effect error channel. Promise and Effect
entrypoints delegate to the same implementation.

## Native options

Native settings are namespaced under `backendOptions.tauri` or supplied as
defaults to `createTauriVideoClient`:

```ts
interface TauriPlaybackOptions {
  engine?: 'auto' | 'media3' | 'libvlc' | 'gstreamer' | 'mpv'
  android?: AndroidPlaybackOptions
  androidTv?: AndroidPlaybackOptions
  linux?: { buffer?: NativeBufferOptions }
  windows?: { buffer?: NativeBufferOptions }
}
```

Engine names no longer masquerade as platform backend IDs. `backend: 'tauri'`
selects this adapter; `backendOptions.tauri.engine` selects the engine behind it.

## Native aperture and controls

The supplied `<video>` is a layout/API anchor. The native surface follows its
CSS rectangle through resizing, scrolling, clipping, and fullscreen changes.
The compositor opens only that rectangle through otherwise opaque WebView
backgrounds and restores authored styles when playback closes.

Register DOM that is intentionally allowed over the native picture through
`controlRegions`, `controller.registerControls()`, or the backend-neutral
`data-air-video-controls` attribute. The marker is shared with
`@get-air/video`; there is no Tauri-specific control attribute.

Canvas renderers use the same injected client:

```ts
import { attachBlitsVideo } from '@get-air/video/blits'
import { createTauriVideoClient } from '@get-air/video-tauri'

const player = await attachBlitsVideo({
  client: createTauriVideoClient(),
  canvas,
  rect: { x: 426, y: 164, width: 1068, height: 600 },
  source: movieUrl,
  backend: 'tauri',
})
```

## 4K requirement

Air treats UHD playback as a release requirement. The native adapter does not
copy decoded frames through JavaScript or impose a resolution cap; 3840×2160
content stays on the selected platform decoder and presentation surface.
Actual codec/profile/frame-rate support still comes from the deployed GPU,
MediaCodec, GStreamer, or mpv stack, so release qualification must exercise the
target hardware with the production encode. The common package separately runs
an automated 3840×2160 MediaBunny browser qualification.

See the platform notes for engine-specific setup and acceptance checks:

- [Android and Android TV](https://github.com/get-air/tauri-video-plugin/blob/main/docs/android.md)
- [Linux](https://github.com/get-air/tauri-video-plugin/blob/main/docs/linux.md)
- [Windows](https://github.com/get-air/tauri-video-plugin/blob/main/docs/windows.md)
- [TypeScript adapter API](https://github.com/get-air/tauri-video-plugin/blob/main/docs/api.md)

Runnable integration applications live in the
[React/Tauri example](https://github.com/get-air/tauri-video-plugin/tree/main/examples/tauri-app)
and the
[SolidTV/Blits example](https://github.com/get-air/tauri-video-plugin/tree/main/examples/solid-tv-blits-app).
Browser-only MediaBunny and SolidTV examples live in
[`get-air/video`](https://github.com/get-air/video).

## Maintainer release bootstrap

The first `tauri-plugin-video` version must be published manually before
crates.io can associate a trusted publisher with it. After that first publish,
register `get-air/tauri-video-plugin` and the workflow file
`publish-crate.yml` as the crate's GitHub trusted publisher, then set the
repository variable `CRATES_IO_TRUSTED_PUBLISHING` to `enabled`. Future stable
GitHub releases publish through a short-lived crates.io token; until the
variable is enabled, the crate publishing job stays skipped. The workflow also
treats an already-published version as success, so enabling it during the
bootstrap release cannot upload the same crate twice.

## License

MIT or Apache-2.0, at your option.
