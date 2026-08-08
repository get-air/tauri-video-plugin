# TypeScript API

```ts
import { attachVideo, type VideoController } from 'tauri-plugin-video-api/headless'
```

## Attach options

```ts
interface AttachVideoOptions {
  source: string | VideoSource
  backend?: 'auto' | 'media3' | 'libvlc' | 'gstreamer' | 'mpv'
  autoplay?: boolean
  suspendWhenHidden?: boolean
  deviceProfile?: 'auto' | 'mobile' | 'tv' | 'desktop'
  platform?: PlatformPlaybackOptions
  controlRegions?: Element | Iterable<Element>
  signal?: AbortSignal
}
```

`auto` selects GStreamer on Linux and Media3 on Android. `mpv` and `libvlc`
are explicit settings; playback never switches engines after an error. Windows
currently has no backend and `attachVideo()` rejects there.

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

interface PlatformPlaybackOptions {
  android?: AndroidPlaybackOptions
  androidTv?: AndroidPlaybackOptions
  linux?: { buffer?: NativeBufferOptions }
}
```

Omit `buffer` to let Media3, LibVLC, GStreamer, or mpv manage buffering using
its own stream-aware defaults. Overrides are demand-allocated targets, not
memory reservations, and do not include decoded frames or GPU textures.

`decoderFallback` only controls Media3's internal decoder selection. The
default Dolby Vision mode selects the HEVC base layer for problematic profile 7
device decoders; set `platform` to leave selection entirely to Android.

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
  registerControls(target: Element | Iterable<Element>): () => void
  destroy(): Promise<void>
}
```

Always call `destroy()` or abort the supplied signal when the owning view
unmounts.

## Layout, transparency, and controls

The supplied `<video>` is an ordinary layout anchor. It may be placed inside
grids, flex layouts, positioned cards, and nested scroll containers. When a
native session opens, the package makes the WebView backing layer transparent,
temporarily clears the anchor's ancestor backgrounds, and reconstructs those
backgrounds around the exact native rectangle. Solid colors, gradients,
background images, padding, borders, viewport clipping, and nested overflow
clipping are handled without changing the application's authored CSS. Ancestor
class/style changes and reparenting are observed and repaired automatically.

The compositor also clips unrelated DOM branches only where they cross the
aperture. This matters for fixed/fullscreen players: an opaque header or old page
content geometrically behind the player cannot accidentally cover the native
video. Intentional controls and overlays are exempt. They do not have to overlap
the video or share its parent, but UI that does cross the video must be registered
through `controlRegions`, `registerControls()`, or the
`data-tauri-video-controls` attribute. A toolbar or portal works normally:

```ts
const player = await attachVideo(document.querySelector('video')!, {
  source: movieUrl,
  controlRegions: document.querySelectorAll('.player-overlay'),
})

const unregister = player.registerControls(document.querySelector('.transport')!)
// Later: unregister(); await player.destroy()
```

React's `VideoPlayer` installs its own scoped CSS; importing a separate
stylesheet is not required. `VideoControlRegion` and `useVideoControlRegion()`
provide the same control-region marker for UI mounted elsewhere.

The native renderer is rectangular. Border radii and rectangular overflow clips
are recreated by the compositor, but arbitrary 3D transforms, rotation, pseudo-
element-only masks, and custom non-rectangular CSS masks on the video anchor
cannot be reproduced by the platform surface.
