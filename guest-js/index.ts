import { invoke } from '@tauri-apps/api/core'
import type {
  BackendVideoController,
  MediaInfo,
  MediaTrack,
  PlaybackQuality,
  PlayerCapabilities,
  SessionStats,
  TrackKind,
  VideoControllerEventMap,
  VideoFitMode,
  VideoPluginError,
} from '@get-air/video'
import {
  nativeOpenSettings,
  nativePlatform,
  type NativeAttachVideoOptions,
  type NativePlaybackSnapshot,
} from './models'
import {
  sameNativeSurfacePosition,
  snapNativeSurfaceLayout,
  type NativeSurfacePosition,
} from './native-surface-layout'
import {
  NativeSurfaceCompositor,
  registerVideoControls,
  type SurfaceCompositorFrame,
  type VideoControlsTarget,
} from './native-surface-compositor'
import {
  errorMessage,
  TAURI_VIDEO_PACKAGE_VERSION,
  TAURI_VIDEO_PROTOCOL_VERSION,
  verifyTauriVideoProtocol,
} from './protocol'
import { nativeFeatureUnavailableError } from './runtime-errors'

export {
  registerVideoControls,
  VIDEO_CONTROLS_ATTRIBUTE,
  type VideoControlsTarget,
} from './native-surface-compositor'
export {
  getTauriVideoDiagnostics,
  TAURI_VIDEO_PACKAGE_NAME,
  TAURI_VIDEO_PACKAGE_VERSION,
  TAURI_VIDEO_PROTOCOL_VERSION,
  verifyTauriVideoProtocol,
  type NativeVideoPluginDiagnostics,
  type TauriVideoDiagnostics,
  type VideoNativeProtocolMismatchError,
} from './protocol'
export type {
  AndroidPlaybackOptions,
  LinuxPlaybackOptions,
  NativeAttachVideoOptions,
  NativeBufferOptions,
  NativeVideoBackend,
  TauriPlaybackOptions,
  WindowsPlaybackOptions,
} from './models'

const COMMAND = 'plugin:video|'

interface WebView2TextureStreamApi {
  getTextureStream(streamId: string): Promise<MediaStream>
}

function webView2TextureStream(): WebView2TextureStreamApi | undefined {
  const scope = globalThis as typeof globalThis & {
    chrome?: { webview?: Partial<WebView2TextureStreamApi> }
  }
  const getTextureStream = scope.chrome?.webview?.getTextureStream
  return typeof getTextureStream === 'function'
    ? { getTextureStream: getTextureStream.bind(scope.chrome?.webview) }
    : undefined
}

