import { useEffect, useRef, useState } from 'react'
import {
  MediaControlBar,
  MediaController,
  MediaFullscreenButton,
  MediaLoadingIndicator,
  MediaMuteButton,
  MediaPlayButton,
  MediaSeekBackwardButton,
  MediaSeekForwardButton,
  MediaTimeDisplay,
  MediaTimeRange,
  MediaVolumeRange,
} from 'media-chrome/react'

import {
  attachVideo,
  type MediaInfo,
  type PlaybackQuality,
  type VideoBackend,
  type VideoController,
  type VideoFitMode,
  type VideoSource,
} from 'tauri-plugin-video-api'

export interface PlayerTelemetry {
  currentTime: number
  duration: number
  bufferedAhead: number
  playing: boolean
  quality: PlaybackQuality | null
  media: MediaInfo
}

interface NativeMediaPlayerProps {
  source: string | VideoSource
  backend?: VideoBackend
  reloadKey: number
  title: string
  onController: (controller: VideoController | null) => void
  onBackendResolved: (backend: string | undefined) => void
  onTelemetry: (telemetry: PlayerTelemetry) => void
  onError: (error: Error) => void
}

const EMPTY_MEDIA: MediaInfo = { seekable: true, live: false, tracks: [], chapters: [] }
const AUDIO_STATE_KEY = 'tauri-video-example:audio-state'

