import { type FormEvent, useMemo, useState } from 'react'

import type { MediaTrack, VideoBackend, VideoController, VideoSource } from 'tauri-plugin-video-api'
import { TvVideoPlayer } from 'tauri-plugin-video-api/react'

import { NativeMediaPlayer, type PlayerTelemetry } from './NativeMediaPlayer'
import { DEFAULT_SOURCE, DEMO_SOURCES, type DemoSource } from './samples'

const params = new URLSearchParams(window.location.search)
const configuredSource = params.get('source') ?? import.meta.env.VITE_VIDEO_SOURCE
const caFile = params.get('ca') ?? import.meta.env.VITE_VIDEO_CA_FILE
const tvMode = params.get('tv') === '1' || import.meta.env.VITE_VIDEO_TV === '1'
const android = /Android/i.test(navigator.userAgent)
const backendOptions: ReadonlyArray<{ value: VideoBackend; label: string }> = android
  ? [
      { value: 'auto', label: 'Auto' },
      { value: 'media3', label: 'Media3' },
      { value: 'libvlc', label: 'LibVLC' },
    ]
  : [
      { value: 'auto', label: 'Auto' },
      { value: 'gstreamer', label: 'GStreamer' },
      { value: 'mpv', label: 'mpv' },
    ]
const configuredBackend = (
  params.get('backend') ?? import.meta.env.VITE_VIDEO_BACKEND ?? 'auto'
) as VideoBackend
const initialBackend = backendOptions.some(({ value }) => value === configuredBackend)
  ? configuredBackend
  : 'auto'
const defaultUri = configuredSource ?? DEFAULT_SOURCE.uri

declare global {
  interface Window {
    __TAURI_VIDEO_TEST__?: QualificationBridge
  }
}

interface QualificationBridge {
  controller: VideoController | null
  snapshot: () => QualificationSnapshot
  seek: (seconds: number) => Promise<void>
  play: () => Promise<void>
  pause: () => void
  setVolume: (volume: number) => Promise<void>
  selectTrack: (kind: 'audio' | 'subtitle' | 'video', trackId?: string) => Promise<void>
  loadSource: (uri: string) => void
}

interface QualificationSnapshot {
  currentTime: number
  duration: number
  bufferedAhead: number
  playing: boolean
  volume: number
  quality: ReturnType<VideoController['playbackQuality']> | null
  tracks: readonly MediaTrack[]
}

const EMPTY_TELEMETRY: PlayerTelemetry = {
  currentTime: 0,
  duration: 0,
  bufferedAhead: 0,
  playing: false,
  quality: null,
  media: { seekable: true, live: false, tracks: [], chapters: [] },
}

