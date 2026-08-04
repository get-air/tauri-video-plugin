import { type FormEvent, useMemo, useState } from 'react'

import type { MediaTrack, VideoController, VideoSource } from 'tauri-plugin-video-api'
import { TvVideoPlayer, VideoPlayer } from 'tauri-plugin-video-api/react'

const params = new URLSearchParams(window.location.search)
const configuredSource = params.get('source') ?? import.meta.env.VITE_VIDEO_SOURCE
const caFile = params.get('ca') ?? import.meta.env.VITE_VIDEO_CA_FILE
const tvMode = params.get('tv') === '1' || import.meta.env.VITE_VIDEO_TV === '1'
const defaultSource = configuredSource
  ?? 'https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.m4v'

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

export default function App() {
  const [input, setInput] = useState(defaultSource)
  const [source, setSource] = useState(defaultSource)
  const [reloadKey, setReloadKey] = useState(0)
  const [hasLoaded, setHasLoaded] = useState(Boolean(configuredSource))
  const [error, setError] = useState('')
  const sourceValue = useMemo<string | VideoSource>(() => {
    if (!caFile) return source
    return { uri: source, tlsCaFile: caFile }
  }, [source])
  const Player = tvMode ? TvVideoPlayer : VideoPlayer

  function open(event: FormEvent) {
    event.preventDefault()
    const next = input.trim()
    if (!next) return
    setError('')
    setSource(next)
    setHasLoaded(true)
    setReloadKey((value) => value + 1)
  }

  function expose(controller: VideoController | null) {
    if (!controller) {
      window.__TAURI_VIDEO_TEST__ = undefined
      return
    }
    window.__TAURI_VIDEO_TEST__ = {
      controller,
      snapshot: () => {
        const quality = controller.playbackQuality()
        return {
          currentTime: quality.mediaTimeSeconds ?? 0,
          duration: controller.media.durationSeconds ?? 0,
          bufferedAhead: controller.bufferedAhead(),
          playing: controller.playbackQuality().measuredFps > 0,
          volume: controller.element.volume,
          quality,
          tracks: controller.tracks,
        }
      },
      seek: (seconds) => controller.seek(seconds),
      play: () => controller.play(),
      pause: () => controller.pause(),
      setVolume: (volume) => controller.setVolume(volume),
      selectTrack: (kind, trackId) => controller.selectTrack(kind, trackId),
      loadSource: (uri) => {
        setSource(uri)
        setHasLoaded(true)
        setReloadKey((value) => value + 1)
      },
    }
  }

  return (
    <main className="app">
      {!configuredSource && (!tvMode || !hasLoaded) && (
        <form className="source" onSubmit={open}>
          <input
            id="source-url"
            value={input}
            onChange={(event) => setInput(event.currentTarget.value)}
            aria-label="Video URL"
            placeholder="Paste a video URL"
          />
          <button className="load-button" type="submit">Open</button>
        </form>
      )}
      <section className="player-shell">
        <Player
          source={sourceValue}
          reloadKey={reloadKey}
          autoPlay
          onController={expose}
          onError={(reason) => setError(reason.message)}
          options={{
            bufferAheadSeconds: 20,
            platform: {
              android: {
                buffer: { minSeconds: 12, maxSeconds: 45, playSeconds: 2.5, rebufferSeconds: 6, maxBytes: 96 * 1024 * 1024 },
                decoderFallback: true,
                dolbyVision: 'hevc-base-layer',
              },
              androidTv: {
                buffer: { minSeconds: 14, maxSeconds: 50, playSeconds: 3, rebufferSeconds: 8, maxBytes: 96 * 1024 * 1024 },
              },
              linux: { buffer: { maxSeconds: 20, maxBytes: 128 * 1024 * 1024 } },
              windows: { buffer: { maxSeconds: 20, maxBytes: 128 * 1024 * 1024 } },
            },
          }}
        >
          <img className="video-overlay" src="/overlay-badge.svg" alt="" />
        </Player>
        {error && <output className="qualification-error">{error}</output>}
      </section>
    </main>
  )
}
