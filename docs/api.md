# Tauri adapter API

`@get-air/video-tauri` adds native Tauri playback to the platform-neutral
[`@get-air/video`](https://github.com/get-air/video) API. The common package
owns `VideoController`, backend fallback, subtitles, React/SolidTV/Blits
integrations, and DOM backends. This package owns only the
`tauri` adapter and its native settings.

## Client setup

```ts
import {
  createTauriVideoClient,
  type NativeVideoBackend,
  type TauriPlaybackOptions,
} from '@get-air/video-tauri'

const client = createTauriVideoClient({
  playback: {
    android: { decoderFallback: true },
    linux: { buffer: { maxSeconds: 15 } },
  },
})
```

`createTauriVideoClient` returns the core `VideoClient`. Its `attach` method has
the same signature on every platform:

```ts
const player = await client.attach(video, {
  source: { uri, headers, cookies, userAgent, referrer },
  backend: 'tauri',
  backendOptions: {
    tauri: { engine: 'gstreamer' },
  },
  controlRegions: document.querySelectorAll('.player-overlay'),
})
```

Client defaults and per-attachment settings are merged. Per-attachment settings
win.

## Native protocol compatibility

Before `native_open`, the adapter calls the read-only `native_diagnostics`
command and requires its integer protocol version to match. This catches an npm
adapter/Rust crate mismatch before a player or native surface is allocated.
The first successful verification is cached per JavaScript module; failed
checks remain retryable so startup-order and transient invoke errors can recover.
`video:default` includes the diagnostic command. Applications that enumerate
permissions individually must add `video:allow-native-diagnostics`.
`native_open` also sends the protocol and npm package version; the Rust command
rejects legacy or mismatched JavaScript before dispatching to a native engine.

```ts
import {
  getTauriVideoDiagnostics,
  TAURI_VIDEO_PROTOCOL_VERSION,
} from '@get-air/video-tauri'

const diagnostics = await getTauriVideoDiagnostics()
// {
//   protocolVersion: <integer>,
//   packageName: '@get-air/video-tauri',
//   packageVersion: '<npm version>',
//   crateName: 'tauri-plugin-video',
//   crateVersion: '<crate version>'
// }
```

An unequal version, malformed response, or older plugin without the diagnostic
command rejects attachment with `_tag: 'VideoNativeProtocolMismatchError'`.
The schema-backed error constructor is exported from
`@get-air/video-tauri/effect`; Promise callers can handle the serializable tag
and diagnostic fields without loading Effect on the successful path. Those
fields include `expectedProtocolVersion`, optional `actualProtocolVersion`, the
npm package name/version, optional native crate name/version, and an optional
`cause` when diagnostics could not be read.

Adding optional diagnostics or native capability fields is backward-compatible
and does not increment the protocol. Increment it only for incompatible command
names, payloads, responses, or serialized error shapes. Keep the npm adapter and
Rust crate on a compatible published pair.

## Tauri settings

```ts
type NativeVideoBackend =
  | 'auto'
  | 'media3'
  | 'libvlc'
  | 'gstreamer'
  | 'mpv'

interface TauriPlaybackOptions {
  engine?: NativeVideoBackend
  android?: AndroidPlaybackOptions
  androidTv?: AndroidPlaybackOptions
  linux?: LinuxPlaybackOptions
  windows?: WindowsPlaybackOptions
}

interface NativeBufferOptions {
  minSeconds?: number
  maxSeconds?: number
  playSeconds?: number
  rebufferSeconds?: number
  maxBytes?: number
}

interface AndroidPlaybackOptions {
  buffer?: NativeBufferOptions
  decoderFallback?: boolean
  dolbyVision?: 'hevc-base-layer' | 'platform'
  tunneling?: boolean
}

interface LinuxPlaybackOptions {
  buffer?: NativeBufferOptions
}

interface WindowsPlaybackOptions {
  buffer?: NativeBufferOptions
}
```

`backend: 'tauri'` selects this adapter.
`backendOptions.tauri.engine` selects the native implementation behind it.
Engine names are not standalone core backend IDs.

Omit `buffer` to leave cache policy to Media3, LibVLC, GStreamer, or mpv.
Overrides are demand-allocated encoded-data targets, not process-memory limits;
decoded frames, decoder reference surfaces, GPU textures, and the WebView remain
outside them.

`decoderFallback` lets Media3 try another installed MediaCodec decoder without
switching to LibVLC. `androidTv` is merged over `android` when the core attach
options use `deviceProfile: 'tv'`.

## Explicit backend

The Tauri client retains every built-in adapter from `@get-air/video`. Backend
selection and fallback therefore use the common API:

```ts
const player = await client.attach(video, {
  source: movieUrl,
  backend: 'tauri',
  backendOptions: {
    tauri: { engine: 'gstreamer' },
  },
})
```

## Convenience entrypoints

For applications that do not need to inject a client, this package exposes a
default Tauri-enabled façade:

```ts
import { attachTauriVideo, attachVideo } from '@get-air/video-tauri'

const native = await attachTauriVideo(video, { source: movieUrl })
const explicit = await attachVideo(video, { source: movieUrl, backend: 'tauri' })
```

`attachTauriVideo` forces `backend: 'tauri'`. `attachVideo` keeps the common
core default (`html`) unless a backend is supplied. Explicit client injection
is recommended for applications with dependency layers, tests, or multiple
player configurations.

Advanced integrations can use `tauriVideoBackend(defaults)` to obtain the raw
`VideoBackendAdapter`, or `attachTauriBackend` to open a backend controller
without the stable switching façade.

## React and canvas integrations

Framework integrations remain in `@get-air/video`; pass the client as a prop or
option:

```tsx
import { VideoPlayer } from '@get-air/video/react'
import { createTauriVideoClient } from '@get-air/video-tauri'

const client = createTauriVideoClient()

export function Player() {
  return <VideoPlayer
    client={client}
    source={movieUrl}
    options={{
      backend: 'tauri',
      backendOptions: { tauri: { engine: 'gstreamer' } },
    }}
  />
}
```

```ts
import { attachBlitsVideo } from '@get-air/video/blits'

const player = await attachBlitsVideo({
  client,
  canvas,
  rect,
  source: movieUrl,
  backend: 'tauri',
})
```

`VideoPlayer`, `TvVideoPlayer`, `attachCanvasVideo`, `attachBlitsVideo`, and the
SolidTV adapter all accept the same client.

## Effect layer

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
  layerTauriVideoBackend({ android: { decoderFallback: true } }),
)
const VideoLive = VideoPlayerService.Default.pipe(
  Layer.provideMerge(InfrastructureLive),
)