/** @internal Raw Tauri backend factory used by the public adapter. */
export async function attachTauriBackend(
  element: HTMLVideoElement,
  options: NativeAttachVideoOptions,
): Promise<BackendVideoController> {
  if (!(element instanceof HTMLVideoElement)) {
    throw new TypeError('attachVideo requires an HTMLVideoElement')
  }
  if (!/Android|Linux|Windows/i.test(navigator.userAgent)) {
    throw new Error('Native video playback is currently supported only on Android, Linux, and Windows')
  }
  await verifyTauriVideoProtocol()
  const controller = new NativeSurfaceVideoController(element, options)
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

class NativeSurfaceVideoController extends EventTarget implements BackendVideoController {
  readonly element: HTMLVideoElement
  #options: NativeAttachVideoOptions
  #snapshot?: NativePlaybackSnapshot
  #media: MediaInfo = { seekable: true, live: false, tracks: [], chapters: [] }
  #timer?: number
  #visibilityObserver?: IntersectionObserver
  #intersectionVisible = true
  #suspendedForVisibility = false
  #requestedPlaying: boolean
  #visibilityMutation: Promise<void> = Promise.resolve()
  #resize?: ResizeObserver
  #layoutFrame?: number
  #layoutInFlight = false
  #layoutDirty = false
  #scrollTargets: EventTarget[] = []
  #compositor?: NativeSurfaceCompositor
  #textureStream?: MediaStream
  #stopCompositorObserver?: () => void
  #controlCleanups = new Set<() => void>()
  #lastLayout?: NativeSurfacePosition
  #pendingSeek?: { target: number; deadline: number }
  #polling = false
  #destroyed = false
  #volume = 1
  #muted = false
  #videoFit: VideoFitMode = 'fit'
  #videoZoom = 1
  readonly #originalObjectFit: string
  readonly #originalTransform: string
  readonly #originalTransformOrigin: string
  #removeAbortListener?: () => void
  readonly #platform = nativePlatform()
  #capabilities?: PlayerCapabilities
  readonly #sessionKey = globalThis.crypto?.randomUUID?.()
    ?? `native-${Date.now()}-${++nativeSurfaceSequence}`
  readonly #sessionId = `${this.#platform}-native-surface-${this.#sessionKey}`

  constructor(element: HTMLVideoElement, options: NativeAttachVideoOptions) {
    super()
    this.element = element
    this.#options = options
    const initialVolume = Number(element.volume)
    this.#volume = Number.isFinite(initialVolume)
      ? Math.min(1, Math.max(0, initialVolume))
      : 1
    this.#muted = Boolean(element.muted)
    this.#originalObjectFit = element.style.objectFit
    this.#originalTransform = element.style.transform
    this.#originalTransformOrigin = element.style.transformOrigin
    this.#requestedPlaying = options.autoplay ?? false
  }

  get sessionId(): string { return this.#sessionId }
  get capabilities(): PlayerCapabilities {
    if (this.#capabilities) return this.#capabilities
    const completeVideoGeometry = this.#supportsCompleteVideoGeometry()
    return this.#capabilities = {
      backend: 'tauri',
      containers: 'platform',
      codecs: 'platform',
      drm: 'platform',
      hdr: 'platform',
      playbackRate: false,
      volume: true,
      // GStreamer can preserve or stretch the aspect ratio, but its current
      // sinks cannot implement the common API's crop-to-cover mode.
      videoFit: completeVideoGeometry,
      videoZoom: completeVideoGeometry,
      audioTrackSelection: true,
      subtitleTrackSelection: true,
      customHeaders: true,
      frameAccurateSeeking: false,
    }
  }
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
    if (this.#options.controlRegions) this.registerControls(this.#options.controlRegions)
    let textureStream: Promise<MediaStream> | undefined
    if (this.#platform === 'windows') {
      const api = webView2TextureStream()
      if (!api) {
        throw new Error('This WebView2 runtime does not expose GPU texture streams')
      }
      const streamId = await invoke<string>(`${COMMAND}native_prepare_texture_stream`, {
        sessionKey: this.#sessionKey,
      })
      textureStream = api.getTextureStream(streamId)
    }
    this.element.style.visibility = 'hidden'
    const source = typeof this.#options.source === 'string'
      ? { uri: this.#options.source }
      : this.#options.source
    const requestedAutoplay = this.#options.autoplay ?? false
    const textureBootstrap = textureStream !== undefined && !requestedAutoplay
    const { layout, frame } = this.#measureLayout()
    this.#lastLayout = layout
    try {
      this.#snapshot = await invoke<NativePlaybackSnapshot>(`${COMMAND}native_open`, {
        payload: {
          protocolVersion: TAURI_VIDEO_PROTOCOL_VERSION,
          packageVersion: TAURI_VIDEO_PACKAGE_VERSION,
          sessionKey: this.#sessionKey,
          ...source,
          ...layout,
          autoplay: textureStream !== undefined || requestedAutoplay,
          volume: textureBootstrap ? 0 : this.#volume,
          muted: this.#muted,
          ...nativeOpenSettings(this.#options, this.#platform),
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
    if (textureStream) {
      this.#textureStream = await textureStream
      this.element.srcObject = this.#textureStream
      this.element.autoplay = true
      this.element.playsInline = true
      this.#applyWindowsVideoGeometry()
      this.element.style.visibility = 'visible'
      // The MediaStream has no audio; GStreamer owns audio and playback state.
      // A rejected browser autoplay promise must not tear down the native
      // session during a React source replacement.
      this.#playWindowsTextureStream()
      if (textureBootstrap) {
        // TextureStream becomes available as soon as its pool exists. Give the
        // playing pipeline enough time to replace the black preroll before
        // honoring an initially paused controller, without polling the bus and
        // triggering its buffering pause policy during bootstrap.
        await new Promise((resolve) => setTimeout(resolve, 500))
        this.#snapshot = await this.#control('pause')
        this.#snapshot = await this.#control(
          'seek',
          typeof this.#options.source === 'string'
            ? 0
            : this.#options.source.startPositionSeconds ?? 0,
        )
        this.#snapshot = await this.#control('volume', this.#muted ? 0 : this.#volume)
      }
    }
    // Keep the WebView aperture closed until the native host confirms that its
    // surface is in place. Publishing first exposes a frame of the native base
    // whenever GTK and WebKit commit scroll/resize frames at different times.
    this.#publishCssLayout(frame)
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
    if (this.#platform !== 'windows') {
      this.#resize = new ResizeObserver(() => this.#requestLayout())
      this.#resize.observe(this.element)
      this.#stopCompositorObserver = this.#compositor?.observe((backgroundChanged) => {
        if (backgroundChanged) this.#compositor?.refresh()
        this.#requestLayout()
      })
      this.#scrollTargets = nativeScrollTargets(this.element)
      for (const target of this.#scrollTargets) {
        target.addEventListener('scroll', this.#handleViewportChange, { capture: true, passive: true })
      }
      window.addEventListener('wheel', this.#handleViewportChange, { capture: true, passive: true })
      window.addEventListener('resize', this.#handleViewportChange, { passive: true })
      window.visualViewport?.addEventListener('scroll', this.#handleViewportChange, { passive: true })
      window.visualViewport?.addEventListener('resize', this.#handleViewportChange, { passive: true })
      this.#requestLayout()
    }
    this.#startPolling()
    if (this.#options.suspendWhenHidden ?? true) {
      this.#visibilityObserver = new IntersectionObserver(([entry]) => {
        this.#intersectionVisible = entry.isIntersecting
        this.#queueVisibilitySync()
      })
      this.#visibilityObserver.observe(this.element)
      document.addEventListener('visibilitychange', this.#handleDocumentVisibility)
      this.#queueVisibilitySync()
    }
    if (this.#options.signal?.aborted) throw this.#options.signal.reason
    this.#bindAbortSignal()
  }

  async play(): Promise<void> {
    this.#requestedPlaying = true
    this.#playWindowsTextureStream()
    if (this.#suspendedForVisibility) {
      this.element.dispatchEvent(new Event('play'))
      return
    }
    this.#acceptSnapshot(await this.#control('play'))
    this.#stopPolling()
    this.#startPolling()
    this.element.dispatchEvent(new Event('play'))
    this.element.dispatchEvent(new Event('playing'))
  }

  pause(): void {
    this.#requestedPlaying = false
    this.#runDetached(this.#control('pause').then((snapshot) => {
      this.#acceptSnapshot(snapshot)
      this.element.dispatchEvent(new Event('pause'))
    }))
  }

  async setVolume(volume: number): Promise<void> {
    const clamped = Math.min(1, Math.max(0, volume))
    this.#volume = clamped
    this.#acceptSnapshot(await this.#control('volume', this.#muted ? 0 : clamped))
    this.element.dispatchEvent(new Event('volumechange'))
  }

  setPlaybackRate(_rate: number): Promise<void> {
    return unsupported('playbackRate',
      'The Tauri native engines do not expose portable playback-rate changes')
  }

  async seek(positionSeconds: number): Promise<void> {
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0) {
      throw new RangeError('positionSeconds must be a finite, non-negative number')
    }
    if (this.#snapshot?.seekable === false) {
      return unsupported('seeking', 'The active media does not expose a seekable window')
    }
    const wasPlaying = this.#snapshot?.playing ?? false
    const minimum = this.#snapshot?.seekableStartSeconds ?? 0
    const maximum = this.#snapshot?.seekableEndSeconds
      ?? (this.#snapshot?.live ? Number.POSITIVE_INFINITY
        : this.#snapshot?.durationSeconds || Number.POSITIVE_INFINITY)
    const target = Math.max(minimum, Math.min(maximum, positionSeconds))
    this.#pendingSeek = { target, deadline: performance.now() + 30_000 }
    if (this.#snapshot) this.#snapshot.currentTimeSeconds = target
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
    if (trackId !== undefined) {
      const selected = this.#snapshot?.tracks.find(
        (track) => track.id === trackId && track.kind === kind,
      )
      if (!selected) throw new Error(`Unknown ${kind} track: ${trackId}`)
      this.#acceptSnapshot(await this.#control('track', 0, selected.index))
    } else if (kind === 'subtitle') {
      const active = this.#media.tracks.find((track) => track.kind === kind && track.selected)
      if (active) this.#acceptSnapshot(await this.#control('deselectTrack', 0, active.streamIndex))
    } else {
      return unsupported(`${kind}TrackDisable`,
        `The Tauri native engines cannot disable the selected ${kind} track through the common API`)
    }
    for (const track of this.#media.tracks) {
      if (track.kind === kind) track.selected = track.id === trackId
    }
    this.dispatchEvent(new CustomEvent('trackchange', { detail: { kind, trackId } }))
  }

  async stats(): Promise<SessionStats> {
    const snapshot = await this.#readStats()
    this.#acceptSnapshot(snapshot)
    return {
      sessionId: this.sessionId,
      encodedBytesBuffered: snapshot.encodedBytesBuffered ?? 0,
      bufferedAheadSeconds: Math.max(0, snapshot.bufferedSeconds - snapshot.currentTimeSeconds),
      hardwareBackend: snapshot.hardwareBackend || (this.#platform === 'android'
        ? 'android-mediaplayer-surface'
        : 'gstreamer-va-gl-gtk'),
      decodedFrameCopies: 0,
      droppedFrames: snapshot.droppedFrames ?? 0,
      averageFrameProcessingUs: snapshot.averageFrameProcessingUs,
      videoCodec: snapshot.tracks.find((track) => track.kind === 'video' && track.selected)?.codec,
      audioCodec: snapshot.tracks.find((track) => track.kind === 'audio' && track.selected)?.codec,
      visible: true,
      playing: snapshot.playing,
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

  refreshLayout(): void { this.#requestLayout() }

  async setVideoFit(mode: VideoFitMode): Promise<void> {
    if (mode === 'cover' && !this.#supportsCompleteVideoGeometry()) {
      return unsupported('videoFit',
        'The active GStreamer sink cannot crop video to the common cover fit mode')
    }
    this.#acceptSnapshot(await this.#control(mode === 'cover' ? 'crop' : mode))
    this.#videoFit = mode
    this.#applyWindowsVideoGeometry()
  }

  async setVideoZoom(scale: number): Promise<void> {
    if (!this.#supportsCompleteVideoGeometry()) {
      return unsupported('videoZoom',
        'The active GStreamer sink does not expose portable video-surface zoom')
    }
    const clamped = Math.min(2, Math.max(1, scale))
    this.#acceptSnapshot(await this.#control('zoom', clamped))
    this.#videoZoom = clamped
    this.#applyWindowsVideoGeometry()
  }

  registerControls(target: VideoControlsTarget): () => void {
    const unregister = registerVideoControls(target)
    let active = true
    const cleanup = () => {
      if (!active) return
      active = false
      this.#controlCleanups.delete(cleanup)
      unregister()
    }
    this.#controlCleanups.add(cleanup)
    if (this.#snapshot) this.#requestLayout()
    return cleanup
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#removeAbortListener?.()
    this.#removeAbortListener = undefined
    this.#stopPolling()
    this.#visibilityObserver?.disconnect()
    document.removeEventListener('visibilitychange', this.#handleDocumentVisibility)
    if (this.#layoutFrame !== undefined) cancelAnimationFrame(this.#layoutFrame)
    this.#resize?.disconnect()
    this.#stopCompositorObserver?.()
    this.#stopCompositorObserver = undefined
    for (const target of this.#scrollTargets) {
      target.removeEventListener('scroll', this.#handleViewportChange, true)
    }
    this.#scrollTargets = []
    window.removeEventListener('wheel', this.#handleViewportChange, true)
    window.removeEventListener('resize', this.#handleViewportChange)
    window.visualViewport?.removeEventListener('scroll', this.#handleViewportChange)
    window.visualViewport?.removeEventListener('resize', this.#handleViewportChange)
    for (const cleanup of this.#controlCleanups) cleanup()
    for (const track of this.#textureStream?.getTracks() ?? []) track.stop()
    this.#textureStream = undefined
    this.element.srcObject = null
    await invoke(`${COMMAND}native_close`, {
      payload: { sessionKey: this.#sessionKey },
    }).catch(() => undefined)
    if (this.#removeMediaFacade()) {
      // Preserve the facade's final audio state on the real HTMLMediaElement so
      // a replacement controller/source starts from the same user preference.
      this.element.volume = this.#volume
      this.element.muted = this.#muted
      this.element.style.removeProperty('visibility')
      this.element.style.objectFit = this.#originalObjectFit
      this.element.style.transform = this.#originalTransform
      this.element.style.transformOrigin = this.#originalTransformOrigin
    }
    this.#releaseCssSurface()
  }

  #control(action: string, value = 0, index = -1): Promise<NativePlaybackSnapshot> {
    return invoke<NativePlaybackSnapshot>(`${COMMAND}native_control`, {
      // Session ownership prevents delayed cleanup from a prior React render
      // from controlling the replacement native player.
      payload: { sessionKey: this.#sessionKey, action, value, index },
    })
  }

  #readStats(): Promise<NativePlaybackSnapshot> {
    return invoke(`${COMMAND}native_stats`, { payload: { sessionKey: this.#sessionKey } })
  }

  async #poll(): Promise<void> {
    if (this.#destroyed || this.#polling || this.#suspendedForVisibility) return
    // Safety net for layout changes caused by transforms, programmatic scroll,
    // or WebKit builds that omit an element-scroll event from the window path.
    // The geometry comparison prevents unchanged layouts from crossing IPC.
    this.#requestLayout()
    this.#polling = true
    try {
      const previous = this.#snapshot
      const snapshot = await this.#readStats()
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
      if (previous?.durationSeconds !== snapshot.durationSeconds
        || previous?.live !== snapshot.live) {
        this.element.dispatchEvent(new Event('durationchange'))
      }
      if (previous?.playing !== snapshot.playing) {
        this.element.dispatchEvent(new Event(snapshot.playing ? 'play' : 'pause'))
        if (snapshot.playing) this.element.dispatchEvent(new Event('playing'))
      }
      const wasEnded = Boolean(previous
        && !previous.live
        && previous.durationSeconds > 0
        && previous.currentTimeSeconds >= previous.durationSeconds)
      const isEnded = !snapshot.live
        && snapshot.durationSeconds > 0
        && snapshot.currentTimeSeconds >= snapshot.durationSeconds
      if (!wasEnded && isEnded) {
        this.#requestedPlaying = false
        this.element.dispatchEvent(new Event('ended'))
      }
    } catch (error) {
      this.#publishError(error)
    } finally {
      this.#polling = false
    }
  }

  #updateMedia(snapshot: NativePlaybackSnapshot): void {
    const live = snapshot.live ?? false
    this.#media.durationSeconds = live ? undefined : snapshot.durationSeconds
    this.#media.seekable = snapshot.seekable ?? !live
    this.#media.seekableStartSeconds = this.#media.seekable
      ? snapshot.seekableStartSeconds ?? 0
      : undefined
    this.#media.seekableEndSeconds = this.#media.seekable
      ? snapshot.seekableEndSeconds ?? (live ? undefined : snapshot.durationSeconds)
      : undefined
    this.#media.live = live
    this.#media.container = snapshot.container ?? 'unknown'
    const tracksChanged = snapshot.tracks.length !== this.#media.tracks.length
      || snapshot.tracks.some((track, index) => {
        const cached = this.#media.tracks[index]
        return !cached
          || cached.id !== track.id
          || cached.kind !== track.kind
          || cached.streamIndex !== track.index
          || cached.codec !== track.codec
          || cached.label !== track.label
          || cached.language !== track.language
          || cached.selected !== track.selected
          || (track.kind === 'video' && (
            cached.width !== snapshot.videoWidth || cached.height !== snapshot.videoHeight
          ))
      })
    if (tracksChanged) {
      this.#media.tracks = snapshot.tracks.map((track) => ({
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
      }))
    }
  }

  #acceptSnapshot(snapshot: NativePlaybackSnapshot): NativePlaybackSnapshot {
    const pending = this.#pendingSeek
    if (pending) {
      if (Math.abs(snapshot.currentTimeSeconds - pending.target) <= 1
        || performance.now() >= pending.deadline) this.#pendingSeek = undefined
      else snapshot.currentTimeSeconds = pending.target
    }
    return this.#snapshot = snapshot
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
    const ranges = (start: number, end: number): TimeRanges => ({
      length: end > start ? 1 : 0,
      start: (index: number) => {
        if (index !== 0 || end <= start) throw new DOMException('Index out of bounds', 'IndexSizeError')
        return start
      },
      end: (index: number) => {
        if (index !== 0 || end <= start) throw new DOMException('Index out of bounds', 'IndexSizeError')
        return end
      },
    })

    define('play', { value: () => this.play() })
    define('pause', { value: () => this.pause() })
    define('currentTime', {
      get: () => this.#snapshot?.currentTimeSeconds ?? 0,
      set: (value: number) => { this.#runDetached(this.seek(Number(value))) },
    })
    define('duration', {
      get: () => this.#snapshot?.live
        ? Number.POSITIVE_INFINITY
        : this.#snapshot?.durationSeconds ?? Number.NaN,
    })
    define('paused', { get: () => !this.#requestedPlaying })
    define('ended', {
      get: () => Boolean(this.#snapshot
        && !this.#snapshot.live
        && this.#snapshot.durationSeconds > 0
        && this.#snapshot.currentTimeSeconds >= this.#snapshot.durationSeconds),
    })
    define('volume', {
      get: () => this.#volume,
      set: (value: number) => { this.#runDetached(this.setVolume(Number(value))) },
    })
    define('muted', {
      get: () => this.#muted,
      set: (value: boolean) => {
        this.#muted = Boolean(value)
        this.#runDetached(this.#control('volume', this.#muted ? 0 : this.#volume).then((snapshot) => {
          this.#acceptSnapshot(snapshot)
        }))
        this.element.dispatchEvent(new Event('volumechange'))
      },
    })
    define('buffered', {
      get: () => {
        const snapshot = this.#snapshot
        if (!snapshot) return ranges(0, 0)
        const start = snapshot.live
          ? snapshot.seekableStartSeconds ?? snapshot.currentTimeSeconds
          : 0
        return ranges(Math.min(start, snapshot.currentTimeSeconds), snapshot.bufferedSeconds)
      },
    })
    define('seekable', {
      get: () => {
        const snapshot = this.#snapshot
        if (!snapshot || snapshot.seekable === false) return ranges(0, 0)
        return ranges(
          snapshot.seekableStartSeconds ?? 0,
          snapshot.seekableEndSeconds ?? (snapshot.live ? 0 : snapshot.durationSeconds),
        )
      },
    })
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

  #measureLayout(): {
    layout: NativeSurfacePosition
    frame: SurfaceCompositorFrame | undefined
  } {
    const rect = this.element.getBoundingClientRect()
    // Android SurfaceView layout uses physical pixels; GTK Fixed uses logical
    // coordinates, which match getBoundingClientRect directly.
    const android = this.#platform === 'android'
    const scale = android ? (window.devicePixelRatio || 1) : 1
    const layout = snapNativeSurfaceLayout(rect, android, scale) as NativeSurfacePosition
    const scrollX = Number(window.scrollX)
    const scrollY = Number(window.scrollY)
    layout.scrollX = android && Number.isFinite(scrollX) ? Math.round(scrollX * scale) : 0
    layout.scrollY = android && Number.isFinite(scrollY) ? Math.round(scrollY * scale) : 0
    return { layout, frame: this.#compositor?.measure(layout, scale) }
  }

  #claimCssSurface(): void {
    if (this.#platform === 'windows') return
    this.#compositor = new NativeSurfaceCompositor(this.#sessionKey, this.element)
  }

  #applyWindowsVideoGeometry(): void {
    if (this.#platform !== 'windows') return
    this.element.style.objectFit = this.#videoFit === 'fit'
      ? 'contain'
      : this.#videoFit === 'cover' ? 'cover' : 'fill'
    this.element.style.transformOrigin = 'center'
    this.element.style.transform = this.#videoZoom === 1 ? 'none' : `scale(${this.#videoZoom})`
  }

  #playWindowsTextureStream(): void {
    if (!this.#textureStream) return
    void HTMLMediaElement.prototype.play.call(this.element).catch(() => undefined)
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

  #publishCssLayout(frame: SurfaceCompositorFrame | undefined): void {
    if (frame) this.#compositor?.commit(frame)
  }

  #releaseCssSurface(): void {
    this.#compositor?.release()
    this.#compositor = undefined
  }

  #bindAbortSignal(): void {
    const signal = this.#options.signal
    if (!signal) return
    const abort = () => this.#runDetached(this.destroy())
    signal.addEventListener('abort', abort, { once: true })
    this.#removeAbortListener = () => signal.removeEventListener('abort', abort)
  }

  #runDetached(operation: Promise<unknown>): void {
    void operation.catch((error) => this.#publishError(error))
  }

  #publishError(error: unknown): void {
    if (!this.#destroyed) {
      this.dispatchEvent(new CustomEvent('error', { detail: normalizeError(error) }))
    }
  }

  #supportsCompleteVideoGeometry(): boolean {
    if (this.#platform === 'android' || this.#platform === 'windows') return true
    if (this.#platform !== 'linux') return false
    return this.#options.playback?.engine === 'mpv'
      || /\bmpv\b/i.test(this.#snapshot?.hardwareBackend ?? '')
  }

  #handleViewportChange = (): void => this.#requestLayout()
  #handleDocumentVisibility = (): void => this.#queueVisibilitySync()

  #startPolling(): void {
    if (this.#timer === undefined && !this.#destroyed && !this.#suspendedForVisibility) {
      this.#schedulePoll(0)
    }
  }

  #schedulePoll(delayMs: number): void {
    if (this.#timer !== undefined || this.#destroyed || this.#suspendedForVisibility) return
    this.#timer = window.setTimeout(async () => {
      this.#timer = undefined
      await this.#poll()
      this.#schedulePoll(this.#requestedPlaying ? 250 : 1_000)
    }, delayMs)
  }

  #stopPolling(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }

  #queueVisibilitySync(): void {
    this.#visibilityMutation = this.#visibilityMutation
      .catch(() => undefined)
      .then(() => this.#syncVisibility())
      .catch((error) => this.#publishError(error))
  }

  async #syncVisibility(): Promise<void> {
    if (this.#destroyed || !(this.#options.suspendWhenHidden ?? true)) return
    const visible = this.#intersectionVisible && document.visibilityState === 'visible'
    if (!visible && !this.#suspendedForVisibility) {
      this.#suspendedForVisibility = true
      this.#stopPolling()
      if (this.#requestedPlaying) await this.#control('pause')
      return
    }
    if (visible && this.#suspendedForVisibility) {
      this.#suspendedForVisibility = false
      this.#requestLayout()
      this.#startPolling()
      if (this.#requestedPlaying) {
        this.#acceptSnapshot(await this.#control('play'))
      }
    }
  }

  #requestLayout(): void {
    if (this.#destroyed || this.#platform === 'windows') return
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
      const { layout, frame } = this.#measureLayout()
      if (sameNativeSurfacePosition(layout, this.#lastLayout, this.#platform === 'android')) {
        // Viewport bounds can change without moving the anchor. Refresh the
        // surrounding panels while keeping the already-aligned aperture.
        this.#publishCssLayout(frame)
        return
      }
      await invoke(`${COMMAND}native_layout`, {
        payload: { sessionKey: this.#sessionKey, ...layout },
      })
      this.#lastLayout = layout
      // This is deliberately after native_layout. The native player may be
      // briefly hidden by the old aperture, but an unsynchronised move can
      // never reveal the transparent window beneath it.
      this.#publishCssLayout(frame)
    } catch (error) {
      this.#publishError(error)
    } finally {
      this.#layoutInFlight = false
      if (this.#layoutDirty && !this.#destroyed) this.#requestLayout()
    }
  }

}

function nativeScrollTargets(anchor: HTMLElement): EventTarget[] {
  const targets = new Set<EventTarget>([window, document])
  for (let element: HTMLElement | null = anchor.parentElement; element; element = element.parentElement) {
    targets.add(element)
  }
  return [...targets]
}

async function unsupported(feature: string, message: string): Promise<never> {
  throw await nativeFeatureUnavailableError({ backend: 'tauri', feature, message })
}

function normalizeError(error: unknown): VideoPluginError {
  if (typeof error === 'object' && error && 'code' in error && 'message' in error) {
    return error as VideoPluginError
  }
  return { code: 'transport', message: errorMessage(error) }
}