export function NativeMediaPlayer({
  source,
  backend,
  reloadKey,
  title,
  onController,
  onBackendResolved,
  onTelemetry,
  onError,
}: NativeMediaPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const playerRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<VideoController | null>(null)
  const [telemetry, setTelemetry] = useState<PlayerTelemetry>({
    currentTime: 0,
    duration: 0,
    bufferedAhead: 0,
    playing: false,
    quality: null,
    media: EMPTY_MEDIA,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [fit, setFit] = useState<VideoFitMode>('fit')
  const [zoom, setZoom] = useState(1)
  const [fullscreen, setFullscreen] = useState(false)
  const sourceKey = typeof source === 'string' ? source : source.uri

  useEffect(() => {
    const player = playerRef.current
    if (!player) return
    const enter = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
      setFullscreen(true)
    }
    const exit = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
      setFullscreen(false)
    }
    player.addEventListener('mediaenterfullscreenrequest', enter, true)
    player.addEventListener('mediaexitfullscreenrequest', exit, true)
    return () => {
      player.removeEventListener('mediaenterfullscreenrequest', enter, true)
      player.removeEventListener('mediaexitfullscreenrequest', exit, true)
    }
  }, [])

  useEffect(() => {
    if (!fullscreen) return
    document.documentElement.classList.add('native-css-fullscreen')
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', exitOnEscape)
    return () => {
      document.documentElement.classList.remove('native-css-fullscreen')
      window.removeEventListener('keydown', exitOnEscape)
    }
  }, [fullscreen])

  useEffect(() => {
    const element = videoRef.current
    if (!element) return
    restoreAudioState(element)
    const persistAudio = () => saveAudioState(element)
    element.addEventListener('volumechange', persistAudio)
    const abort = new AbortController()
    let cancelled = false
    let interval: number | undefined

    const refresh = () => {
      const controller = controllerRef.current
      if (!controller) return
      const quality = controller.playbackQuality()
      const next = {
        currentTime: quality.mediaTimeSeconds ?? element.currentTime ?? 0,
        duration: controller.media.durationSeconds ?? element.duration ?? 0,
        bufferedAhead: controller.bufferedAhead(),
        playing: !element.paused,
        quality,
        media: {
          ...controller.media,
          tracks: controller.media.tracks.map((track) => ({ ...track })),
          chapters: [...controller.media.chapters],
        },
      }
      setTelemetry(next)
      onTelemetry(next)
    }

    async function open() {
      onBackendResolved(undefined)
      setLoading(true)
      setError('')
      setFit('fit')
      setZoom(1)
      try {
        const controller = await attachVideo(element, {
          source,
          backend,
          autoplay: false,
          deviceProfile: 'auto',
          signal: abort.signal,
          bufferAheadSeconds: 20,
          platform: {
            android: {
              buffer: { minSeconds: 12, maxSeconds: 45, playSeconds: 2.5, rebufferSeconds: 6, maxBytes: 96 * 1024 * 1024 },
              decoderFallback: true,
              dolbyVision: 'hevc-base-layer',
            },
            linux: { buffer: { maxSeconds: 20, maxBytes: 128 * 1024 * 1024 } },
            windows: { buffer: { maxSeconds: 20, maxBytes: 128 * 1024 * 1024 } },
          },
        })
        if (cancelled) {
          await controller.destroy()
          return
        }
        controllerRef.current = controller
        onController(controller)
        void controller.stats().then((stats) => {
          if (!cancelled) onBackendResolved(stats.hardwareBackend)
        }).catch(() => undefined)
        controller.addEventListener('timeupdate', refresh)
        controller.addEventListener('bufferprogress', refresh)
        controller.addEventListener('trackchange', refresh)
        controller.addEventListener('error', handleControllerError)
        interval = window.setInterval(refresh, 250)
        refresh()
        setLoading(false)
        await controller.play()
        refresh()
      } catch (reason) {
        if (!cancelled && !abort.signal.aborted) {
          const next = reason instanceof Error ? reason : new Error(String(reason))
          setError(next.message)
          setLoading(false)
          onError(next)
        }
      }
    }

    function handleControllerError(event: Event) {
      const detail = (event as CustomEvent<{ message?: string }>).detail
      const next = new Error(detail?.message ?? 'Playback failed')
      setError(next.message)
      onError(next)
    }

    void open()
    return () => {
      cancelled = true
      abort.abort()
      persistAudio()
      element.removeEventListener('volumechange', persistAudio)
      if (interval !== undefined) window.clearInterval(interval)
      const controller = controllerRef.current
      controllerRef.current = null
      onController(null)
      if (controller) {
        controller.removeEventListener('timeupdate', refresh)
        controller.removeEventListener('bufferprogress', refresh)
        controller.removeEventListener('trackchange', refresh)
        controller.removeEventListener('error', handleControllerError)
        void controller.destroy()
      }
    }
  }, [sourceKey, backend, reloadKey])

  async function selectTrack(kind: 'audio' | 'subtitle', trackId?: string) {
    await controllerRef.current?.selectTrack(kind, trackId || undefined)
  }

  async function setVideoFit(next: VideoFitMode) {
    setFit(next)
    await controllerRef.current?.setVideoFit(next)
  }

  async function setVideoZoom(next: number) {
    setZoom(next)
    await controllerRef.current?.setVideoZoom(next)
  }

  const audioTracks = telemetry.media.tracks.filter((track) => track.kind === 'audio')
  const subtitleTracks = telemetry.media.tracks.filter((track) => track.kind === 'subtitle')
  const selectedAudio = audioTracks.find((track) => track.selected)?.id ?? ''
  const selectedSubtitle = subtitleTracks.find((track) => track.selected)?.id ?? ''

  return (
    <div ref={playerRef} className="native-player" data-loading={loading} data-fullscreen={fullscreen || undefined}>
      <MediaController
        className="media-controller"
        aria-label={title}
        noHotkeys
        noAutohide
      >
        <video ref={videoRef} slot="media" playsInline aria-label={title} />
        {loading && <MediaLoadingIndicator slot="centered-chrome" noAutohide />}
        <MediaControlBar
          ref={(node) => node?.setAttribute('noautohide', '')}
          className="media-controlbar"
        >
          <MediaPlayButton />
          <MediaSeekBackwardButton seekOffset={10} />
          <MediaSeekForwardButton seekOffset={10} />
          <MediaMuteButton />
          <MediaVolumeRange />
          <MediaTimeDisplay showDuration />
          <MediaTimeRange />
          <MediaFullscreenButton mediaIsFullscreen={fullscreen} />
        </MediaControlBar>
      </MediaController>

      {error && (
        <div className="player-error" role="alert">
          <strong>Couldn’t open this stream</strong>
          <span>{error}</span>
        </div>
      )}

      <div className="native-trackbar" aria-label="Native playback options">
        <label>
          <span>Audio</span>
          <select
            value={selectedAudio}
            disabled={audioTracks.length < 2}
            onChange={(event) => void selectTrack('audio', event.currentTarget.value)}
          >
            {audioTracks.length === 0 && <option value="">Auto</option>}
            {audioTracks.map((track) => (
              <option key={track.id} value={track.id}>
                {track.language || track.label || 'Unknown'} · {formatCodec(track.codec)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Subtitles</span>
          <select
            value={selectedSubtitle}
            disabled={subtitleTracks.length === 0}
            onChange={(event) => void selectTrack('subtitle', event.currentTarget.value)}
          >
            <option value="">Off</option>
            {subtitleTracks.map((track) => (
              <option key={track.id} value={track.id}>
                {track.language || track.label || 'Unknown'} · {formatCodec(track.codec)}
              </option>
            ))}
          </select>
        </label>
        <div className="fit-control" role="group" aria-label="Video fit">
          <button type="button" aria-pressed={fit === 'fit'} onClick={() => void setVideoFit('fit')}>Fit</button>
          <button type="button" aria-pressed={fit === 'cover'} onClick={() => void setVideoFit('cover')}>Fill</button>
        </div>
        <label className="zoom-control">
          <span>Zoom</span>
          <select value={zoom} onChange={(event) => void setVideoZoom(Number(event.currentTarget.value))}>
            <option value={1}>1×</option>
            <option value={1.1}>1.1×</option>
            <option value={1.2}>1.2×</option>
            <option value={1.3}>1.3×</option>
          </select>
        </label>
      </div>
    </div>
  )
}

function formatCodec(codec: string) {
  return codec
    .replace(/^(video|audio|text)\/x-/, '')
    .replace(/^(video|audio|text)\//, '')
    .toUpperCase()
}

function restoreAudioState(element: HTMLVideoElement) {
  try {
    const value = JSON.parse(window.localStorage.getItem(AUDIO_STATE_KEY) ?? 'null') as {
      muted?: unknown
      volume?: unknown
    } | null
    if (!value) return
    if (typeof value.volume === 'number' && Number.isFinite(value.volume)) {
      element.volume = Math.min(1, Math.max(0, value.volume))
    }
    if (typeof value.muted === 'boolean') element.muted = value.muted
  } catch {
    // Playback must remain available when storage is disabled or malformed.
  }
}

function saveAudioState(element: HTMLVideoElement) {
  try {
    window.localStorage.setItem(AUDIO_STATE_KEY, JSON.stringify({
      muted: element.muted,
      volume: element.volume,
    }))
  } catch {
    // Audio controls still work when persistence is unavailable.
  }
}
