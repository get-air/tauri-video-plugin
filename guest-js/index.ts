import { invoke } from '@tauri-apps/api/core'

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
  transcodePolicy?: TranscodePolicy
  bufferAheadSeconds?: number
  suspendWhenHidden?: boolean
  autoplay?: boolean
  deviceProfile?: DeviceProfile
  platform?: PlatformPlaybackOptions
  signal?: AbortSignal
}

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

class NativeSurfaceVideoController extends EventTarget implements VideoController {
  readonly element: HTMLVideoElement
  #options: AttachVideoOptions
  #snapshot?: NativePlaybackSnapshot
  #media: MediaInfo = { seekable: true, live: false, tracks: [], chapters: [] }
  #timer?: number
  #resize?: ResizeObserver
  #polling = false
  #destroyed = false

  constructor(element: HTMLVideoElement, options: AttachVideoOptions) {
    super()
    this.element = element
    this.#options = options
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
    document.documentElement.classList.add('tauri-native-video')
    this.element.style.visibility = 'hidden'
    const source = typeof this.#options.source === 'string'
      ? { uri: this.#options.source }
      : this.#options.source
    const layout = this.#layout()
    this.#snapshot = await invoke<NativePlaybackSnapshot>(`${COMMAND}native_open`, {
      payload: {
        ...source,
        ...layout,
        autoplay: this.#options.autoplay ?? false,
        ...nativeOpenSettings(this.#options),
      },
    })
    this.#updateMedia(this.#snapshot)
    this.#resize = new ResizeObserver(() => void this.#syncLayout())
    this.#resize.observe(this.element)
    this.#timer = window.setInterval(() => void this.#poll(), 250)
    this.#options.signal?.addEventListener('abort', () => void this.destroy(), { once: true })
  }

  async play(): Promise<void> {
    this.#snapshot = await this.#control('play')
  }

  pause(): void {
    void this.#control('pause')
  }

  async setVolume(volume: number): Promise<void> {
    const clamped = Math.min(1, Math.max(0, volume))
    this.element.volume = clamped
    this.#snapshot = await this.#control('volume', clamped)
  }

  async seek(positionSeconds: number): Promise<void> {
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0) {
      throw new RangeError('positionSeconds must be a finite, non-negative number')
    }
    this.#snapshot = await this.#control('seek', positionSeconds)
    this.dispatchEvent(new CustomEvent('timeupdate', {
      detail: { currentTime: positionSeconds },
    }))
  }

  async selectTrack(kind: TrackKind, trackId?: string): Promise<void> {
    const selected = this.#snapshot?.tracks.find((track) => track.id === trackId && track.kind === kind)
    if (selected) {
      this.#snapshot = await this.#control('track', 0, selected.index)
    } else if (kind === 'subtitle') {
      const active = this.#media.tracks.find((track) => track.kind === kind && track.selected)
      if (active) this.#snapshot = await this.#control('deselectTrack', 0, active.streamIndex)
    }
    for (const track of this.#media.tracks) {
      if (track.kind === kind) track.selected = track.id === trackId
    }
    this.dispatchEvent(new CustomEvent('trackchange', { detail: { kind, trackId } }))
  }

  async stats(): Promise<SessionStats> {
    const snapshot = await invoke<NativePlaybackSnapshot>(`${COMMAND}native_stats`)
    this.#snapshot = snapshot
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
    this.#snapshot = await this.#control(mode === 'cover' ? 'crop' : mode)
  }

  async setVideoZoom(scale: number): Promise<void> {
    this.#snapshot = await this.#control('zoom', Math.min(2, Math.max(1, scale)))
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return
    this.#destroyed = true
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#resize?.disconnect()
    await invoke(`${COMMAND}native_close`).catch(() => undefined)
    this.element.style.removeProperty('visibility')
    document.documentElement.classList.remove('tauri-native-video')
  }

  async #control(action: string, value = 0, index = -1): Promise<NativePlaybackSnapshot> {
    return invoke<NativePlaybackSnapshot>(`${COMMAND}native_control`, {
      payload: { action, value, index },
    })
  }

  async #poll(): Promise<void> {
    if (this.#destroyed || this.#polling) return
    this.#polling = true
    try {
      const previous = this.#snapshot
      const snapshot = await invoke<NativePlaybackSnapshot>(`${COMMAND}native_stats`)
      this.#snapshot = snapshot
      this.#updateMedia(snapshot)
      this.dispatchEvent(new CustomEvent('timeupdate', {
        detail: { currentTime: snapshot.currentTimeSeconds },
      }))
      this.dispatchEvent(new CustomEvent('bufferprogress', {
        detail: { bufferedAhead: this.bufferedAhead() },
      }))
      if (previous?.playing !== snapshot.playing) {
        this.element.dispatchEvent(new Event(snapshot.playing ? 'play' : 'pause'))
      }
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

  #layout(): { x: number; y: number; width: number; height: number } {
    const rect = this.element.getBoundingClientRect()
    // Android SurfaceView layout uses physical pixels; GTK Fixed uses logical
    // coordinates, which match getBoundingClientRect directly.
    const scale = /Android/i.test(navigator.userAgent) ? (window.devicePixelRatio || 1) : 1
    return {
      x: rect.left * scale,
      y: rect.top * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    }
  }

  async #syncLayout(): Promise<void> {
    if (this.#destroyed) return
    await invoke(`${COMMAND}native_layout`, { payload: this.#layout() })
  }
}

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
