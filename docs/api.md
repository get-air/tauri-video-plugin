# TypeScript API

The package has two deliberate entry points:

```ts
import { attachVideo, type VideoController } from 'tauri-plugin-video-api/headless'
import { VideoPlayer, TvVideoPlayer } from 'tauri-plugin-video-api/react'
import 'tauri-plugin-video-api/react/styles.css'
```

The root package export is also the headless API. React is an optional peer, so non-React applications can use the controller without installing React.

## Source

```ts
interface VideoSource {
  uri: string
  headers?: Record<string, string>
  cookies?: string
  userAgent?: string
  referrer?: string
  tlsCaFile?: string
  startPositionSeconds?: number
}
```

`tlsCaFile: "bundled"` selects the Android PEM bundle staged at build time. Other Android file paths must be inside app-accessible storage. Omitting the field uses the platform trust store.

## Attach options

```ts
interface AttachVideoOptions {
  source: string | VideoSource
  backend?: 'auto' | 'media3' | 'libvlc' | 'gstreamer' | 'mpv'
  autoplay?: boolean
  bufferAheadSeconds?: number
  transcodePolicy?: 'realtime' | 'preserve-quality' | 'hardware-only'
  suspendWhenHidden?: boolean
  deviceProfile?: 'auto' | 'mobile' | 'tv' | 'desktop'
  platform?: PlatformPlaybackOptions
  signal?: AbortSignal
}
```

`backend` is an explicit native-engine request. `auto` is the default and keeps
the optimized platform path: GStreamer on Linux and Media3 on Android/TV. An
explicit backend never silently falls into the WebView compatibility pipeline;
an unavailable or uncompiled backend rejects with a useful error.

```ts
await attachVideo(video, { source: url, backend: 'mpv' })    // Linux
await attachVideo(video, { source: url, backend: 'libvlc' }) // Android / TV
```

`bufferAheadSeconds` controls the compatibility broker. Native Android tuning lives under `platform.android` and `platform.androidTv`:

```ts
interface AndroidPlaybackOptions {
  buffer?: {
    minSeconds?: number
    maxSeconds?: number
    playSeconds?: number
    rebufferSeconds?: number
    maxBytes?: number
  }
  decoderFallback?: boolean
  compatibilityFallback?: 'libvlc' | 'disabled'
  startupTimeoutSeconds?: number
  dolbyVision?: 'hevc-base-layer' | 'platform'
  tunneling?: boolean
}
```

TV values merge over Android values. Media3/MediaCodec remains the first-choice hardware path. Unless disabled, LibVLC takes over on the same direct Android surface when Media3 has no usable video track, selects a non-native format, reports a decoder error, or fails to render before the startup deadline. Setting `backend: 'media3'` disables that compatibility handoff; setting `backend: 'libvlc'` starts LibVLC directly. Unsupported/omitted fields keep native defaults.

## Controller

```ts
interface VideoController extends EventTarget {
  readonly element: HTMLVideoElement
  readonly sessionId: string
  readonly media: MediaInfo
  readonly tracks: readonly MediaTrack[]
  play(): Promise<void>
  pause(): void
  seek(positionSeconds: number): Promise<void>
  selectTrack(kind: 'video' | 'audio' | 'subtitle', trackId?: string): Promise<void>
  setVolume(volume: number): Promise<void>
  setVideoFit(mode: 'fit' | 'cover' | 'stretch'): Promise<void>
  setVideoZoom(scale: number): Promise<void>
  stats(): Promise<SessionStats>
  bufferedAhead(): number
  playbackQuality(): PlaybackQuality
  on<K extends keyof VideoControllerEventMap>(
    type: K,
    listener: (event: VideoControllerEventMap[K]) => void,
  ): () => void
  destroy(): Promise<void>
}
```

`on()` is typed against `VideoControllerEventMap`, so TypeScript infers each `CustomEvent.detail` payload without casts and returns an unsubscribe function. Standard `addEventListener`/`removeEventListener` remain available through `EventTarget`.

Events:

| Event | Detail | Meaning |
| --- | --- | --- |
| `timeupdate` | `{ currentTime }` | Native/media clock changed |
| `bufferprogress` | `{ bufferedAhead }` | Playable reserve changed |
| `trackchange` | `{ kind, trackId }` | Selected track changed |
| `error` | `{ code, message }` | Recoverable or terminal backend error |

`media` and `tracks` are stable objects whose contents update as the backend discovers metadata. `stats()` performs a native snapshot; `playbackQuality()` is synchronous and returns the latest polled frame counters.

Always call `destroy()` or abort the provided signal when the owning view unmounts.

## React

`VideoPlayer` and `TvVideoPlayer` accept:

- `source`, `options`, `autoPlay`, `muted`, `controls`, `poster`, `title`;
- `className`/`style` for the root layout box;
- `children` for arbitrary HTML above the video;
- `reloadKey` when headers/options change without changing the URI;
- `onController`, `onReady`, and `onError` lifecycle callbacks.

`TvVideoPlayer` initializes Norigin once, uses stable focus keys, restores focus to Play after a source reload, seeks with D-pad Left/Right, and exposes larger TV focus states. Call `initializeTvNavigation()` yourself only when you need custom debug/throttle settings before mounting the first player.

The default overlay slot has `pointer-events: none`. To add an interactive overlay:

```css
.my-overlay { pointer-events: auto; }
```

The native video plane follows the element's rectangle. Keep the player inside the WebView bounds; CSS perspective/rotation and non-rectangular clipping cannot be represented by an Android `SurfaceView` even though ordinary position, size, fullscreen, fit/cover, border radius on the overlay, and responsive layout are supported.
