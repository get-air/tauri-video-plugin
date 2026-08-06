import { invoke } from '@tauri-apps/api/core'
import {
  sameNativeSurfacePosition,
  snapNativeSurfaceLayout,
  visibleSurfaceBounds,
  type NativeSurfaceLayout,
  type NativeSurfacePosition,
} from './native-surface-layout'

const COMMAND = 'plugin:video|'
const DEFAULT_MIME_TYPES = [
  'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',
  'video/mp4; codecs="avc1.640028,mp4a.40.2"',
  'video/mp4; codecs="hvc1.2.4.L153.B0,mp4a.40.2"',
  'video/mp4; codecs="hev1.2.4.L153.B0,mp4a.40.2"',
  'video/mp4; codecs="hvc1.2.4.L153.B0,ec-3"',
  'video/mp4; codecs="hev1.2.4.L153.B0,ec-3"',
]

export type PlaybackMode = 'native-decode' | 'remux' | 'hybrid-remux' | 'hardware-transcode' | 'software-transcode'
export type PlaybackState = 'playing' | 'paused' | 'suspended'
export type TrackKind = 'video' | 'audio' | 'subtitle'
export type TranscodePolicy = 'realtime' | 'preserve-quality' | 'hardware-only'
export type VideoFitMode = 'fit' | 'cover' | 'stretch'
export type DeviceProfile = 'auto' | 'mobile' | 'tv' | 'desktop'

export interface VideoSource {
  uri: string
  headers?: Record<string, string>
  cookies?: string
  userAgent?: string
  referrer?: string
  tlsCaFile?: string
  startPositionSeconds?: number
}

export interface BrowserCapabilities {
  mediaSource: boolean
  managedMediaSource: boolean
  supportedMimeTypes: string[]
  hardwareConcurrency?: number
  userAgent?: string
}

export interface MediaTrack {
  id: string
  kind: TrackKind
  streamIndex: number
  codec: string
  caps: string
  label?: string
  language?: string
  selected: boolean
  default: boolean
  forced: boolean
  width?: number
  height?: number
  frameRate?: number
  channels?: number
  sampleRate?: number
}

export interface Chapter {
  id: string
  title?: string
  startSeconds: number
  endSeconds?: number
}

export interface MediaInfo {
  durationSeconds?: number
  seekable: boolean
  live: boolean
  container?: string
  tracks: MediaTrack[]
  chapters: Chapter[]
}

export interface FragmentTransport {
  baseUrl: string
  generation: number
  mimeType: string
  initUrl: string
  fragmentUrlTemplate: string
  subtitleUrlTemplate: string
}

export interface SubtitleCue {
  startSeconds: number
  endSeconds: number
  text: string
}

export interface SessionDescriptor {
  sessionId: string
  mode: PlaybackMode
  media: MediaInfo
  transport: FragmentTransport
}

export interface SessionStats {
  sessionId?: string
  mode?: PlaybackMode
  generation: number
  bytesFetched: number
  encodedBytesBuffered: number
  fragmentsBuffered: number
  sourceBufferAheadSeconds: number
  transcodeSpeed?: number
  inputVideoCodec?: string
  outputVideoCodec?: string
  inputAudioCodec?: string
  outputAudioCodec?: string
  hardwareBackend?: string
  decodedFrameCopies: number
  droppedFrames: number
  avDriftMilliseconds?: number
  averageFrameProcessingUs?: number
  visible: boolean
  state?: PlaybackState
}

export interface PlaybackQuality {
  presentedFrames: number
  mediaTimeSeconds?: number
  measuredFps: number
  totalVideoFrames: number
  droppedVideoFrames: number
  droppedFramePercent: number
}

export interface RuntimeCapabilities {
  available: boolean
  version?: string
  pluginVersion: string
  minAndroidSdk: number
  platform: string
  elements: Record<string, boolean>
  supportedInputSchemes: string[]
  limits: {
    globalMemoryMib: number
    sessionMemoryMib: number
    maxTranscoders: number
  }
  error?: string
}

export interface AttachVideoOptions {
  source: string | VideoSource
  /** Native playback engine. `auto` keeps the platform default and its configured fallback. */
  backend?: VideoBackend
  transcodePolicy?: TranscodePolicy
  bufferAheadSeconds?: number
  suspendWhenHidden?: boolean
  autoplay?: boolean
  deviceProfile?: DeviceProfile
  platform?: PlatformPlaybackOptions
  signal?: AbortSignal
}

export type VideoBackend = 'auto' | 'media3' | 'libvlc' | 'gstreamer' | 'mpv'

export interface NativeBufferOptions {
  /** Minimum encoded reserve before the native backend tries to refill. */
  minSeconds?: number
  /** Maximum encoded reserve. The backend may stop sooner at maxBytes. */
  maxSeconds?: number
  /** Reserve required for initial playback. */
  playSeconds?: number
  /** Reserve required after a rebuffer. */
  rebufferSeconds?: number
  /** Hard encoded-buffer target. Decoder surfaces are not included. */
  maxBytes?: number
}

export interface AndroidPlaybackOptions {
  buffer?: NativeBufferOptions
  decoderFallback?: boolean
  /** Direct-SurfaceView compatibility backend for codecs or containers rejected by Media3. */
  compatibilityFallback?: 'libvlc' | 'disabled'
  /** Time allowed for Media3 to render its first frame before compatibility fallback. */
  startupTimeoutSeconds?: number
  dolbyVision?: 'hevc-base-layer' | 'platform'
  tunneling?: boolean
}

export interface LinuxPlaybackOptions {
  buffer?: NativeBufferOptions
}

export interface WindowsPlaybackOptions {
  buffer?: NativeBufferOptions
}

export interface PlatformPlaybackOptions {
  android?: AndroidPlaybackOptions
  /** Merged over android when deviceProfile is tv. */
  androidTv?: AndroidPlaybackOptions
  linux?: LinuxPlaybackOptions
  windows?: WindowsPlaybackOptions
}

export interface VideoControllerEventMap {
  timeupdate: CustomEvent<{ currentTime: number }>
  bufferprogress: CustomEvent<{ bufferedAhead: number }>
  trackchange: CustomEvent<{ kind: TrackKind; trackId?: string }>
  error: CustomEvent<VideoPluginError>
}

/** Framework-neutral playback contract returned by every rendering backend. */
export interface VideoController extends EventTarget {
  readonly element: HTMLVideoElement
  readonly sessionId: string
  readonly media: MediaInfo
  readonly tracks: readonly MediaTrack[]
  play(): Promise<void>
  pause(): void
  seek(positionSeconds: number): Promise<void>
  selectTrack(kind: TrackKind, trackId?: string): Promise<void>
  setVolume(volume: number): Promise<void>
  setVideoFit(mode: VideoFitMode): Promise<void>
  setVideoZoom(scale: number): Promise<void>
  stats(): Promise<SessionStats>
  bufferedAhead(): number
  playbackQuality(): PlaybackQuality
  destroy(): Promise<void>
  /** Subscribe to a typed controller event. Returns an unsubscribe function. */
  on<K extends keyof VideoControllerEventMap>(
    type: K,
    listener: (event: VideoControllerEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): () => void
}

export interface VideoPluginError {
  code: string
  message: string
}

interface NativePlaybackSnapshot {
  durationSeconds: number
  currentTimeSeconds: number
  bufferedSeconds: number
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

export function detectBrowserCapabilities(): BrowserCapabilities {
  const MediaSourceConstructor = getMediaSourceConstructor()
  return {
    mediaSource: Boolean(MediaSourceConstructor),
    managedMediaSource: 'ManagedMediaSource' in globalThis,
    supportedMimeTypes: MediaSourceConstructor
      ? DEFAULT_MIME_TYPES.filter((mime) => MediaSourceConstructor.isTypeSupported(mime))
      : [],
    hardwareConcurrency: navigator.hardwareConcurrency,
    userAgent: navigator.userAgent,
  }
}

export async function runtimeCapabilities(): Promise<RuntimeCapabilities> {
  return invoke<RuntimeCapabilities>(`${COMMAND}runtime_capabilities`)
}

export async function createSession(
  source: string | VideoSource,
  options: Omit<AttachVideoOptions, 'source' | 'signal' | 'suspendWhenHidden'> = {},
): Promise<SessionDescriptor> {
  return invoke<SessionDescriptor>(`${COMMAND}create_session`, {
    payload: {
      source: typeof source === 'string' ? { uri: source } : source,
      browser: detectBrowserCapabilities(),
      transcodePolicy: options.transcodePolicy ?? 'realtime',
      bufferAheadSeconds: options.bufferAheadSeconds,
    },
  })
}

export class TauriVideoController extends EventTarget implements VideoController {
  readonly element: HTMLVideoElement
  descriptor: SessionDescriptor

