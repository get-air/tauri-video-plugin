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
  destroy(): Promise<void>
}
```

Always call `destroy()` or abort the supplied signal when the owning view
unmounts.
