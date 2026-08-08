import { invoke } from '@tauri-apps/api/core'
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

export {
  registerVideoControls,
  VIDEO_CONTROLS_ATTRIBUTE,
  type VideoControlsTarget,
} from './native-surface-compositor'

const COMMAND = 'plugin:video|'

export type TrackKind = 'video' | 'audio' | 'subtitle'
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

export interface SessionStats {
  sessionId: string
  encodedBytesBuffered: number
  bufferedAheadSeconds: number
  videoCodec?: string
  audioCodec?: string
  hardwareBackend?: string
  decodedFrameCopies: number
  droppedFrames: number
  averageFrameProcessingUs?: number
  visible: boolean
  playing: boolean
}

export interface PlaybackQuality {
  presentedFrames: number
  mediaTimeSeconds?: number
  measuredFps: number
  totalVideoFrames: number
  droppedVideoFrames: number
  droppedFramePercent: number
}

export interface AttachVideoOptions {
  source: string | VideoSource
  /** Native playback engine. Alternative engines must be requested explicitly. */
  backend?: VideoBackend
  suspendWhenHidden?: boolean
  autoplay?: boolean
  deviceProfile?: DeviceProfile
  platform?: PlatformPlaybackOptions
  /** DOM regions that belong to this player's UI, wherever they are mounted. */
  controlRegions?: VideoControlsTarget
  signal?: AbortSignal
}

export type VideoBackend = 'auto' | 'media3' | 'libvlc' | 'gstreamer' | 'mpv'

export interface NativeBufferOptions {
  /** Optional backend-specific minimum reserve override. Omit to use the player's default. */
  minSeconds?: number
  /** Optional backend-specific maximum reserve override. Omit to use the player's default. */
  maxSeconds?: number
  /** Optional initial-play reserve override. */
  playSeconds?: number
  /** Optional post-stall reserve override. */
  rebufferSeconds?: number
  /** Optional encoded-buffer target. Decoder surfaces are not included. */
  maxBytes?: number
}

export interface AndroidPlaybackOptions {
  buffer?: NativeBufferOptions
  /** Allow Media3 to try another installed MediaCodec decoder. This never switches engines. */
  decoderFallback?: boolean
  dolbyVision?: 'hevc-base-layer' | 'platform'
  tunneling?: boolean
}

export interface LinuxPlaybackOptions {
  buffer?: NativeBufferOptions
}

export interface PlatformPlaybackOptions {
  android?: AndroidPlaybackOptions
  /** Merged over android when deviceProfile is tv. */
  androidTv?: AndroidPlaybackOptions
  linux?: LinuxPlaybackOptions
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
  /** Mark arbitrary DOM as this player's UI. Returns an unregister function. */
  registerControls(target: VideoControlsTarget): () => void
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

export async function attachVideo(
  element: HTMLVideoElement,
  options: AttachVideoOptions,
): Promise<VideoController> {
  if (!(element instanceof HTMLVideoElement)) {
    throw new TypeError('attachVideo requires an HTMLVideoElement')
  }
  if (!/Android|Linux/i.test(navigator.userAgent)) {
    throw new Error('Native video playback is currently supported only on Android and Linux')
  }
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

class NativeSurfaceVideoController extends EventTarget implements VideoController {
  readonly element: HTMLVideoElement
  #options: AttachVideoOptions
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
  #stopCompositorObserver?: () => void
  #controlCleanups = new Set<() => void>()
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
    this.#requestedPlaying = options.autoplay ?? false
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
    if (this.#options.controlRegions) this.registerControls(this.#options.controlRegions)
    this.element.style.visibility = 'hidden'
    const source = typeof this.#options.source === 'string'
      ? { uri: this.#options.source }
      : this.#options.source
    const { layout, frame } = this.#measureLayout()
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
    this.#options.signal?.addEventListener('abort', () => void this.destroy(), { once: true })
  }

  async play(): Promise<void> {
    this.#requestedPlaying = true
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
      encodedBytesBuffered: snapshot.encodedBytesBuffered ?? 0,
      bufferedAheadSeconds: Math.max(0, snapshot.bufferedSeconds - snapshot.currentTimeSeconds),
      hardwareBackend: snapshot.hardwareBackend || (/Android/i.test(navigator.userAgent)
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

  async setVideoFit(mode: VideoFitMode): Promise<void> {
    this.#acceptSnapshot(await this.#control(mode === 'cover' ? 'crop' : mode))
  }

  async setVideoZoom(scale: number): Promise<void> {
    this.#acceptSnapshot(await this.#control('zoom', Math.min(2, Math.max(1, scale))))
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
    for (const cleanup of [...this.#controlCleanups]) cleanup()
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
    if (this.#destroyed || this.#polling || this.#suspendedForVisibility) return
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
      if (!wasEnded && isEnded) {
        this.#requestedPlaying = false
        this.element.dispatchEvent(new Event('ended'))
      }
    } catch (error) {
      if (!this.#destroyed) this.dispatchEvent(new CustomEvent('error', { detail: normalizeError(error) }))
    } finally {
      this.#polling = false
    }
  }

  #updateMedia(snapshot: NativePlaybackSnapshot): void {
    this.#media.durationSeconds = snapshot.durationSeconds
    this.#media.seekable = true
    this.#media.live = false
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
    define('paused', { get: () => !this.#requestedPlaying })
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

  #measureLayout(): {
    layout: NativeSurfacePosition
    frame: SurfaceCompositorFrame
  } {
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
    return {
      layout,
      frame: this.#compositor?.measure(layout, scale) ?? {
        bounds: { left: 0, top: 0, right: 0, bottom: 0 },
        width: 0,
        height: 0,
        radii: [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
          { x: 0, y: 0 },
          { x: 0, y: 0 },
        ],
        ancestors: [],
        occluders: [],
      },
    }
  }

  #claimCssSurface(): void {
    this.#compositor = new NativeSurfaceCompositor(this.#sessionKey, this.element)
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

  #publishCssLayout(frame: SurfaceCompositorFrame): void {
    this.#compositor?.commit(frame)
  }

  #releaseCssSurface(): void {
    this.#compositor?.release()
    this.#compositor = undefined
  }

  #handleViewportChange = (): void => {
    this.#requestLayout()
  }

  #handleDocumentVisibility = (): void => {
    this.#queueVisibilitySync()
  }

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
      .catch((error) => {
        if (!this.#destroyed) {
          this.dispatchEvent(new CustomEvent('error', { detail: normalizeError(error) }))
        }
      })
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
      const { layout, frame } = this.#measureLayout()
      if (sameNativeSurfacePosition(layout, this.#lastLayout, /Android/i.test(navigator.userAgent))) {
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
      if (!this.#destroyed) {
        this.dispatchEvent(new CustomEvent('error', { detail: normalizeError(error) }))
      }
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

function nativeOpenSettings(options: AttachVideoOptions): Record<string, unknown> {
  const userAgent = navigator.userAgent
  const android = /Android/i.test(userAgent)
  const linux = /Linux/i.test(userAgent) && !android
  const tv = options.deviceProfile === 'tv'
    || ((options.deviceProfile === undefined || options.deviceProfile === 'auto')
      && /\bTV\b|AFT|BRAVIA|SHIELD|GoogleTV/i.test(userAgent))
  const androidBase = options.platform?.android
  const androidOptions = android
    ? { ...androidBase, ...(tv ? options.platform?.androidTv : undefined) }
    : undefined
  const buffer = androidOptions?.buffer
    ?? (linux ? options.platform?.linux?.buffer : undefined)
  return {
    backend: options.backend ?? 'auto',
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