const program = attachVideoEffect(video, {
  source: movieUrl,
  backend: 'tauri',
})

const controller = await Effect.runPromise(program.pipe(Effect.provide(VideoLive)))
await Effect.runPromise(controller.play())
```

`layerTauriVideoBackend` supplies the core backend-registry service. The
returned `EffectVideoController` keeps playback and lifecycle operations in the
Effect channel; the Promise and Effect surfaces share the same adapter
implementation.

## Native layout and controls

The common controller's `<video>` element is the geometry anchor. Linux and
Android place native surfaces at its visible CSS rectangle and commit matching
WebView apertures. Windows inserts a WebGL canvas into the media slot and sends
decoded frames through a raw Tauri channel, so video and overlays are ordinary
pixels in the same WebView. Windows hosts do not need transparent windows or
special window configuration.

Register intentional overlay UI through any common mechanism:

```ts
const player = await client.attach(video, {
  source: movieUrl,
  backend: 'tauri',
  controlRegions: document.querySelectorAll('.player-overlay'),
})

const unregister = player.registerControls(document.querySelector('.transport')!)
// Later: unregister(); await player.destroy()
```

Declarative markup uses the backend-neutral `data-air-video-controls` marker.

Always call `destroy()` or abort the supplied signal when the owning view
unmounts. `load()` keeps controller identity and subscriptions stable while
replacing the active source/backend session.

For the complete controller, events, subtitle, and capability contracts, see
the [`@get-air/video` API documentation](https://github.com/get-air/video/blob/main/docs/api.md).
