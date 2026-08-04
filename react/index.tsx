import {
  FocusContext,
  init,
  setFocus,
  useFocusable,
} from '@noriginmedia/norigin-spatial-navigation'
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  attachVideo,
  type AttachVideoOptions,
  type MediaInfo,
  type MediaTrack,
  type TrackKind,
  type VideoController,
  type VideoFitMode,
  type VideoSource,
} from '../guest-js/index'

let spatialNavigationInitialized = false

export interface InitializeTvNavigationOptions {
  debug?: boolean
  visualDebug?: boolean
  throttleMs?: number
}

/** Initialize Norigin once. VideoPlayer calls this automatically in TV mode. */
export function initializeTvNavigation(options: InitializeTvNavigationOptions = {}): void {
  if (spatialNavigationInitialized) return
  init({
    debug: options.debug ?? false,
    visualDebug: options.visualDebug ?? false,
    throttle: options.throttleMs ?? 80,
    throttleKeypresses: true,
    shouldFocusDOMNode: true,
  })
  spatialNavigationInitialized = true
}

export interface VideoPlayerProps {
  source: string | VideoSource
  options?: Omit<AttachVideoOptions, 'source' | 'autoplay' | 'deviceProfile'>
  autoPlay?: boolean
  muted?: boolean
  controls?: boolean
  tvMode?: boolean
  title?: string
  className?: string
  style?: CSSProperties
  poster?: string
  children?: ReactNode
  reloadKey?: string | number
  onController?: (controller: VideoController | null) => void
  onReady?: (controller: VideoController) => void
  onError?: (error: Error) => void
}