export default function App() {
  const [input, setInput] = useState(defaultUri)
  const [source, setSource] = useState(defaultUri)
  const [reloadKey, setReloadKey] = useState(0)
  const [requestedBackend, setRequestedBackend] = useState<VideoBackend>(initialBackend)
  const [activeBackend, setActiveBackend] = useState<string>()
  const [controller, setController] = useState<VideoController | null>(null)
  const [telemetry, setTelemetry] = useState(EMPTY_TELEMETRY)
  const [error, setError] = useState('')
  const [selectedDemo, setSelectedDemo] = useState<DemoSource | null>(
    DEMO_SOURCES.find((demo) => demo.uri === defaultUri) ?? null,
  )
  const sourceValue = useMemo<string | VideoSource>(() => {
    if (!caFile) return source
    return { uri: source, tlsCaFile: caFile }
  }, [source])

  function load(uri: string, demo: DemoSource | null = null) {
    setInput(uri)
    setSource(uri)
    setSelectedDemo(demo)
    setError('')
    setReloadKey((value) => value + 1)
  }

  function open(event: FormEvent) {
    event.preventDefault()
    const next = input.trim()
    if (next) load(next)
  }

  function changeBackend(nextBackend: VideoBackend) {
    setActiveBackend(undefined)
    setRequestedBackend(nextBackend)

    const url = new URL(window.location.href)
    if (nextBackend === 'auto') url.searchParams.delete('backend')
    else url.searchParams.set('backend', nextBackend)
    window.history.replaceState(null, '', url)
  }

  function expose(nextController: VideoController | null) {
    setController(nextController)
    if (!nextController) {
      window.__TAURI_VIDEO_TEST__ = undefined
      return
    }
    window.__TAURI_VIDEO_TEST__ = {
      controller: nextController,
      snapshot: () => {
        const quality = nextController.playbackQuality()
        return {
          currentTime: quality.mediaTimeSeconds ?? 0,
          duration: nextController.media.durationSeconds ?? 0,
          bufferedAhead: nextController.bufferedAhead(),
          playing: !nextController.element.paused,
          volume: nextController.element.volume,
          quality,
          tracks: nextController.tracks,
        }
      },
      seek: (seconds) => nextController.seek(seconds),
      play: () => nextController.play(),
      pause: () => nextController.pause(),
      setVolume: (volume) => nextController.setVolume(volume),
      selectTrack: (kind, trackId) => nextController.selectTrack(kind, trackId),
      loadSource: (uri) => load(uri),
    }
  }

  if (tvMode) {
    return (
      <main className="tv-app">
        <TvVideoPlayer
          source={sourceValue}
          reloadKey={reloadKey}
          autoPlay
          onController={expose}
          onError={(reason) => setError(reason.message)}
          options={{
            backend: requestedBackend,
            bufferAheadSeconds: 20,
            platform: {
              androidTv: {
                buffer: { minSeconds: 14, maxSeconds: 50, playSeconds: 3, rebufferSeconds: 8, maxBytes: 96 * 1024 * 1024 },
              },
            },
          }}
        >
          <div className="tv-overlay"><img src="/overlay-badge.svg" alt="" /> HTML overlay</div>
        </TvVideoPlayer>
        {error && <output className="tv-error">{error}</output>}
      </main>
    )
  }

  const videoTrack = telemetry.media.tracks.find((track) => track.kind === 'video' && track.selected)
  const audioTrack = telemetry.media.tracks.find((track) => track.kind === 'audio' && track.selected)
  const hardware = controller?.sessionId.includes('native') ? 'Native surface' : 'Compatibility path'
  const backendName = formatBackend(activeBackend, requestedBackend)
  const container = telemetry.media.container && telemetry.media.container !== 'unknown'
    ? telemetry.media.container
    : selectedDemo?.format || 'Discovering'

  return (
    <main className="app-shell">
      <header className="app-header">
        <a className="brand" href="https://github.com/vynxc/tauri-video-plugin" target="_blank" rel="noreferrer">
          <span className="brand-mark">TV</span>
          <span><strong>Tauri Video</strong><small>native stream lab</small></span>
        </a>
        <div className="header-actions">
          <label className="backend-picker">
            <span>Backend</span>
            <select
              value={requestedBackend}
              onChange={(event) => changeBackend(event.currentTarget.value as VideoBackend)}
            >
              {backendOptions.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <div className="pipeline-status" title={activeBackend ?? 'Resolving playback backend'}>
            <span />{backendName} · {hardware}
          </div>
        </div>
      </header>

      <section className="workspace">
        <div className="player-column">
          <div className="now-playing">
            <div>
              <span>Now playing</span>
              <h1>{selectedDemo?.film ?? 'Custom stream'}</h1>
            </div>
            <div className="format-line">
              <span>{container}</span>
              <span>{formatCodec(videoTrack?.codec) || selectedDemo?.video || 'Video'}</span>
              <span>{formatCodec(audioTrack?.codec) || selectedDemo?.audio || 'Audio'}</span>
            </div>
          </div>

          <NativeMediaPlayer
            source={sourceValue}
            backend={requestedBackend}
            reloadKey={reloadKey}
            title={selectedDemo?.title ?? 'Custom video stream'}
            onController={expose}
            onBackendResolved={setActiveBackend}
            onTelemetry={setTelemetry}
            onError={(reason) => setError(reason.message)}
          />

          <form className="source-form" onSubmit={open}>
            <label htmlFor="source-url">Stream URL</label>
            <div>
              <input
                id="source-url"
                value={input}
                onChange={(event) => setInput(event.currentTarget.value)}
                placeholder="https://example.com/video.mkv"
                spellCheck={false}
              />
              <button type="submit">Open stream</button>
            </div>
          </form>
        </div>

        <aside className="source-library">
          <div className="library-heading">
            <span>Free test media</span>
            <strong>{DEMO_SOURCES.length} containers</strong>
          </div>
          <nav aria-label="Demo streams">
            {DEMO_SOURCES.map((demo) => (
              <button
                type="button"
                key={demo.uri}
                className={source === demo.uri ? 'active' : ''}
                aria-current={source === demo.uri ? 'true' : undefined}
                onClick={() => load(demo.uri, demo)}
              >
                <span className="format-token">{demo.format}</span>
                <span className="source-copy">
                  <strong>{demo.film}</strong>
                  <small>{demo.video} · {demo.audio}</small>
                </span>
                <span className="source-meta"><strong>{demo.size}</strong><small>{demo.note}</small></span>
              </button>
            ))}
          </nav>

          <dl className="telemetry">
            <div><dt>Presented</dt><dd>{formatFps(telemetry.quality?.measuredFps)}</dd></div>
            <div><dt>Dropped</dt><dd>{formatDropped(telemetry.quality)}</dd></div>
            <div><dt>Buffered</dt><dd>{telemetry.bufferedAhead.toFixed(1)} s</dd></div>
            <div><dt>Frame copies</dt><dd>0</dd></div>
          </dl>

          <p className="source-credit">
            Sintel © Blender Foundation, licensed CC BY 3.0. Short samples are hosted by W3C; the MKV streams directly from Blender.
          </p>
        </aside>
      </section>
    </main>
  )
}

function formatFps(value?: number) {
  return value && value > 0 ? `${value.toFixed(2)} fps` : '—'
}

function formatDropped(quality: PlayerTelemetry['quality']) {
  if (!quality) return '—'
  return `${quality.droppedVideoFrames} · ${quality.droppedFramePercent.toFixed(2)}%`
}

function formatCodec(codec?: string) {
  if (!codec) return ''
  return codec
    .replace(/^(video|audio|text)\/x-/, '')
    .replace(/^(video|audio|text)\//, '')
    .toUpperCase()
}

function formatBackend(active: string | undefined, requested: VideoBackend) {
  const value = active?.toLowerCase()
  if (value?.startsWith('mpv')) return 'mpv'
  if (value?.includes('gstreamer') || value?.includes('gst')) return 'GStreamer'
  if (value?.includes('libvlc') || value?.includes('vlc')) return 'LibVLC'
  if (value?.includes('media3') || value?.includes('mediacodec')) return 'Media3'
  if (requested === 'auto') return 'Resolving'
  if (requested === 'gstreamer') return 'GStreamer'
  if (requested === 'libvlc') return 'LibVLC'
  if (requested === 'media3') return 'Media3'
  return requested
}