  #sourceBuffer?: SourceBuffer
  #objectUrl?: string
  #pumpRevision = 0
  #destroyed = false
  #nativeSeeking = false
  #observer?: IntersectionObserver
  #textTrack?: TextTrack
  #listeners: Array<readonly [string, EventListener]> = []
  #signal?: AbortSignal
  #presentedFrames = 0
  #mediaTimeSeconds = 0
  #lastFrameNow?: number
  #frameTimes: number[] = []
  #videoFrameHandle?: number
  #startupBufferSeconds: number
  #transportMutation: Promise<void> = Promise.resolve()

  constructor(element: HTMLVideoElement, descriptor: SessionDescriptor, options: AttachVideoOptions) {
    super()
    this.element = element
    this.descriptor = descriptor
    this.#signal = options.signal
    // UHD remuxes can exceed 100 Mbit/s. A three-second reserve is too small
    // for ordinary Wi-Fi/CDN jitter, while six seconds remains bounded.
    this.#startupBufferSeconds = Math.min(6, Math.max(3, options.bufferAheadSeconds ?? 8))
    this.#bindElement(options.suspendWhenHidden ?? true)
    this.#startFrameTelemetry()
  }

  get sessionId(): string {
    return this.descriptor.sessionId
  }

  get media(): MediaInfo {
    return this.descriptor.media
  }

  get tracks(): readonly MediaTrack[] {
    return this.descriptor.media.tracks
  }

  on<K extends keyof VideoControllerEventMap>(
    type: K,
    listener: (event: VideoControllerEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): () => void {
    const eventListener = listener as EventListener
    this.addEventListener(type, eventListener, options)
    return () => this.removeEventListener(type, eventListener, options)
  }

  async start(): Promise<void> {
    if (this.#signal?.aborted) throw this.#signal.reason
    this.#signal?.addEventListener('abort', () => void this.destroy(), { once: true })
    // A paused GStreamer pipeline cannot always finish the fragmented-MP4
    // initialization segment. Prime the producer while MediaSource opens, then
    // restore the requested paused state before returning to the caller.
    const transportReady = this.#startTransport(this.descriptor.transport)
    await invoke(`${COMMAND}set_playback_state`, {
      payload: { sessionId: this.sessionId, state: 'playing' },
    })
    try {
      await transportReady
    } finally {
      if (this.element.paused) {
        await invoke(`${COMMAND}set_playback_state`, {
          payload: { sessionId: this.sessionId, state: 'paused' },
        }).catch(() => undefined)
      }
    }
  }

  async play(): Promise<void> {
    await this.element.play()
  }

  pause(): void {
    this.element.pause()
  }

  async setVolume(volume: number): Promise<void> {
    if (!Number.isFinite(volume)) throw new RangeError('volume must be finite')
    this.element.volume = Math.min(1, Math.max(0, volume))
  }

  async seek(positionSeconds: number): Promise<void> {
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0) {
      throw new RangeError('positionSeconds must be a finite, non-negative number')
    }
    return this.#enqueueTransportMutation(async () => {
      const resumePlayback = !this.element.paused
      this.#mediaTimeSeconds = positionSeconds
      this.#lastFrameNow = undefined
      this.#nativeSeeking = true
      try {
        const response = await invoke<{ generation: number; transport: FragmentTransport }>(
          `${COMMAND}seek`,
          { payload: { sessionId: this.sessionId, positionSeconds } },
        )
        await this.#startTransport(response.transport, positionSeconds)
        if (resumePlayback) await this.element.play()
      } finally {
        this.#nativeSeeking = false
      }
    })
  }