export function VideoPlayer({
  source,
  options,
  autoPlay = false,
  muted = false,
  controls = true,
  tvMode = false,
  title = 'Video player',
  className = '',
  style,
  poster,
  children,
  reloadKey,
  onController,
  onReady,
  onError,
}: VideoPlayerProps) {
  initializeTvNavigation()
  const rootRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const controllerRef = useRef<VideoController | null>(null)
  const optionsRef = useRef(options)
  const callbacksRef = useRef({ onController, onReady, onError })
  const hideTimerRef = useRef<number | undefined>(undefined)
  const [media, setMedia] = useState<MediaInfo>(EMPTY_MEDIA)
  const [currentTime, setCurrentTime] = useState(0)
  const [bufferedTime, setBufferedTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [volume, setVolumeState] = useState(muted ? 0 : 1)
  const [fit, setFit] = useState<VideoFitMode>('fit')
  const [zoom, setZoom] = useState(1)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [scrubTime, setScrubTime] = useState<number>()
  const sourceKey = typeof source === 'string' ? source : source.uri

  optionsRef.current = options
  callbacksRef.current = { onController, onReady, onError }

  const { ref: focusRef, focusKey } = useFocusable<Record<string, never>, HTMLDivElement>({
    focusKey: 'TAURI_VIDEO_CONTROLS',
    focusable: tvMode,
    trackChildren: true,
    preferredChildFocusKey: 'TAURI_VIDEO_PLAY',
    saveLastFocusedChild: true,
    isFocusBoundary: tvMode,
  })

  useEffect(() => {
    if (!tvMode) return
    const timer = window.setTimeout(() => setFocus('TAURI_VIDEO_PLAY'), 0)
    return () => window.clearTimeout(timer)
  }, [tvMode, reloadKey])

  useEffect(() => {
    const element = videoRef.current
    if (!element) return
    const videoElement = element
    let cancelled = false
    let interval: number | undefined
    const abort = new AbortController()

    const update = () => {
      const controller = controllerRef.current
      if (!controller) return
      const latest = controller.media
      setMedia({ ...latest, tracks: [...latest.tracks], chapters: [...latest.chapters] })
      const quality = controller.playbackQuality()
      const position = quality.mediaTimeSeconds ?? element.currentTime
      if (Number.isFinite(position)) setCurrentTime(Math.max(0, position))
      setBufferedTime(Math.max(0, position + controller.bufferedAhead()))
    }
    const handleTime = (event: Event) => {
      const detail = (event as CustomEvent<{ currentTime?: number }>).detail
      if (Number.isFinite(detail?.currentTime)) setCurrentTime(Math.max(0, detail.currentTime ?? 0))
      else update()
    }
    const handleError = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail
      reportError(new Error(detail?.message ?? 'Playback failed'))
    }
    const handlePlay = () => setPlaying(true)
    const handlePause = () => setPlaying(false)

    async function open() {
      setLoading(true)
      setError('')
      setCurrentTime(0)
      setBufferedTime(0)
      setMedia(EMPTY_MEDIA)
      setZoom(1)
      try {
        const controller = await attachVideo(videoElement, {
          ...optionsRef.current,
          source,
          autoplay: false,
          deviceProfile: tvMode ? 'tv' : 'auto',
          signal: abort.signal,
        })
        if (cancelled) {
          await controller.destroy()
          return
        }
        controllerRef.current = controller
        callbacksRef.current.onController?.(controller)
        controller.addEventListener('timeupdate', handleTime)
        controller.addEventListener('bufferprogress', update)
        controller.addEventListener('trackchange', update)
        controller.addEventListener('error', handleError)
        videoElement.addEventListener('play', handlePlay)
        videoElement.addEventListener('pause', handlePause)
        videoElement.volume = volume
        await controller.setVolume(volume)
        update()
        interval = window.setInterval(update, 250)
        setLoading(false)
        callbacksRef.current.onReady?.(controller)
        if (autoPlay) {
          await controller.play()
          setPlaying(true)
        }
      } catch (reason) {
        if (!cancelled && !abort.signal.aborted) reportError(toError(reason))
      }
    }

    function reportError(reason: Error) {
      setLoading(false)
      setError(reason.message)
      callbacksRef.current.onError?.(reason)
    }

    void open()
    return () => {
      cancelled = true
      abort.abort()
      if (interval !== undefined) window.clearInterval(interval)
      const controller = controllerRef.current
      controllerRef.current = null
      callbacksRef.current.onController?.(null)
      if (controller) {
        controller.removeEventListener('timeupdate', handleTime)
        controller.removeEventListener('bufferprogress', update)
        controller.removeEventListener('trackchange', update)
        controller.removeEventListener('error', handleError)
        videoElement.removeEventListener('play', handlePlay)
        videoElement.removeEventListener('pause', handlePause)
        void controller.destroy()
      }
    }
  // reloadKey is the explicit escape hatch for option/header changes on the same URI.
  }, [sourceKey, reloadKey, tvMode])

  useEffect(() => () => {
    if (hideTimerRef.current !== undefined) window.clearTimeout(hideTimerRef.current)
  }, [])

  const revealControls = useCallback(() => {
    setControlsVisible(true)
    if (hideTimerRef.current !== undefined) window.clearTimeout(hideTimerRef.current)
    if (playing) {
      hideTimerRef.current = window.setTimeout(() => setControlsVisible(false), tvMode ? 5_000 : 2_500)
    }
  }, [playing, tvMode])

  const togglePlayback = useCallback(async () => {
    const controller = controllerRef.current
    if (!controller) return
    if (playing) {
      controller.pause()
      setPlaying(false)
      setControlsVisible(true)
    } else {
      await controller.play()
      setPlaying(true)
      revealControls()
    }
  }, [playing, revealControls])

  const seekTo = useCallback(async (seconds: number) => {
    const controller = controllerRef.current
    if (!controller) return
    const duration = media.durationSeconds ?? Number.POSITIVE_INFINITY
    const target = Math.min(duration, Math.max(0, seconds))
    setCurrentTime(target)
    setScrubTime(undefined)
    await controller.seek(target)
  }, [media.durationSeconds])

  const seekRelative = useCallback((delta: number) => {
    void seekTo(currentTime + delta)
  }, [currentTime, seekTo])

  const changeVolume = useCallback((next: number) => {
    const clamped = Math.min(1, Math.max(0, next))
    setVolumeState(clamped)
    if (videoRef.current) videoRef.current.volume = clamped
    void controllerRef.current?.setVolume(clamped)
  }, [])

  const cycleTrack = useCallback((kind: TrackKind) => {
    const tracks = media.tracks.filter((track) => track.kind === kind)
    if (tracks.length === 0) return
    const selected = tracks.findIndex((track) => track.selected)
    const next = kind === 'subtitle'
      ? selected < 0 ? 0 : selected + 1 >= tracks.length ? -1 : selected + 1
      : (selected + 1) % tracks.length
    void controllerRef.current?.selectTrack(kind, next < 0 ? undefined : tracks[next].id)
  }, [media.tracks])

  const cycleFit = useCallback(() => {
    const next: VideoFitMode = fit === 'fit' ? 'cover' : 'fit'
    setFit(next)
    void controllerRef.current?.setVideoFit(next)
  }, [fit])

  const cycleZoom = useCallback(() => {
    const steps = [1, 1.1, 1.2, 1.3]
    const current = steps.findIndex((value) => Math.abs(value - zoom) < 0.01)
    const next = steps[(current + 1) % steps.length]
    setZoom(next)
    void controllerRef.current?.setVideoZoom(next)
  }, [zoom])

  const toggleFullscreen = useCallback(async () => {
    const root = rootRef.current
    if (!root) return
    if (document.fullscreenElement) await document.exitFullscreen()
    else await root.requestFullscreen()
  }, [])

  const duration = media.durationSeconds ?? 0
  const shownTime = scrubTime ?? currentTime
  const playedPercent = duration > 0 ? Math.min(100, (shownTime / duration) * 100) : 0
  const bufferedPercent = duration > 0 ? Math.min(100, (bufferedTime / duration) * 100) : 0
  const audioTracks = useMemo(() => media.tracks.filter((track) => track.kind === 'audio'), [media])
  const subtitleTracks = useMemo(
    () => media.tracks.filter((track) => track.kind === 'subtitle'),
    [media],
  )

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    revealControls()
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return
    if (event.key === ' ' || event.key.toLowerCase() === 'k' || event.key === 'MediaPlayPause') {
      event.preventDefault()
      void togglePlayback()
    } else if (!tvMode && event.key === 'ArrowLeft') {
      event.preventDefault()
      seekRelative(-10)
    } else if (!tvMode && event.key === 'ArrowRight') {
      event.preventDefault()
      seekRelative(10)
    } else if (event.key.toLowerCase() === 'f') {
      void toggleFullscreen()
    }
  }

  return (
    <div
      ref={rootRef}
      className={`tvp-player ${tvMode ? 'tvp-tv' : ''} ${className}`.trim()}
      style={style}
      data-controls-visible={!playing || controlsVisible}
      data-loading={loading}
      data-playing={playing}
      onKeyDown={handleKeyDown}
      onMouseMove={revealControls}
      onPointerDown={revealControls}
      role="region"
      aria-label={title}
    >
      <video ref={videoRef} className="tvp-video" poster={poster} playsInline muted={muted} />
      <div className="tvp-overlay-slot">{children}</div>
      {loading && <div className="tvp-status" role="status"><span />Loading video</div>}
      {error && <div className="tvp-error" role="alert">{error}</div>}
      {controls && (
        <FocusContext.Provider value={focusKey}>
          <div ref={mergeRefs(focusRef)} className="tvp-controls" aria-label="Playback controls">
            <FocusableSlider
              tvMode={tvMode}
              focusKey="TAURI_VIDEO_TIMELINE"
              className="tvp-timeline"
              min={0}
              max={Math.max(duration, 0.01)}
              step={0.1}
              value={shownTime}
              aria-label="Seek"
              style={{
                '--tvp-played': `${playedPercent}%`,
                '--tvp-buffered': `${bufferedPercent}%`,
              } as CSSProperties}
              onChange={(event) => setScrubTime(Number(event.currentTarget.value))}
              onPointerUp={() => scrubTime !== undefined && void seekTo(scrubTime)}
              onKeyUp={(event) => {
                if (event.key === 'Home') void seekTo(0)
                if (event.key === 'End') void seekTo(duration)
              }}
              onTvLeft={() => seekRelative(-10)}
              onTvRight={() => seekRelative(10)}
            />
            <div className="tvp-control-row">
              <FocusableButton
                tvMode={tvMode}
                focusKey="TAURI_VIDEO_PLAY"
                className="tvp-icon"
                aria-label={playing ? 'Pause' : 'Play'}
                onPress={() => void togglePlayback()}
              >
                {playing ? <PauseIcon /> : <PlayIcon />}
              </FocusableButton>
              <output className="tvp-time" aria-live="off">
                {formatTime(shownTime)} <span>/</span> {formatTime(duration)}
              </output>
              <span className="tvp-buffer-label">{formatBuffer(controllerRef.current?.bufferedAhead() ?? 0)}</span>
              <div className="tvp-spacer" />
              {audioTracks.length > 0 && (
                <TrackButton
                  tvMode={tvMode}
                  focusKey="TAURI_VIDEO_AUDIO"
                  label="Audio"
                  tracks={audioTracks}
                  onPress={() => cycleTrack('audio')}
                />
              )}
              {subtitleTracks.length > 0 && (
                <TrackButton
                  tvMode={tvMode}
                  focusKey="TAURI_VIDEO_SUBTITLES"
                  label="CC"
                  tracks={subtitleTracks}
                  allowOff
                  onPress={() => cycleTrack('subtitle')}
                />
              )}
              {tvMode ? (
                <FocusableButton
                  tvMode
                  focusKey="TAURI_VIDEO_ZOOM"
                  className="tvp-text-button"
                  aria-label={`Video zoom ${zoom.toFixed(1)} times`}
                  onPress={cycleZoom}
                >
                  {zoom === 1 ? 'Zoom' : `${zoom.toFixed(1)}×`}
                </FocusableButton>
              ) : (
                <FocusableButton
                  tvMode={false}
                  focusKey="TAURI_VIDEO_FIT"
                  className="tvp-text-button"
                  onPress={cycleFit}
                >
                  {fit === 'fit' ? 'Fit' : 'Fill'}
                </FocusableButton>
              )}
              <div className="tvp-volume-group">
                <VolumeIcon />
                <FocusableSlider
                  tvMode={tvMode}
                  focusKey="TAURI_VIDEO_VOLUME"
                  className="tvp-volume"
                  min={0}
                  max={1}
                  step={0.05}
                  value={volume}
                  aria-label="Volume"
                  onChange={(event) => changeVolume(Number(event.currentTarget.value))}
                  onTvLeft={() => changeVolume(volume - 0.05)}
                  onTvRight={() => changeVolume(volume + 0.05)}
                />
              </div>
              {!tvMode && (
                <FocusableButton
                  tvMode={false}
                  focusKey="TAURI_VIDEO_FULLSCREEN"
                  className="tvp-icon"
                  aria-label="Fullscreen"
                  onPress={() => void toggleFullscreen()}
                >
                  <FullscreenIcon />
                </FocusableButton>
              )}
            </div>
          </div>
        </FocusContext.Provider>
      )}
    </div>
  )
}

