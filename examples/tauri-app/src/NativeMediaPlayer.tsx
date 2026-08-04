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
  reloadKey: number
  title: string
  onController: (controller: VideoController | null) => void
  onTelemetry: (telemetry: PlayerTelemetry) => void
  onError: (error: Error) => void
}

const EMPTY_MEDIA: MediaInfo = { seekable: true, live: false, tracks: [], chapters: [] }

export function NativeMediaPlayer({
  source,
  reloadKey,
  title,
  onController,
  onTelemetry,
  onError,
}: NativeMediaPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
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
  const sourceKey = typeof source === 'string' ? source : source.uri

  useEffect(() => {
    const element = videoRef.current
    if (!element) return
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
      setLoading(true)
      setError('')
      setFit('fit')
      setZoom(1)
      try {
        const controller = await attachVideo(element, {
          source,
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
  }, [sourceKey, reloadKey])

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
    <div className="native-player" data-loading={loading}>
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
          <MediaFullscreenButton />
        </MediaControlBar>
      </MediaController>

      <div className="html-overlay" aria-hidden="true">
        <img src="/overlay-badge.svg" alt="" />
        <span>HTML overlay</span>
      </div>

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