  async selectTrack(kind: TrackKind, trackId?: string): Promise<void> {
    return this.#enqueueTransportMutation(async () => {
      const positionSeconds = this.element.currentTime
      const resumePlayback = !this.element.paused
      this.#nativeSeeking = true
      try {
        const response = await invoke<{ generation: number; transport: FragmentTransport }>(
          `${COMMAND}select_track`,
          {
            payload: {
              sessionId: this.sessionId,
              kind,
              trackId: trackId ?? null,
              positionSeconds,
            },
          },
        )
        for (const track of this.descriptor.media.tracks) {
          if (track.kind === kind) track.selected = track.id === trackId
        }
        await this.#startTransport(response.transport, positionSeconds)
        if (resumePlayback) await this.element.play()
        this.dispatchEvent(new CustomEvent('trackchange', { detail: { kind, trackId } }))
      } finally {
        this.#nativeSeeking = false
      }
    })
  }

  async stats(): Promise<SessionStats> {
    return invoke<SessionStats>(`${COMMAND}session_stats`, {
      payload: { sessionId: this.sessionId },
    })
  }

  bufferedAhead(): number {
    return bufferedAhead(this.element.buffered, this.element.currentTime)
  }

  playbackQuality(): PlaybackQuality {
    const nativeQuality = this.element.getVideoPlaybackQuality?.()
    const first = this.#frameTimes[0]
    const last = this.#frameTimes[this.#frameTimes.length - 1]
    const measuredFps = first !== undefined && last !== undefined && last > first
      ? ((this.#frameTimes.length - 1) * 1000) / (last - first)
      : 0
    const totalVideoFrames = nativeQuality?.totalVideoFrames ?? this.#presentedFrames
    const droppedVideoFrames = nativeQuality?.droppedVideoFrames ?? 0
    return {
      presentedFrames: this.#presentedFrames,
      mediaTimeSeconds: this.#mediaTimeSeconds,
      measuredFps,
      totalVideoFrames,
      droppedVideoFrames,
      droppedFramePercent: totalVideoFrames > 0 ? (droppedVideoFrames / totalVideoFrames) * 100 : 0,
    }
  }

  async setVideoFit(mode: VideoFitMode): Promise<void> {
    this.element.style.objectFit = mode === 'cover' ? 'cover' : mode === 'stretch' ? 'fill' : 'contain'
  }

  async setVideoZoom(scale: number): Promise<void> {
    this.element.style.scale = String(Math.min(2, Math.max(1, scale)))
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#pumpRevision += 1
    this.#observer?.disconnect()
    if (this.#videoFrameHandle !== undefined) {
      this.element.cancelVideoFrameCallback?.(this.#videoFrameHandle)
      this.#videoFrameHandle = undefined
    }
    for (const [name, listener] of this.#listeners) this.element.removeEventListener(name, listener)
    this.#listeners = []
    this.#clearMediaSource()
    await invoke(`${COMMAND}destroy_session`, { payload: { sessionId: this.sessionId } })
  }

  async #startTransport(transport: FragmentTransport, targetTime?: number): Promise<void> {
    const MediaSourceConstructor = getMediaSourceConstructor()
    if (!MediaSourceConstructor) throw new Error('MediaSource is unavailable in this WebView')
    const revision = ++this.#pumpRevision
    this.#clearMediaSource()

    const mediaSource = new MediaSourceConstructor()
    this.#objectUrl = URL.createObjectURL(mediaSource)
    this.element.src = this.#objectUrl
    await once(mediaSource, 'sourceopen')
    if (revision !== this.#pumpRevision || this.#destroyed) return

    const sourceBuffer = mediaSource.addSourceBuffer(transport.mimeType)
    sourceBuffer.mode = 'segments'
    this.#sourceBuffer = sourceBuffer
    await appendBuffer(
      sourceBuffer,
      await pollBytes(transport.initUrl, revision, () => this.#pumpRevision),
      'initialization segment',
    )

    let transportReady: Promise<void>
    if (targetTime !== undefined) {
      // A freshly muxed post-seek stream starts its media timestamps at zero.
      // Offset it onto the original HTML timeline before appending fragments.
      sourceBuffer.timestampOffset = targetTime
      // loadedmetadata may fire while only the initialization segment exists.
      // Keep the seek promise pending until a media range contains the target
      // and the video element has presented the new decoder position.
      transportReady = waitForBufferedTarget(
        this.element,
        sourceBuffer,
        targetTime,
        () => revision === this.#pumpRevision && !this.#destroyed,
      )
    } else {
      transportReady = waitForInitialBuffer(
        this.element,
        sourceBuffer,
        mediaSource,
        this.#startupBufferSeconds,
        () => revision === this.#pumpRevision && !this.#destroyed,
      )
    }
    void this.#pumpFragments(transport, sourceBuffer, mediaSource, revision)
    if (this.tracks.some((track) => track.kind === 'subtitle' && track.selected)) {
      this.#prepareTextTrack()
      void this.#pumpSubtitles(transport, revision)
    } else {
      this.#clearTextTrack()
    }
    await transportReady
  }

  async #pumpFragments(
    transport: FragmentTransport,
    sourceBuffer: SourceBuffer,
    mediaSource: MediaSource,
    revision: number,
  ): Promise<void> {
    let sequence = 0
    try {
      while (!this.#destroyed && revision === this.#pumpRevision) {
        const url = transport.fragmentUrlTemplate.replace('{sequence}', String(sequence))
        const response = await fetch(url, { cache: 'no-store', signal: this.#signal })
        if (response.status === 204) {
          await delay(25)
          continue
        }
        if (response.status === 410) {
          sequence = Number(response.headers.get('x-next-sequence') ?? sequence + 1)
          continue
        }
        if (response.status === 416) {
          if (mediaSource.readyState === 'open' && !sourceBuffer.updating) mediaSource.endOfStream()
          return
        }
        if (response.status === 409 || revision !== this.#pumpRevision) return
        if (!response.ok) {
          const detail = (await response.text()).trim().slice(0, 512)
          throw new Error(
            `fragment ${sequence} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
          )
        }
        await appendBuffer(
          sourceBuffer,
          new Uint8Array(await response.arrayBuffer()),
          `media fragment ${sequence}`,
        )
        await trimPlayedMedia(sourceBuffer, this.element.currentTime)
        sequence += 1
        this.dispatchEvent(
          new CustomEvent('bufferprogress', {
            detail: { sequence, bufferedAhead: this.bufferedAhead() },
          }),
        )
      }
    } catch (error) {
      if (!this.#destroyed && revision === this.#pumpRevision && !this.#signal?.aborted) {
        this.dispatchEvent(new CustomEvent('error', { detail: normalizeError(error) }))
      }
    }
  }

  async #pumpSubtitles(transport: FragmentTransport, revision: number): Promise<void> {
    let sequence = 0
    try {
      while (!this.#destroyed && revision === this.#pumpRevision) {
        const url = transport.subtitleUrlTemplate.replace('{sequence}', String(sequence))
        const response = await fetch(url, { cache: 'no-store', signal: this.#signal })
        if (response.status === 204) {
          await delay(50)
          continue
        }
        if (response.status === 410) {
          sequence = Number(response.headers.get('x-next-sequence') ?? sequence + 1)
          continue
        }
        if (response.status === 416 || response.status === 409) return
        if (!response.ok) throw new Error(`subtitle cue ${sequence} failed with HTTP ${response.status}`)
        const cue = (await response.json()) as SubtitleCue
        const textCue = new VTTCue(cue.startSeconds, cue.endSeconds, cue.text)
        // Keep subtitles clear of the overlaid transport controls in both the
        // embedded and fullscreen player.
        textCue.line = -3
        textCue.position = 50
        textCue.align = 'center'
        this.#textTrack?.addCue(textCue)
        sequence += 1
      }
    } catch (error) {
      if (!this.#destroyed && revision === this.#pumpRevision && !this.#signal?.aborted) {
        this.dispatchEvent(new CustomEvent('error', { detail: normalizeError(error) }))
      }
    }
  }

  #prepareTextTrack(): void {
    this.#clearTextTrack()
    const selected = this.tracks.find((track) => track.kind === 'subtitle' && track.selected)
    this.#textTrack = this.element.addTextTrack(
      'subtitles',
      selected?.label ?? selected?.language ?? 'Subtitles',
      selected?.language ?? '',
    )
    this.#textTrack.mode = 'showing'
  }

  #clearTextTrack(): void {
    if (!this.#textTrack) return
    const cues = this.#textTrack.cues
    if (cues) {
      for (let index = cues.length - 1; index >= 0; index -= 1) {
        this.#textTrack.removeCue(cues[index])
      }
    }
    this.#textTrack.mode = 'disabled'
    this.#textTrack = undefined
  }

  #bindElement(suspendWhenHidden: boolean): void {
    this.#listen('play', () => !this.#nativeSeeking && void this.#setState('playing'))
    this.#listen('pause', () => !this.#nativeSeeking && void this.#setState('paused'))
    this.#listen('seeking', () => {
      if (!this.#nativeSeeking) void this.seek(this.element.currentTime)
    })

    this.#observer = new IntersectionObserver(([entry]) => {
      const visible = entry.isIntersecting && document.visibilityState === 'visible'
      void invoke(`${COMMAND}update_visibility`, {
        payload: {
          sessionId: this.sessionId,
          visible,
          intersectionRatio: entry.intersectionRatio,
        },
      })
      if (suspendWhenHidden && !visible) void this.#setState('suspended')
    })
    this.#observer.observe(this.element)
  }

  #startFrameTelemetry(): void {
    if (!this.element.requestVideoFrameCallback) return
    const sample = (now: number, metadata: VideoFrameCallbackMetadata) => {
      if (this.#destroyed) return
      this.#presentedFrames += 1
      const frameElapsed = this.#lastFrameNow === undefined
        ? 0
        : Math.max(0, (now - this.#lastFrameNow) / 1000)
      // WebKitGTK currently reports mediaTime=0 for some continuously
      // appended fragmented MP4 streams. Frame callbacks still arrive at the
      // presentation cadence, so use their monotonic timestamp when the
      // browser media clock is stalled.
      if (Number.isFinite(metadata.mediaTime) && metadata.mediaTime > this.#mediaTimeSeconds) {
        this.#mediaTimeSeconds = metadata.mediaTime
      } else {
        this.#mediaTimeSeconds += frameElapsed
      }
      this.#lastFrameNow = now
      this.dispatchEvent(
        new CustomEvent('timeupdate', { detail: { currentTime: this.#mediaTimeSeconds } }),
      )
      this.#frameTimes.push(now)
      const cutoff = now - 5_000
      while (this.#frameTimes.length > 1 && this.#frameTimes[0] < cutoff) this.#frameTimes.shift()
      this.#videoFrameHandle = this.element.requestVideoFrameCallback(sample)
    }
    this.#videoFrameHandle = this.element.requestVideoFrameCallback(sample)
  }

  #listen(name: string, callback: EventListener): void {
    this.element.addEventListener(name, callback)
    this.#listeners.push([name, callback])
  }

  async #setState(state: PlaybackState): Promise<void> {
    if (this.#destroyed) return
    try {
      await invoke(`${COMMAND}set_playback_state`, {
        payload: { sessionId: this.sessionId, state },
      })
    } catch (error) {
      this.dispatchEvent(new CustomEvent('error', { detail: normalizeError(error) }))
    }
  }

  #enqueueTransportMutation(operation: () => Promise<void>): Promise<void> {
    const next = this.#transportMutation.catch(() => undefined).then(operation)
    this.#transportMutation = next
    return next
  }

  #clearMediaSource(): void {
    if (this.#sourceBuffer?.updating) this.#sourceBuffer.abort()
    this.#sourceBuffer = undefined
    this.#clearTextTrack()
    this.element.removeAttribute('src')
    this.element.load()
    if (this.#objectUrl) URL.revokeObjectURL(this.#objectUrl)
    this.#objectUrl = undefined
  }
}

function waitForInitialBuffer(
  element: HTMLVideoElement,
  sourceBuffer: SourceBuffer,
  mediaSource: MediaSource,
  minimumSeconds: number,
  isCurrent: () => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out building the ${minimumSeconds.toFixed(1)} second startup buffer`))
    }, 60_000)
    const cleanup = () => {
      clearTimeout(timeout)
      sourceBuffer.removeEventListener('updateend', checkRange)
      mediaSource.removeEventListener('sourceended', finishShortStream)
    }
    const finishShortStream = () => {
      if (sourceBuffer.buffered.length === 0) return
      cleanup()
      resolve()
    }
    const checkRange = () => {
      if (!isCurrent()) {
        cleanup()
        reject(new DOMException('The media transport changed during startup', 'AbortError'))
        return
      }
      if (bufferedAhead(sourceBuffer.buffered, element.currentTime) >= minimumSeconds) {
        cleanup()
        resolve()
      }
    }
    sourceBuffer.addEventListener('updateend', checkRange)
    mediaSource.addEventListener('sourceended', finishShortStream)
    checkRange()
  })
}

export async function attachVideo(
  element: HTMLVideoElement,
  options: AttachVideoOptions,
): Promise<VideoController> {
  if (!(element instanceof HTMLVideoElement)) {
    throw new TypeError('attachVideo requires an HTMLVideoElement')
  }
  if (/Android|Linux/i.test(navigator.userAgent)) {
    const controller = new NativeSurfaceVideoController(element, options)
    try {
      await controller.start()
      return controller
    } catch (error) {
      await controller.destroy().catch(() => undefined)
      if (options.backend && options.backend !== 'auto') throw error
      // Media3 is the zero-copy fast path on Android. Keep the GStreamer/MSE
      // backend as a compatibility fallback for extractors/codecs a specific
      // device image does not expose.
    }
  }
  const fallbackSource = typeof options.source === 'string'
    ? options.source
    : { ...options.source }
  // The Android plugin copies the bundled CA into app-private storage and
  // configures GIO/GStreamer with its absolute path. "bundled" is a Media3
  // selector, not a filesystem path that should reach the Rust fallback.
  if (/Android/i.test(navigator.userAgent) && typeof fallbackSource !== 'string'
      && fallbackSource.tlsCaFile === 'bundled') {
    delete fallbackSource.tlsCaFile
  }
  const descriptor = await createSession(fallbackSource, options)
  const controller = new TauriVideoController(element, descriptor, options)
  try {
    await controller.start()
    return controller
  } catch (error) {
    await controller.destroy().catch(() => undefined)
    throw error
  }
}

let nativeSurfaceSequence = 0

interface NativeMediaElementState {
  owner: string
  originals: Map<PropertyKey, PropertyDescriptor | undefined>
}

const nativeMediaElementStates = new WeakMap<HTMLVideoElement, NativeMediaElementState>()

class NativeSurfaceVideoController extends EventTarget implements VideoController {
  readonly element: HTMLVideoElement
  #options: AttachVideoOptions
  #snapshot?: NativePlaybackSnapshot
  #media: MediaInfo = { seekable: true, live: false, tracks: [], chapters: [] }
  #timer?: number
  #resize?: ResizeObserver
  #layoutFrame?: number
  #layoutInFlight = false
  #layoutDirty = false
  #scrollTargets: EventTarget[] = []
  #lastLayout?: NativeSurfacePosition
  #pendingSeek?: { target: number; deadline: number }
  #polling = false
  #destroyed = false
  #volume = 1
  #muted = false
  readonly #sessionKey = globalThis.crypto?.randomUUID?.()
    ?? `native-${Date.now()}-${++nativeSurfaceSequence}`

  constructor(element: HTMLVideoElement, options: AttachVideoOptions) {
    super()
    this.element = element
    this.#options = options
    const initialVolume = Number(element.volume)
    this.#volume = Number.isFinite(initialVolume)
      ? Math.min(1, Math.max(0, initialVolume))
      : 1
    this.#muted = Boolean(element.muted)
  }

  get sessionId(): string { return /Android/i.test(navigator.userAgent) ? 'android-native-surface' : 'linux-native-surface' }
  get media(): MediaInfo { return this.#media }
  get tracks(): readonly MediaTrack[] { return this.#media.tracks }

  on<K extends keyof VideoControllerEventMap>(
    type: K,
    listener: (event: VideoControllerEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): () => void {
    const eventListener = listener as EventListener
    this.addEventListener(type, eventListener, options)
    return () => this.removeEventListener(type, eventListener, options)
  }

  async start(): Promise<void> {
    if (this.#options.signal?.aborted) throw this.#options.signal.reason
    this.#claimMediaElement()
    this.#claimCssSurface()
    this.element.style.visibility = 'hidden'
    const source = typeof this.#options.source === 'string'
      ? { uri: this.#options.source }
      : this.#options.source
    const { layout, scale } = this.#measureLayout()
    this.#lastLayout = layout
    try {
      this.#snapshot = await invoke<NativePlaybackSnapshot>(`${COMMAND}native_open`, {
        payload: {
          sessionKey: this.#sessionKey,
          ...source,
          ...layout,
          autoplay: this.#options.autoplay ?? false,
          volume: this.#volume,
          muted: this.#muted,
          ...nativeOpenSettings(this.#options),
        },
      })
    } catch (error) {
      await invoke(`${COMMAND}native_close`, {
        payload: { sessionKey: this.#sessionKey },
      }).catch(() => undefined)
      if (this.#removeMediaFacade()) this.element.style.removeProperty('visibility')
      this.#releaseCssSurface()
      throw error
    }
    if (!this.#ownsMediaElement()) {
      await invoke(`${COMMAND}native_close`, {
        payload: { sessionKey: this.#sessionKey },
      }).catch(() => undefined)
      throw new DOMException('native video controller was superseded', 'AbortError')
    }
    // Keep the WebView aperture closed until the native host confirms that its
    // surface is in place. Publishing first exposes a frame of the native base
    // whenever GTK and WebKit commit scroll/resize frames at different times.
    this.#publishCssLayout(layout, scale)
    this.#updateMedia(this.#snapshot)
    this.#installMediaFacade()
    this.element.dispatchEvent(new Event('loadedmetadata'))
    this.element.dispatchEvent(new Event('durationchange'))
    this.element.dispatchEvent(new Event('progress'))
    this.element.dispatchEvent(new Event('canplay'))
    if (this.#snapshot.playing) {
      this.element.dispatchEvent(new Event('play'))
      this.element.dispatchEvent(new Event('playing'))
    }
    this.#resize = new ResizeObserver(() => this.#requestLayout())
    this.#resize.observe(this.element)
    this.#scrollTargets = nativeScrollTargets(this.element)
    for (const target of this.#scrollTargets) {
      target.addEventListener('scroll', this.#handleViewportChange, { capture: true, passive: true })
    }
    window.addEventListener('wheel', this.#handleViewportChange, { capture: true, passive: true })
    window.addEventListener('resize', this.#handleViewportChange, { passive: true })
    window.visualViewport?.addEventListener('scroll', this.#handleViewportChange, { passive: true })
    window.visualViewport?.addEventListener('resize', this.#handleViewportChange, { passive: true })
    this.#requestLayout()
    this.#timer = window.setInterval(() => void this.#poll(), 250)
    this.#options.signal?.addEventListener('abort', () => void this.destroy(), { once: true })
  }

  async play(): Promise<void> {
    this.#acceptSnapshot(await this.#control('play'))
    this.element.dispatchEvent(new Event('play'))
    this.element.dispatchEvent(new Event('playing'))
  }

  pause(): void {
    void this.#control('pause').then((snapshot) => {
      this.#acceptSnapshot(snapshot)
      this.element.dispatchEvent(new Event('pause'))
    })
  }

  async setVolume(volume: number): Promise<void> {
    const clamped = Math.min(1, Math.max(0, volume))
    this.#volume = clamped
    this.#acceptSnapshot(await this.#control('volume', this.#muted ? 0 : clamped))
    this.element.dispatchEvent(new Event('volumechange'))
  }

  async seek(positionSeconds: number): Promise<void> {
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0) {
      throw new RangeError('positionSeconds must be a finite, non-negative number')
    }
    const wasPlaying = this.#snapshot?.playing ?? false
    const target = Math.min(this.#snapshot?.durationSeconds || Number.POSITIVE_INFINITY, positionSeconds)
    this.#pendingSeek = { target, deadline: performance.now() + 30_000 }
    if (this.#snapshot) {
      this.#snapshot = { ...this.#snapshot, currentTimeSeconds: target }
    }
    this.element.dispatchEvent(new Event('seeking'))
    this.dispatchEvent(new CustomEvent('timeupdate', {
      detail: { currentTime: target },
    }))
    this.element.dispatchEvent(new Event('timeupdate'))
    try {
      const snapshot = this.#acceptSnapshot(await this.#control('seek', target))
      this.#updateMedia(snapshot)
      // A seek to the end can make the native backend pause synchronously.
      // Since #acceptSnapshot has already published that state, the next poll
      // cannot detect the playing -> paused edge. Mirror it here so headed
      // controls (for example media-chrome) immediately switch to Play.
      if (wasPlaying && !snapshot.playing) {
        this.element.dispatchEvent(new Event('pause'))
      }
    } catch (error) {
      this.#pendingSeek = undefined
      throw error
    } finally {
      this.element.dispatchEvent(new Event('seeked'))
    }
  }

  async selectTrack(kind: TrackKind, trackId?: string): Promise<void> {
    const selected = this.#snapshot?.tracks.find((track) => track.id === trackId && track.kind === kind)
    if (selected) {
      this.#acceptSnapshot(await this.#control('track', 0, selected.index))
    } else if (kind === 'subtitle') {
      const active = this.#media.tracks.find((track) => track.kind === kind && track.selected)
      if (active) this.#acceptSnapshot(await this.#control('deselectTrack', 0, active.streamIndex))
    }
    for (const track of this.#media.tracks) {
      if (track.kind === kind) track.selected = track.id === trackId
    }
    this.dispatchEvent(new CustomEvent('trackchange', { detail: { kind, trackId } }))
  }

  async stats(): Promise<SessionStats> {
    const snapshot = await invoke<NativePlaybackSnapshot>(`${COMMAND}native_stats`, {
      payload: { sessionKey: this.#sessionKey },
    })
    this.#acceptSnapshot(snapshot)
    return {
      sessionId: this.sessionId,
      mode: 'native-decode',
      generation: 0,
      bytesFetched: 0,
      encodedBytesBuffered: snapshot.encodedBytesBuffered ?? 0,
      fragmentsBuffered: 0,
      sourceBufferAheadSeconds: Math.max(0, snapshot.bufferedSeconds - snapshot.currentTimeSeconds),
      hardwareBackend: snapshot.hardwareBackend || (/Android/i.test(navigator.userAgent)
        ? 'android-mediaplayer-surface'
        : 'gstreamer-va-gl-gtk'),
      decodedFrameCopies: 0,
      droppedFrames: snapshot.droppedFrames ?? 0,
      averageFrameProcessingUs: snapshot.averageFrameProcessingUs,
      inputVideoCodec: snapshot.tracks.find((track) => track.kind === 'video' && track.selected)?.codec,
      outputVideoCodec: snapshot.tracks.find((track) => track.kind === 'video' && track.selected)?.codec,
      inputAudioCodec: snapshot.tracks.find((track) => track.kind === 'audio' && track.selected)?.codec,
      outputAudioCodec: snapshot.tracks.find((track) => track.kind === 'audio' && track.selected)?.codec,
      visible: true,
      state: snapshot.playing ? 'playing' : 'paused',
    }
  }

  bufferedAhead(): number {
    if (!this.#snapshot) return 0
    return Math.max(0, this.#snapshot.bufferedSeconds - this.#snapshot.currentTimeSeconds)
  }

  playbackQuality(): PlaybackQuality {
    return {
      presentedFrames: this.#snapshot?.presentedFrames ?? 0,
      mediaTimeSeconds: this.#snapshot?.currentTimeSeconds,
      measuredFps: this.#snapshot?.measuredFps ?? 0,
      totalVideoFrames: (this.#snapshot?.presentedFrames ?? 0) + (this.#snapshot?.droppedFrames ?? 0),
      droppedVideoFrames: this.#snapshot?.droppedFrames ?? 0,
      droppedFramePercent: this.#snapshot?.presentedFrames
        ? 100 * (this.#snapshot.droppedFrames ?? 0)
          / (this.#snapshot.presentedFrames + (this.#snapshot.droppedFrames ?? 0))
        : 0,
    }
  }

  async setVideoFit(mode: VideoFitMode): Promise<void> {
    this.#acceptSnapshot(await this.#control(mode === 'cover' ? 'crop' : mode))
  }

  async setVideoZoom(scale: number): Promise<void> {
    this.#acceptSnapshot(await this.#control('zoom', Math.min(2, Math.max(1, scale))))
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return
    this.#destroyed = true
    if (this.#timer !== undefined) clearInterval(this.#timer)
    if (this.#layoutFrame !== undefined) cancelAnimationFrame(this.#layoutFrame)
    this.#resize?.disconnect()
    for (const target of this.#scrollTargets) {
      target.removeEventListener('scroll', this.#handleViewportChange, true)
    }
    this.#scrollTargets = []
    window.removeEventListener('wheel', this.#handleViewportChange, true)
    window.removeEventListener('resize', this.#handleViewportChange)
    window.visualViewport?.removeEventListener('scroll', this.#handleViewportChange)
    window.visualViewport?.removeEventListener('resize', this.#handleViewportChange)
    await invoke(`${COMMAND}native_close`, {
      payload: { sessionKey: this.#sessionKey },
    }).catch(() => undefined)
    if (this.#removeMediaFacade()) {
      // Preserve the facade's final audio state on the real HTMLMediaElement so
      // a replacement controller/source starts from the same user preference.
      this.element.volume = this.#volume
      this.element.muted = this.#muted
      this.element.style.removeProperty('visibility')
    }
    this.#releaseCssSurface()
  }

  async #control(action: string, value = 0, index = -1): Promise<NativePlaybackSnapshot> {
    return invoke<NativePlaybackSnapshot>(`${COMMAND}native_control`, {
      // Session ownership prevents delayed cleanup from a prior React render
      // from controlling the replacement native player.
      payload: { sessionKey: this.#sessionKey, action, value, index },
    })
  }

  async #poll(): Promise<void> {
    if (this.#destroyed || this.#polling) return
    // Safety net for layout changes caused by transforms, programmatic scroll,
    // or WebKit builds that omit an element-scroll event from the window path.
    // The geometry comparison prevents unchanged layouts from crossing IPC.
    this.#requestLayout()
    this.#polling = true
    try {
      const previous = this.#snapshot
      const snapshot = await invoke<NativePlaybackSnapshot>(`${COMMAND}native_stats`, {
        payload: { sessionKey: this.#sessionKey },
      })
      const visibleSnapshot = this.#acceptSnapshot(snapshot)
      this.#updateMedia(visibleSnapshot)
      this.dispatchEvent(new CustomEvent('timeupdate', {
        detail: { currentTime: visibleSnapshot.currentTimeSeconds },
      }))
      this.dispatchEvent(new CustomEvent('bufferprogress', {
        detail: { bufferedAhead: this.bufferedAhead() },
      }))
      this.element.dispatchEvent(new Event('timeupdate'))
      if (previous?.bufferedSeconds !== snapshot.bufferedSeconds) {
        this.element.dispatchEvent(new Event('progress'))
      }
      if (previous?.durationSeconds !== snapshot.durationSeconds) {
        this.element.dispatchEvent(new Event('durationchange'))
      }
      if (previous?.playing !== snapshot.playing) {
        this.element.dispatchEvent(new Event(snapshot.playing ? 'play' : 'pause'))
        if (snapshot.playing) this.element.dispatchEvent(new Event('playing'))
      }
      const wasEnded = Boolean(previous
        && previous.durationSeconds > 0
        && previous.currentTimeSeconds >= previous.durationSeconds)
      const isEnded = snapshot.durationSeconds > 0
        && snapshot.currentTimeSeconds >= snapshot.durationSeconds
      if (!wasEnded && isEnded) this.element.dispatchEvent(new Event('ended'))
    } catch (error) {
      if (!this.#destroyed) this.dispatchEvent(new CustomEvent('error', { detail: normalizeError(error) }))
    } finally {
      this.#polling = false
    }
  }

  #updateMedia(snapshot: NativePlaybackSnapshot): void {
    const nextMedia: MediaInfo = {
      durationSeconds: snapshot.durationSeconds,
      seekable: true,
      live: false,
      container: snapshot.container ?? 'unknown',
      chapters: [],
      tracks: snapshot.tracks.map((track) => ({
        id: track.id,
        kind: track.kind,
        streamIndex: track.index,
        codec: track.codec,
        caps: track.codec,
        label: track.label,
        language: track.language,
        selected: track.selected,
        default: false,
        forced: false,
        width: track.kind === 'video' ? snapshot.videoWidth : undefined,
        height: track.kind === 'video' ? snapshot.videoHeight : undefined,
      })),
    }
    Object.assign(this.#media, nextMedia)
  }

  #acceptSnapshot(snapshot: NativePlaybackSnapshot): NativePlaybackSnapshot {
    const pending = this.#pendingSeek
    if (!pending) {
      this.#snapshot = snapshot
      return snapshot
    }
    const reachedTarget = Math.abs(snapshot.currentTimeSeconds - pending.target) <= 1
    if (reachedTarget || performance.now() >= pending.deadline) {
      this.#pendingSeek = undefined
      this.#snapshot = snapshot
      return snapshot
    }
    const optimistic = { ...snapshot, currentTimeSeconds: pending.target }
    this.#snapshot = optimistic
    return optimistic
  }

  #installMediaFacade(): void {
    const state = nativeMediaElementStates.get(this.element)
    if (!state || state.owner !== this.#sessionKey) return
    const source = typeof this.#options.source === 'string'
      ? this.#options.source
      : this.#options.source.uri
    const define = (key: PropertyKey, descriptor: PropertyDescriptor) => {
      if (!state.originals.has(key)) {
        state.originals.set(key, Object.getOwnPropertyDescriptor(this.element, key))
      }
      Object.defineProperty(this.element, key, { configurable: true, ...descriptor })
    }
    const ranges = (end: number): TimeRanges => ({
      length: end > 0 ? 1 : 0,
      start: (index: number) => {
        if (index !== 0 || end <= 0) throw new DOMException('Index out of bounds', 'IndexSizeError')
        return 0
      },
      end: (index: number) => {
        if (index !== 0 || end <= 0) throw new DOMException('Index out of bounds', 'IndexSizeError')
        return end
      },
    })

    define('play', { value: () => this.play() })
    define('pause', { value: () => this.pause() })
    define('currentTime', {
      get: () => this.#snapshot?.currentTimeSeconds ?? 0,
      set: (value: number) => { void this.seek(Number(value)) },
    })
    define('duration', { get: () => this.#snapshot?.durationSeconds ?? Number.NaN })
    define('paused', { get: () => !(this.#snapshot?.playing ?? false) })
    define('ended', {
      get: () => Boolean(this.#snapshot
        && this.#snapshot.durationSeconds > 0
        && this.#snapshot.currentTimeSeconds >= this.#snapshot.durationSeconds),
    })
    define('volume', {
      get: () => this.#volume,
      set: (value: number) => { void this.setVolume(Number(value)) },
    })
    define('muted', {
      get: () => this.#muted,
      set: (value: boolean) => {
        this.#muted = Boolean(value)
        void this.#control('volume', this.#muted ? 0 : this.#volume)
        this.element.dispatchEvent(new Event('volumechange'))
      },
    })
    define('buffered', { get: () => ranges(this.#snapshot?.bufferedSeconds ?? 0) })
    define('seekable', { get: () => ranges(this.#snapshot?.durationSeconds ?? 0) })
    define('readyState', { get: () => this.#snapshot ? HTMLMediaElement.HAVE_ENOUGH_DATA : HTMLMediaElement.HAVE_NOTHING })
    define('networkState', { get: () => this.#snapshot ? HTMLMediaElement.NETWORK_IDLE : HTMLMediaElement.NETWORK_LOADING })
    define('currentSrc', { get: () => source })
    define('videoWidth', { get: () => this.#snapshot?.videoWidth ?? 0 })
    define('videoHeight', { get: () => this.#snapshot?.videoHeight ?? 0 })
  }

  #removeMediaFacade(): boolean {
    const state = nativeMediaElementStates.get(this.element)
    if (!state || state.owner !== this.#sessionKey) return false
    for (const [key, descriptor] of state.originals) {
      if (descriptor) Object.defineProperty(this.element, key, descriptor)
      else delete (this.element as unknown as Record<PropertyKey, unknown>)[key]
    }
    nativeMediaElementStates.delete(this.element)
    return true
  }

  #measureLayout(): { layout: NativeSurfacePosition; scale: number } {
    const rect = this.element.getBoundingClientRect()
    // Android SurfaceView layout uses physical pixels; GTK Fixed uses logical
    // coordinates, which match getBoundingClientRect directly.
    const android = /Android/i.test(navigator.userAgent)
    const scale = android ? (window.devicePixelRatio || 1) : 1
    const layout = {
      ...snapNativeSurfaceLayout(rect, android, scale),
      scrollX: android ? Math.round(window.scrollX * scale) : 0,
      scrollY: android ? Math.round(window.scrollY * scale) : 0,
    }
    return { layout, scale }
  }

  #claimCssSurface(): void {
    claimNativeCssSurface(this.#sessionKey, this.element)
  }

  #claimMediaElement(): void {
    const state = nativeMediaElementStates.get(this.element)
    if (state) state.owner = this.#sessionKey
    else nativeMediaElementStates.set(this.element, {
      owner: this.#sessionKey,
      originals: new Map(),
    })
  }

  #ownsMediaElement(): boolean {
    return nativeMediaElementStates.get(this.element)?.owner === this.#sessionKey
  }

  #publishCssLayout(layout: NativeSurfaceLayout, scale: number): void {
    updateNativeCssSurface(this.#sessionKey, layout, scale)
  }

  #releaseCssSurface(): void {
    releaseNativeCssSurface(this.#sessionKey)
  }

  #handleViewportChange = (): void => {
    this.#requestLayout()
  }

  #requestLayout(): void {
    if (this.#destroyed) return
    this.#layoutDirty = true
    if (this.#layoutFrame !== undefined || this.#layoutInFlight) return
    this.#layoutFrame = requestAnimationFrame(() => {
      this.#layoutFrame = undefined
      void this.#flushLayout()
    })
  }

  async #flushLayout(): Promise<void> {
    if (this.#destroyed || this.#layoutInFlight) return
    this.#layoutInFlight = true
    try {
      if (!this.#layoutDirty) return
      this.#layoutDirty = false
      const { layout, scale } = this.#measureLayout()
      if (sameNativeSurfacePosition(layout, this.#lastLayout, /Android/i.test(navigator.userAgent))) {
        // Viewport bounds can change without moving the anchor. Refresh the
        // surrounding panels while keeping the already-aligned aperture.
        this.#publishCssLayout(layout, scale)
        return
      }
      await invoke(`${COMMAND}native_layout`, {
        payload: { sessionKey: this.#sessionKey, ...layout },
      })
      this.#lastLayout = layout
      // This is deliberately after native_layout. The native player may be
      // briefly hidden by the old aperture, but an unsynchronised move can
      // never reveal the transparent window beneath it.
      this.#publishCssLayout(layout, scale)
    } catch (error) {
      if (!this.#destroyed) {
        this.dispatchEvent(new CustomEvent('error', { detail: normalizeError(error) }))
      }
    } finally {
      this.#layoutInFlight = false
      if (this.#layoutDirty && !this.#destroyed) this.#requestLayout()
    }
  }

}

interface NativeCssSurfaceState {
  owner: string
  anchor: HTMLVideoElement
  backdrop: HTMLDivElement
  style: HTMLStyleElement
  panels: readonly [HTMLDivElement, HTMLDivElement, HTMLDivElement, HTMLDivElement]
  drilled: Array<{ element: HTMLElement; previousOwner: string | null }>
}

const nativeCssSurfaceScope = globalThis as typeof globalThis & {
  __TAURI_VIDEO_NATIVE_CSS_SURFACE__?: NativeCssSurfaceState
}

function claimNativeCssSurface(owner: string, anchor: HTMLVideoElement): void {
  const existing = nativeCssSurfaceScope.__TAURI_VIDEO_NATIVE_CSS_SURFACE__
  if (existing?.anchor === anchor && existing.backdrop.isConnected) {
    // A source replacement uses the same DOM anchor. Transfer the aperture in
    // place so there is no frame where the ancestors are transparent but the
    // opaque panels are absent. Stale controller cleanup now sees the new owner
    // and becomes a no-op, including across Vite hot-module replacement.
    for (const { element } of existing.drilled) {
      if (element.getAttribute('data-tauri-native-video-hole') === existing.owner) {
        element.setAttribute('data-tauri-native-video-hole', owner)
      }
    }
    existing.style.textContent = nativeHoleStyle(owner)
    existing.owner = owner
    const root = document.documentElement
    root.dataset.tauriNativeVideoSession = owner
    root.classList.add('tauri-native-video')
    return
  }
  if (existing) releaseNativeCssSurface(existing.owner)
  // Vite HMR can leave DOM artifacts created by a previous module instance,
  // whose module-local state is no longer reachable. A native window supports
  // one video aperture, so stale plugin-owned artifacts are always safe to
  // retire before establishing the next owner.
  for (const orphan of document.querySelectorAll('[data-tauri-native-video-backdrop]')) {
    orphan.remove()
  }
  for (const orphan of document.querySelectorAll('[data-tauri-native-video-hole]')) {
    orphan.removeAttribute('data-tauri-native-video-hole')
  }
  const root = document.documentElement
  const backdropColor = nativeBackdropColor(root)
  const backdrop = document.createElement('div')
  backdrop.dataset.tauriNativeVideoBackdrop = ''
  backdrop.setAttribute('aria-hidden', 'true')
  Object.assign(backdrop.style, {
    position: 'fixed',
    zIndex: '-2147483647',
    inset: '0',
    pointerEvents: 'none',
    contain: 'strict',
  })
  const panels = Array.from({ length: 4 }, () => {
    const panel = document.createElement('div')
    Object.assign(panel.style, {
      position: 'absolute',
      background: backdropColor,
    })
    backdrop.append(panel)
    return panel
  }) as [HTMLDivElement, HTMLDivElement, HTMLDivElement, HTMLDivElement]

  const drilled: NativeCssSurfaceState['drilled'] = []
  for (let element: HTMLElement | null = anchor.parentElement; element; element = element.parentElement) {
    drilled.push({ element, previousOwner: element.getAttribute('data-tauri-native-video-hole') })
    element.setAttribute('data-tauri-native-video-hole', owner)
  }
  const style = document.createElement('style')
  style.dataset.tauriNativeVideoBackdropStyle = ''
  style.textContent = nativeHoleStyle(owner)
  backdrop.prepend(style)
  document.body.prepend(backdrop)
  root.dataset.tauriNativeVideoSession = owner
  root.classList.add('tauri-native-video')
  nativeCssSurfaceScope.__TAURI_VIDEO_NATIVE_CSS_SURFACE__ = {
    owner,
    anchor,
    backdrop,
    style,
    panels,
    drilled,
  }
}

function updateNativeCssSurface(owner: string, layout: NativeSurfaceLayout, scale: number): void {
  const state = nativeCssSurfaceScope.__TAURI_VIDEO_NATIVE_CSS_SURFACE__
  if (!state || state.owner !== owner) return
  const root = document.documentElement
  const { left, top, right, bottom } = visibleSurfaceBounds(layout, scale, {
    width: window.innerWidth,
    height: window.innerHeight,
  })
  const middleHeight = Math.max(0, bottom - top)
  const [topPanel, bottomPanel, leftPanel, rightPanel] = state.panels
  Object.assign(topPanel.style, { inset: '0 0 auto 0', height: `${top}px` })
  Object.assign(bottomPanel.style, { inset: `${bottom}px 0 0 0` })
  Object.assign(leftPanel.style, {
    inset: `${top}px auto auto 0`,
    width: `${left}px`,
    height: `${middleHeight}px`,
  })
  Object.assign(rightPanel.style, {
    inset: `${top}px 0 auto ${right}px`,
    height: `${middleHeight}px`,
  })
  root.style.setProperty('--tauri-native-video-left', `${left}px`)
  root.style.setProperty('--tauri-native-video-top', `${top}px`)
  root.style.setProperty('--tauri-native-video-right', `${right}px`)
  root.style.setProperty('--tauri-native-video-bottom', `${bottom}px`)
  root.style.setProperty('--tauri-native-video-width', `${layout.width / scale}px`)
  root.style.setProperty('--tauri-native-video-height', `${layout.height / scale}px`)
}

function releaseNativeCssSurface(owner: string): void {
  const state = nativeCssSurfaceScope.__TAURI_VIDEO_NATIVE_CSS_SURFACE__
  if (!state || state.owner !== owner) return
  for (const { element, previousOwner } of state.drilled) {
    if (element.getAttribute('data-tauri-native-video-hole') !== owner) continue
    if (previousOwner === null) element.removeAttribute('data-tauri-native-video-hole')
    else element.setAttribute('data-tauri-native-video-hole', previousOwner)
  }
  state.backdrop.remove()
  delete nativeCssSurfaceScope.__TAURI_VIDEO_NATIVE_CSS_SURFACE__
  const root = document.documentElement
  delete root.dataset.tauriNativeVideoSession
  root.classList.remove('tauri-native-video')
  for (const property of NATIVE_VIDEO_CSS_PROPERTIES) root.style.removeProperty(property)
}

function nativeHoleStyle(owner: string): string {
  return `
    [data-tauri-native-video-hole="${owner}"] { background: transparent !important; }
    body[data-tauri-native-video-hole="${owner}"] { position: relative !important; isolation: isolate !important; }
  `
}

function nativeScrollTargets(anchor: HTMLElement): EventTarget[] {
  const targets = new Set<EventTarget>([window, document])
  for (let element: HTMLElement | null = anchor.parentElement; element; element = element.parentElement) {
    targets.add(element)
  }
  return [...targets]
}

function nativeBackdropColor(root: HTMLElement): string {
  const configured = getComputedStyle(root)
    .getPropertyValue('--tauri-native-video-backdrop-color')
    .trim()
  if (configured) return configured
  for (const element of [document.body, root]) {
    const color = getComputedStyle(element).backgroundColor
    if (color && color !== 'transparent' && !/rgba\([^)]*,\s*0(?:\.0+)?\s*\)/i.test(color)) {
      return color
    }
  }
  return '#000'
}

const NATIVE_VIDEO_CSS_PROPERTIES = [
  '--tauri-native-video-left',
  '--tauri-native-video-top',
  '--tauri-native-video-right',
  '--tauri-native-video-bottom',
  '--tauri-native-video-width',
  '--tauri-native-video-height',
] as const

function nativeOpenSettings(options: AttachVideoOptions): Record<string, unknown> {
  const userAgent = navigator.userAgent
  const android = /Android/i.test(userAgent)
  const linux = /Linux/i.test(userAgent) && !android
  const windows = /Windows/i.test(userAgent)
  const tv = options.deviceProfile === 'tv'
    || ((options.deviceProfile === undefined || options.deviceProfile === 'auto')
      && /\bTV\b|AFT|BRAVIA|SHIELD|GoogleTV/i.test(userAgent))
  const androidBase = options.platform?.android
  const androidOptions = android
    ? { ...androidBase, ...(tv ? options.platform?.androidTv : undefined) }
    : undefined
  const buffer = androidOptions?.buffer
    ?? (linux ? options.platform?.linux?.buffer : undefined)
    ?? (windows ? options.platform?.windows?.buffer : undefined)
  return {
    backend: options.backend ?? 'auto',
    minBufferMs: secondsToMilliseconds(buffer?.minSeconds),
    maxBufferMs: secondsToMilliseconds(buffer?.maxSeconds),
    playbackBufferMs: secondsToMilliseconds(buffer?.playSeconds),
    rebufferMs: secondsToMilliseconds(buffer?.rebufferSeconds),
    targetBufferBytes: buffer?.maxBytes,
    decoderFallback: androidOptions?.decoderFallback,
    compatibilityFallback: androidOptions?.compatibilityFallback,
    startupTimeoutMs: secondsToMilliseconds(androidOptions?.startupTimeoutSeconds),
    dolbyVisionMode: androidOptions?.dolbyVision,
    tunneling: androidOptions?.tunneling,
  }
}

function secondsToMilliseconds(value?: number): number | undefined {
  return value === undefined ? undefined : Math.max(0, Math.round(value * 1000))
}

export function bufferedAhead(ranges: TimeRanges, currentTime: number): number {
  for (let index = 0; index < ranges.length; index += 1) {
    // Matroska remuxes can begin a few ticks after zero because of codec delay
    // or composition offsets. That tiny timestamp gap is playable buffered
    // media, not a reason to leave startup waiting forever.
    if (ranges.start(index) <= currentTime + 0.5 && ranges.end(index) >= currentTime) {
      return Math.max(0, ranges.end(index) - currentTime)
    }
  }
  return 0
}

function getMediaSourceConstructor(): typeof MediaSource | undefined {
  const scope = globalThis as typeof globalThis & { ManagedMediaSource?: typeof MediaSource }
  return scope.ManagedMediaSource ?? scope.MediaSource
}

async function pollBytes(
  url: string,
  revision: number,
  currentRevision: () => number,
): Promise<Uint8Array<ArrayBuffer>> {
  while (revision === currentRevision()) {
    const response = await fetch(url, { cache: 'no-store' })
    if (response.status === 204) {
      await delay(25)
      continue
    }
    if (!response.ok) {
      const detail = (await response.text()).trim().slice(0, 512)
      throw new Error(
        `initialization segment failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
      )
    }
    return new Uint8Array(await response.arrayBuffer())
  }
  throw new DOMException('transport generation changed', 'AbortError')
}

function appendBuffer(
  sourceBuffer: SourceBuffer,
  bytes: Uint8Array<ArrayBuffer>,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      sourceBuffer.removeEventListener('updateend', onEnd)
      sourceBuffer.removeEventListener('error', onError)
    }
    const onEnd = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      const box = bytes.length >= 8
        ? String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7])
        : 'short'
      reject(new Error(`MediaSource rejected ${label} (${bytes.length} bytes, first box ${box})`))
    }
    sourceBuffer.addEventListener('updateend', onEnd, { once: true })
    sourceBuffer.addEventListener('error', onError, { once: true })
    // WebKitGTK's MSE bridge is measurably smoother with an owned ArrayBuffer
    // than with a Uint8Array view on large HEVC fragments. Keep this one copy:
    // it is released after updateend and avoids multi-second frame stalls.
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    sourceBuffer.appendBuffer(copy)
  })
}

async function trimPlayedMedia(sourceBuffer: SourceBuffer, currentTime: number): Promise<void> {
  const keepBehindSeconds = 30
  const removeEnd = currentTime - keepBehindSeconds
  if (removeEnd <= 0 || sourceBuffer.buffered.length === 0) return
  const removeStart = sourceBuffer.buffered.start(0)
  // Batch eviction instead of issuing a SourceBuffer.remove() for every media
  // fragment. Repeated sub-second removals can contend with appends and starve
  // playback on WebKitGTK.
  if (removeEnd - removeStart < 4) return
  await new Promise<void>((resolve) => {
    const done = () => resolve()
    sourceBuffer.addEventListener('updateend', done, { once: true })
    try {
      sourceBuffer.remove(removeStart, removeEnd)
    } catch {
      sourceBuffer.removeEventListener('updateend', done)
      resolve()
    }
  })
}

function waitForBufferedTarget(
  element: HTMLVideoElement,
  sourceBuffer: SourceBuffer,
  targetTime: number,
  isCurrent: () => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for media at ${targetTime.toFixed(2)} seconds`))
    }, 60_000)

    const cleanup = () => {
      clearTimeout(timeout)
      if (settleTimer !== undefined) clearTimeout(settleTimer)
      sourceBuffer.removeEventListener('updateend', checkRange)
      element.removeEventListener('seeked', finish)
    }
    const finish = () => {
      cleanup()
      resolve()
    }
    const checkRange = () => {
      if (!isCurrent()) {
        cleanup()
        reject(new DOMException('The media transport changed during seek', 'AbortError'))
        return
      }
      for (let index = 0; index < sourceBuffer.buffered.length; index += 1) {
        const startsBeforeTarget = sourceBuffer.buffered.start(index) <= targetTime + 0.05
        const endsAfterTarget = sourceBuffer.buffered.end(index) >= targetTime
        if (!startsBeforeTarget || !endsAfterTarget) continue
        sourceBuffer.removeEventListener('updateend', checkRange)
        element.addEventListener('seeked', finish, { once: true })
        element.currentTime = targetTime
        // Some WebViews omit `seeked` when the target equals the first decoded
        // frame. The timeline is already correct in that case, so do not leave
        // the UI blocked indefinitely.
        settleTimer = setTimeout(finish, 10_000)
        return
      }
    }

    sourceBuffer.addEventListener('updateend', checkRange)
    checkRange()
  })
}

function once(target: EventTarget, event: string): Promise<void> {
  return new Promise((resolve) => target.addEventListener(event, () => resolve(), { once: true }))
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function normalizeError(error: unknown): VideoPluginError {
  if (typeof error === 'object' && error && 'code' in error && 'message' in error) {
    return error as VideoPluginError
  }
  return { code: 'transport', message: errorMessage(error) }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error) {
    for (const key of ['message', 'error', 'detail', 'cause'] as const) {
      if (key in error) {
        const value: unknown = (error as Record<string, unknown>)[key]
        if (value !== error) {
          const message = errorMessage(value)
          if (message && message !== '[object Object]') return message
        }
      }
    }
    try { return JSON.stringify(error) }
    catch { /* fall through */ }
  }
  return String(error)
}