export function TvVideoPlayer(props: Omit<VideoPlayerProps, 'tvMode'>) {
  return <VideoPlayer {...props} tvMode />
}

interface FocusableButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tvMode: boolean
  focusKey: string
  onPress: () => void
}

function FocusableButton({ tvMode, focusKey, onPress, children, ...props }: FocusableButtonProps) {
  const { ref, focused } = useFocusable<Record<string, never>, HTMLButtonElement>({
    focusKey,
    focusable: tvMode,
    onEnterPress: onPress,
  })
  return (
    <button
      {...props}
      ref={mergeRefs(ref)}
      type="button"
      data-focused={focused || undefined}
      onClick={(event) => {
        props.onClick?.(event)
        onPress()
      }}
    >
      {children}
    </button>
  )
}

interface FocusableSliderProps extends InputHTMLAttributes<HTMLInputElement> {
  tvMode: boolean
  focusKey: string
  onTvLeft: () => void
  onTvRight: () => void
}

function FocusableSlider({ tvMode, focusKey, onTvLeft, onTvRight, ...props }: FocusableSliderProps) {
  const { ref, focused } = useFocusable<Record<string, never>, HTMLInputElement>({
    focusKey,
    focusable: tvMode,
    onArrowPress: (direction) => {
      if (direction === 'left') onTvLeft()
      else if (direction === 'right') onTvRight()
      else return true
      return false
    },
  })
  return <input {...props} ref={mergeRefs(ref)} type="range" data-focused={focused || undefined} />
}

