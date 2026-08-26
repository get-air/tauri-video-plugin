import type {
  AttachVideoOptions,
  BackendVideoController,
  ExternalSubtitleTrack,
  MediaInfo,
  MediaTrack,
  PlayerCapabilities,
  SubtitleCue,
  TrackKind,
  VideoControllerEventMap,
  VideoControlsTarget,
  VideoFitMode,
  VideoSource,
} from '@get-air/video'
import { parse } from '@plussub/srt-vtt-parser'

import {
  attachTauriBackend as attachNativeBackend,
  type NativeAttachVideoOptions,
  type NativeBufferOptions,
  type TauriPlaybackOptions,
} from '../guest-js/index'

/**
 * Lean native-only entrypoint for runtimes such as Blitz where the Tauri
 * backend is already known and loading the backend-selection layer is wasteful.
 */
export function attachTauriBackend(
  element: HTMLVideoElement,
  options: AttachVideoOptions,
  defaults: TauriPlaybackOptions = {},
): Promise<BackendVideoController> {
  const playback = mergePlayback(defaults, options.backendOptions?.tauri)
  const nativeOptions: NativeAttachVideoOptions = {
    ...options,
    backend: 'tauri',
    playback,
  }
  return attachNativeBackend(element, nativeOptions).then((active) =>
    options.subtitles?.length
      ? new NativeSubtitleController(active, options.subtitles)
      : active)
}

class NativeSubtitleController extends EventTarget implements BackendVideoController {
  readonly element: HTMLVideoElement
  readonly sessionId: string
  readonly #active: BackendVideoController
  readonly #externalTracks: readonly ExternalSubtitleTrack[]
  readonly #unsubscribe: Array<() => void> = []
  #selected?: ExternalSubtitleTrack
  #cues: readonly SubtitleCue[] = []
  #visibleCues: readonly SubtitleCue[] = []

  constructor(
    active: BackendVideoController,
    externalTracks: readonly ExternalSubtitleTrack[],
  ) {
    super()
    this.#active = active
    this.element = active.element
    this.sessionId = active.sessionId
    this.#externalTracks = externalTracks
    this.#forward('timeupdate', (event) => this.#updateCues(event.detail.currentTime))
    this.#forward('bufferprogress')
    this.#forward('trackchange')
    this.#forward('error')
    const initial = externalTracks.find((track) => track.default)
    if (initial) void this.#selectExternal(initial)
  }

