import type { AttachVideoOptions, TrackKind } from '@get-air/video'

export type NativeVideoBackend = 'media3' | 'libvlc' | 'gstreamer' | 'mpv'
export type NativePlatform = 'android' | 'windows' | 'linux'

export interface NativeBufferOptions {
  minSeconds?: number
  maxSeconds?: number
  playSeconds?: number
  rebufferSeconds?: number
  maxBytes?: number
}

export interface AndroidPlaybackOptions {
  buffer?: NativeBufferOptions
  decoderFallback?: boolean
  dolbyVision?: 'hevc-base-layer' | 'platform'
  tunneling?: boolean
}

export interface LinuxPlaybackOptions { buffer?: NativeBufferOptions }
export interface WindowsPlaybackOptions { buffer?: NativeBufferOptions }

export interface TauriPlaybackOptions {
  engine?: NativeVideoBackend
  android?: AndroidPlaybackOptions
  androidTv?: AndroidPlaybackOptions
  linux?: LinuxPlaybackOptions
  windows?: WindowsPlaybackOptions
}

/** Internal native settings consumed only by the Tauri adapter. */
export interface NativeAttachVideoOptions extends AttachVideoOptions {
  backend?: 'tauri'
  playback?: TauriPlaybackOptions
}

export interface NativePlaybackSnapshot {
  durationSeconds: number
  currentTimeSeconds: number
  bufferedSeconds: number
  /** True when the native engine is attached to an unbounded live timeline. */
  live?: boolean
  /** True when the active VOD or live window accepts absolute seeks. */
  seekable?: boolean
  /** Current absolute seek-window bounds, when the engine exposes them. */
  seekableStartSeconds?: number
  seekableEndSeconds?: number
  playing: boolean
  videoWidth: number
  videoHeight: number
  presentedFrames?: number
  droppedFrames?: number
  measuredFps?: number
  hardwareBackend?: string
  encodedBytesBuffered?: number
  averageFrameProcessingUs?: number
  container?: string
  tracks: Array<{
    id: string
    index: number
    kind: TrackKind
    language: string
    label: string
    codec: string
    selected: boolean
  }>
}

export function nativePlatform(): NativePlatform {
  if (/Android/i.test(navigator.userAgent)) return 'android'
  if (/Windows/i.test(navigator.userAgent)) return 'windows'
  return 'linux'
}

export function nativeOpenSettings(
  options: NativeAttachVideoOptions,
  platform: NativePlatform,
): Record<string, unknown> {
  const playback = options.playback
  const android = platform === 'android'
  const tv = options.deviceProfile === 'tv'
    || ((options.deviceProfile === undefined || options.deviceProfile === 'auto')
      && /\bTV\b|AFT|BRAVIA|SHIELD|GoogleTV/i.test(navigator.userAgent))
  const androidOptions = android
    ? { ...playback?.android, ...(tv ? playback?.androidTv : undefined) }
    : undefined
  const buffer = androidOptions?.buffer
    ?? (platform === 'linux' ? playback?.linux?.buffer : undefined)
    ?? (platform === 'windows' ? playback?.windows?.buffer : undefined)
  return {
    backend: playback?.engine,
    minBufferMs: secondsToMilliseconds(buffer?.minSeconds),
    maxBufferMs: secondsToMilliseconds(buffer?.maxSeconds),
    playbackBufferMs: secondsToMilliseconds(buffer?.playSeconds),
    rebufferMs: secondsToMilliseconds(buffer?.rebufferSeconds),
    targetBufferBytes: buffer?.maxBytes,
    decoderFallback: androidOptions?.decoderFallback,
    dolbyVisionMode: androidOptions?.dolbyVision,
    tunneling: androidOptions?.tunneling,
  }
}

function secondsToMilliseconds(value?: number): number | undefined {
  return value === undefined ? undefined : Math.max(0, Math.round(value * 1000))
}
