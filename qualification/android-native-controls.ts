#!/usr/bin/env -S npx tsx

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ChromeRuntime, commandOptions, delay } from './chrome-devtools'

interface NativeTrack { id: string; kind: string; selected: boolean }

interface NativeControlSample {
  label: string
  currentTime: number
  duration: number
  paused: boolean
  volume: number
  state: string
  backend: string
  encodedBytesBuffered: number
  error: string
  fps: number
  totalVideoFrames: number
  droppedVideoFrames: number
  bufferedAhead: number
  tracks: NativeTrack[]
  focused: string
  zoomValue: string
  fullscreenPresent: boolean
  fullscreenActive: boolean
}

interface ScrollProbe { before: number; after: number }

const options = commandOptions()
const adb = options.adb ?? 'adb'
const serial = options.serial ?? 'emulator-5554'
const platform = options.platform ?? 'android-phone-native'
const source = options.source ?? 'https://10.0.2.2:9443/h264-multitrack-subtitles-30.mkv'
const alreadyLoaded = options['already-loaded'] === '1'
const skipTracks = options['skip-tracks'] === '1'
const artifactRoot = options.artifacts ?? 'qualification/artifacts'
const outputDirectory = join(artifactRoot, platform)
const logDirectory = join(artifactRoot, 'logs')
mkdirSync(outputDirectory, { recursive: true })
mkdirSync(logDirectory, { recursive: true })

const runtime = await ChromeRuntime.connect()
const evaluate = <T>(expression: string): Promise<T> => runtime.evaluate<T>(expression, true)

async function sample(label: string): Promise<NativeControlSample> {
  const result = await evaluate<NativeControlSample>(`(async () => {
    const bridge = window.__TAURI_VIDEO_TEST__;
    const snapshot = bridge?.snapshot();
    const stats = bridge?.controller ? await bridge.controller.stats() : null;
    return {
      label: ${JSON.stringify(label)},
      currentTime: snapshot?.currentTime ?? 0,
      duration: snapshot?.duration ?? 0,
      paused: stats?.state !== 'playing',
      volume: snapshot?.volume ?? 0,
      state: stats?.state ?? 'opening',
      backend: stats?.hardwareBackend ?? '',
      encodedBytesBuffered: stats?.encodedBytesBuffered ?? 0,
      error: document.querySelector('.player-error, .tvp-error')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
      fps: snapshot?.quality?.measuredFps ?? 0,
      totalVideoFrames: snapshot?.quality?.totalVideoFrames ?? 0,
      droppedVideoFrames: snapshot?.quality?.droppedVideoFrames ?? 0,
      bufferedAhead: snapshot?.bufferedAhead ?? 0,
      tracks: snapshot?.tracks ?? [],
      focused: document.activeElement?.getAttribute('aria-label')
        ?? document.activeElement?.textContent?.replace(/\\s+/g, ' ').trim()
        ?? '',
      zoomValue: document.querySelector('.zoom-control select')?.value ?? '',
      fullscreenPresent: Boolean(document.querySelector('media-fullscreen-button')),
      fullscreenActive: document.querySelector('.native-player')?.dataset.fullscreen === 'true',
    };
  })()`)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return result
}

async function waitFor(
  predicate: (sample: NativeControlSample) => boolean,
  timeoutMs = 40_000,
): Promise<NativeControlSample> {
  const started = Date.now()
  let value: NativeControlSample | undefined
  while (Date.now() - started < timeoutMs) {
    await delay(500)
    value = await sample('poll')
    if (predicate(value)) return value
    if (value.error) throw new Error(value.error)
  }
  throw new Error(`Timed out after ${timeoutMs}ms; last sample: ${JSON.stringify(value)}`)
}

function screenshot(name: string): void {
  const image = execFileSync(adb, ['-s', serial, 'exec-out', 'screencap', '-p'])
  writeFileSync(join(outputDirectory, `controls-${name}.png`), image)
}

if (!alreadyLoaded) {
  await evaluate<boolean>(`(() => {
    const bridge = window.__TAURI_VIDEO_TEST__;
    if (bridge?.loadSource) { bridge.loadSource(${JSON.stringify(source)}); return true; }
    const input = document.querySelector('#source-url');
    if (!input) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(source)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const button = document.querySelector('.source-form button[type="submit"]');
    if (!button) return false;
    button.click();
    return true;
  })()`)
}
const playing = await waitFor((value) => value.currentTime >= 2 && !value.paused)
screenshot('01-playing-overlay')