  get capabilities(): PlayerCapabilities {
    return this.#active.capabilities.subtitleTrackSelection
      ? this.#active.capabilities
      : { ...this.#active.capabilities, subtitleTrackSelection: true }
  }

  get tracks(): readonly MediaTrack[] {
    return [
      ...this.#active.tracks,
      ...this.#externalTracks.map((track, index): MediaTrack => ({
        id: track.id,
        kind: 'subtitle',
        streamIndex: -(index + 1),
        codec: track.format ?? subtitleFormat(track),
        caps: 'text/plain',
        label: track.label,
        language: track.language,
        selected: track.id === this.#selected?.id,
        default: track.default ?? false,
        forced: false,
      })),
    ]
  }

  get media(): MediaInfo {
    return { ...this.#active.media, tracks: [...this.tracks] }
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

  play(): Promise<void> { return this.#active.play() }
  pause(): void { this.#active.pause() }
  seek(positionSeconds: number): Promise<void> { return this.#active.seek(positionSeconds) }
  setVolume(volume: number): Promise<void> { return this.#active.setVolume(volume) }
  setPlaybackRate(rate: number): Promise<void> { return this.#active.setPlaybackRate(rate) }
  setVideoFit(mode: VideoFitMode): Promise<void> { return this.#active.setVideoFit(mode) }
  setVideoZoom(scale: number): Promise<void> { return this.#active.setVideoZoom(scale) }
  stats(): ReturnType<BackendVideoController['stats']> { return this.#active.stats() }
  bufferedAhead(): number { return this.#active.bufferedAhead() }
  playbackQuality(): ReturnType<BackendVideoController['playbackQuality']> {
    return this.#active.playbackQuality()
  }
  refreshLayout(): void { this.#active.refreshLayout() }
  registerControls(target: VideoControlsTarget): () => void {
    return this.#active.registerControls(target)
  }

  async selectTrack(kind: TrackKind, trackId?: string): Promise<void> {
    if (kind !== 'subtitle') return this.#active.selectTrack(kind, trackId)
    if (trackId === undefined) {
      this.#selected = undefined
      this.#cues = []
      this.#publishCues([])
      return this.#active.selectTrack(kind, undefined)
    }
    const external = this.#externalTracks.find((track) => track.id === trackId)
    if (!external) return this.#active.selectTrack(kind, trackId)
    await this.#selectExternal(external)
  }

  async destroy(): Promise<void> {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe()
    await this.#active.destroy()
  }

  async #selectExternal(track: ExternalSubtitleTrack): Promise<void> {
    if (!track.content) {
      throw new TypeError(`Lean native subtitle track ${track.id} requires inline content`)
    }
    const result = parse(track.content)
    this.#selected = track
    this.#cues = result.entries.map((entry, index) => ({
      id: entry.id || `${track.id}-${index}`,
      startSeconds: entry.from / 1000,
      endSeconds: entry.to / 1000,
      text: entry.text,
    }))
    await this.#active.selectTrack('subtitle', undefined).catch(() => undefined)
    this.dispatchEvent(new CustomEvent('trackchange', {
      detail: { kind: 'subtitle', trackId: track.id },
    }))
    this.#updateCues(Number(this.element.currentTime) || 0)
  }

  #forward<K extends keyof VideoControllerEventMap>(
    type: K,
    before?: (event: VideoControllerEventMap[K]) => void,
  ): void {
    this.#unsubscribe.push(this.#active.on(type, (event) => {
      before?.(event)
      this.dispatchEvent(new CustomEvent(type, { detail: event.detail }))
    }))
  }

  #updateCues(currentTime: number): void {
    if (!this.#selected) return
    const visible = this.#cues.filter((cue) =>
      cue.startSeconds <= currentTime && cue.endSeconds > currentTime)
    if (visible.length === this.#visibleCues.length
      && visible.every((cue, index) => cue.id === this.#visibleCues[index]?.id)) return
    this.#publishCues(visible)
  }

  #publishCues(cues: readonly SubtitleCue[]): void {
    this.#visibleCues = cues
    this.dispatchEvent(new CustomEvent('subtitlecuechange', {
      detail: { trackId: this.#selected?.id, cues },
    }))
  }
}

function subtitleFormat(track: ExternalSubtitleTrack): 'vtt' | 'srt' {
  if (track.format) return track.format
  return track.src?.toLowerCase().split(/[?#]/, 1)[0]?.endsWith('.srt') ? 'srt' : 'vtt'
}

function mergePlayback(
  defaults: TauriPlaybackOptions,
  requested: TauriPlaybackOptions | undefined,
): TauriPlaybackOptions {
  return {
    ...defaults,
    ...requested,
    android: mergePlatformOptions(defaults.android, requested?.android),
    androidTv: mergePlatformOptions(defaults.androidTv, requested?.androidTv),
    linux: mergePlatformOptions(defaults.linux, requested?.linux),
    windows: mergePlatformOptions(defaults.windows, requested?.windows),
  }
}

function mergePlatformOptions<T extends { buffer?: NativeBufferOptions }>(
  defaults: T | undefined,
  requested: T | undefined,
): T | undefined {
  if (!defaults && !requested) return undefined
  return {
    ...defaults,
    ...requested,
    buffer: defaults?.buffer || requested?.buffer
      ? { ...defaults?.buffer, ...requested?.buffer }
      : undefined,
  } as T
}

export type {
  AttachVideoOptions,
  BackendVideoController,
  NativeBufferOptions,
  TauriPlaybackOptions,
  VideoSource,
}