function TrackButton({
  tvMode,
  focusKey,
  label,
  tracks,
  allowOff = false,
  onPress,
}: {
  tvMode: boolean
  focusKey: string
  label: string
  tracks: MediaTrack[]
  allowOff?: boolean
  onPress: () => void
}) {
  const selected = tracks.find((track) => track.selected)
  const language = selected?.language?.toUpperCase()
  const value = language && language !== 'UND'
    ? language
    : selected?.label ?? (allowOff ? 'Off' : 'Default')
  const description = selected?.label && selected.label !== value
    ? `${value}, ${selected.label}`
    : value
  return (
    <FocusableButton
      tvMode={tvMode}
      focusKey={focusKey}
      className="tvp-track-button"
      aria-label={`${label}: ${description}. Press to change.`}
      onPress={onPress}
    >
      <strong>{label}</strong><span>{value}</span>
    </FocusableButton>
  )
}

function mergeRefs<T>(ref: { current: T | null }): (node: T | null) => void {
  return (node) => { ref.current = node }
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const tail = `${hours ? String(minutes).padStart(2, '0') : minutes}:${String(total % 60).padStart(2, '0')}`
  return hours ? `${hours}:${tail}` : tail
}

function formatBuffer(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Buffering'
  return `${Math.floor(seconds)}s buffered`
}

function toError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  if (typeof reason === 'string') return new Error(reason)
  if (typeof reason === 'object' && reason) {
    for (const key of ['message', 'error', 'detail', 'cause'] as const) {
      if (key in reason) {
        const value: unknown = (reason as Record<string, unknown>)[key]
        if (value !== reason) return toError(value)
      }
    }
    try { return new Error(JSON.stringify(reason)) }
    catch { /* fall through */ }
  }
  return new Error(String(reason))
}

const EMPTY_MEDIA: MediaInfo = { seekable: true, live: false, tracks: [], chapters: [] }

function PlayIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
}

function PauseIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z" /></svg>
}

function VolumeIcon() {
  return <svg className="tvp-volume-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zm12.5-.5a5 5 0 0 1 0 7M18.8 6a8 8 0 0 1 0 12" /></svg>
}

function FullscreenIcon() {
  return <svg className="tvp-outline" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" /></svg>
}