const beforeAudio = await sample('before-audio')
let audio = beforeAudio
let subtitle = beforeAudio
if (!skipTracks) {
  await evaluate<void>(`(() => {
    const bridge = window.__TAURI_VIDEO_TEST__;
    const tracks = bridge.snapshot().tracks.filter(track => track.kind === 'audio');
    return bridge.selectTrack('audio', tracks[1].id);
  })()`)
  audio = await waitFor((value) => (
    value.tracks.filter((track) => track.kind === 'audio')[1]?.selected
    && value.currentTime >= beforeAudio.currentTime - 1
  ))
  screenshot('02-audio-track')

  await evaluate<void>(`(() => {
    const bridge = window.__TAURI_VIDEO_TEST__;
    const track = bridge.snapshot().tracks.find(track => track.kind === 'subtitle');
    return bridge.selectTrack('subtitle', track.id);
  })()`)
  subtitle = await waitFor((value) => (
    value.tracks.some((track) => track.kind === 'subtitle' && track.selected)
  ))
  await delay(1_000)
  screenshot('03-subtitle-overlay')
}

await evaluate<void>(`window.__TAURI_VIDEO_TEST__.seek(13)`)
const seek = await waitFor((value) => value.currentTime >= 13)
screenshot('04-seek')

await evaluate<void>(`window.__TAURI_VIDEO_TEST__.setVolume(0.35)`)
const volume = await waitFor((value) => Math.abs(value.volume - 0.35) < 0.01)
screenshot('05-volume')

let zoom = { zoomValue: '', fullscreenPresent: true }
if (platform.includes('tv')) {
  await evaluate<boolean>(`(() => {
    const select = document.querySelector('.zoom-control select');
    select.value = '1.1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
  await delay(500)
  zoom = await sample('zoom')
  screenshot('06-zoom')
}

let dpad = { focused: '', currentTime: 0 }
if (platform.includes('tv')) {
  execFileSync(adb, ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_DPAD_RIGHT'])
  await delay(250)
  dpad = await sample('dpad-right')
  screenshot('07-dpad-focus')
}

let fullscreen = { fullscreenActive: false }
if (!platform.includes('tv')) {
  await evaluate<void>(`document.querySelector('media-fullscreen-button')?.click()`)
  await delay(750)
  fullscreen = await sample('fullscreen')
  screenshot('06-fullscreen-overlay')
  await evaluate<void>(`document.querySelector('media-fullscreen-button')?.click()`)
  await delay(500)
}

const scrollProbe = await evaluate<ScrollProbe>(`(async () => {
  const player = document.querySelector('.native-player');
  const before = player.getBoundingClientRect().top;
  window.scrollBy(0, 160);
  await new Promise(resolve => setTimeout(resolve, 500));
  const after = player.getBoundingClientRect().top;
  return { before, after };
})()`)
screenshot('08-scrolled-surface')
await evaluate<void>(`window.scrollTo(0, 0)`)

const overlayVisible = await evaluate<boolean>(`(() => {
  const overlay = document.querySelector('.html-overlay');
  const badge = overlay?.querySelector('img');
  return getComputedStyle(overlay).pointerEvents === 'none'
    && badge.complete && badge.naturalWidth > 0
    && overlay.getBoundingClientRect().width > 0;
})()`)
const assertions = {
  playbackStarted: playing.currentTime >= 2 && playing.fps > 0,
  nativeSurfaceBackend: playing.backend.includes('surface-view'),
  ...(!skipTracks ? {
    audioTrackSelected: audio.tracks.filter((track) => track.kind === 'audio')[1]?.selected === true,
    subtitleTrackSelected: subtitle.tracks.some((track) => track.kind === 'subtitle' && track.selected),
  } : {}),
  seekWorked: seek.currentTime >= 13,
  volumeWorked: Math.abs(volume.volume - 0.35) < 0.01,
  overlayVisible,
  zeroDroppedFrames: seek.droppedVideoFrames === 0,
  scrollMovedPlayerWithHtml: scrollProbe.before - scrollProbe.after > 100,
  ...(!platform.includes('tv') ? {
    fullscreenSurfaceAndControls: fullscreen.fullscreenActive,
  } : {}),
  ...(platform.includes('tv') ? {
    zoomControlWorks: zoom.zoomValue === '1.1',
    fullscreenControlRemoved: zoom.fullscreenPresent === false,
    dpadMovedFocus: Boolean(dpad.focused),
    dpadDidNotSeek: Math.abs(dpad.currentTime - volume.currentTime) < 2,
  } : {}),
}
const report = {
  platform,
  serial,
  source,
  passed: Object.values(assertions).every(Boolean),
  assertions,
  samples: { playing, beforeAudio, audio, subtitle, seek, volume, zoom, dpad, fullscreen, scrollProbe },
}
writeFileSync(join(logDirectory, `${platform}-native-controls.json`), `${JSON.stringify(report, null, 2)}\n`)
const gfxInfo = execFileSync(adb, [
  '-s', serial, 'shell', 'dumpsys', 'gfxinfo', 'io.github.taurivideo.signalbench', 'framestats',
])
writeFileSync(join(logDirectory, `${platform}-native-controls-gfxinfo.txt`), gfxInfo)
process.stdout.write(`${JSON.stringify({ report: report.passed, assertions })}\n`)
runtime.close()
if (!report.passed) process.exitCode = 1
