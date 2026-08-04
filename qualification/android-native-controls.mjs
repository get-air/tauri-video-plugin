#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const options = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const [key, ...value] = argument.replace(/^--/, '').split('=')
  return [key, value.join('=')]
}))
const adb = options.adb ?? 'adb'
const serial = options.serial ?? 'emulator-5554'
const platform = options.platform ?? 'android-phone-native'
const source = options.source ?? 'https://10.0.2.2:9443/h264-multitrack-subtitles-30.mkv'
const alreadyLoaded = options['already-loaded'] === '1'
const artifactRoot = options.artifacts ?? 'qualification/artifacts'
const outputDirectory = join(artifactRoot, platform)
const logDirectory = join(artifactRoot, 'logs')
mkdirSync(outputDirectory, { recursive: true })
mkdirSync(logDirectory, { recursive: true })

const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
if (!targets[0]?.webSocketDebuggerUrl) throw new Error('Android WebView DevTools target is unavailable')
const socket = new WebSocket(targets[0].webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = reject
})
let nextId = 0
const pending = new Map()
socket.onmessage = (event) => {
  const message = JSON.parse(event.data)
  pending.get(message.id)?.(message)
  pending.delete(message.id)
}

function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, (message) => {
      if (message.result.exceptionDetails) reject(new Error(message.result.exceptionDetails.text))
      else resolve(message.result.result.value)
    })
    socket.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    }))
  })
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function sample(label) {
  const result = await evaluate(`(async () => {
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
      error: document.querySelector('.tvp-error')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
      fps: snapshot?.quality?.measuredFps ?? 0,
      totalVideoFrames: snapshot?.quality?.totalVideoFrames ?? 0,
      droppedVideoFrames: snapshot?.quality?.droppedVideoFrames ?? 0,
      bufferedAhead: snapshot?.bufferedAhead ?? 0,
      tracks: snapshot?.tracks ?? [],
      focused: document.activeElement?.getAttribute('aria-label')
        ?? document.activeElement?.textContent?.replace(/\\s+/g, ' ').trim()
        ?? '',
      zoomLabel: document.querySelector('[aria-label^="Video zoom"]')?.getAttribute('aria-label') ?? '',
      fullscreenPresent: Boolean(document.querySelector('[aria-label="Fullscreen"]')),
    };
  })()`)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return result
}

async function waitFor(predicate, timeoutMs = 40_000) {
  const started = Date.now()
  let value
  while (Date.now() - started < timeoutMs) {
    await delay(500)
    value = await sample('poll')
    if (predicate(value)) return value
    if (value.error) throw new Error(value.error)
  }
  throw new Error(`Timed out after ${timeoutMs}ms; last sample: ${JSON.stringify(value)}`)
}

function screenshot(name) {
  const image = execFileSync(adb, ['-s', serial, 'exec-out', 'screencap', '-p'])
  writeFileSync(join(outputDirectory, `controls-${name}.png`), image)
}

if (!alreadyLoaded) {
  await evaluate(`(() => {
    const bridge = window.__TAURI_VIDEO_TEST__;
    if (bridge?.loadSource) { bridge.loadSource(${JSON.stringify(source)}); return true; }
    const input = document.querySelector('#source-url');
    if (!input) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(source)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.load-button')?.click();
    return true;
  })()`)
}
const playing = await waitFor((value) => value.currentTime >= 2 && !value.paused)
screenshot('01-playing-overlay')

const beforeAudio = await sample('before-audio')
await evaluate(`(() => {
  const bridge = window.__TAURI_VIDEO_TEST__;
  const tracks = bridge.snapshot().tracks.filter(track => track.kind === 'audio');
  return bridge.selectTrack('audio', tracks[1].id);
})()`)
const audio = await waitFor((value) => (
  value.tracks.filter((track) => track.kind === 'audio')[1]?.selected
  && value.currentTime >= beforeAudio.currentTime - 1
))
screenshot('02-audio-track')

await evaluate(`(() => {
  const bridge = window.__TAURI_VIDEO_TEST__;
  const track = bridge.snapshot().tracks.find(track => track.kind === 'subtitle');
  return bridge.selectTrack('subtitle', track.id);
})()`)
const subtitle = await waitFor((value) => (
  value.tracks.some((track) => track.kind === 'subtitle' && track.selected)
))
await delay(1_000)
screenshot('03-subtitle-overlay')

await evaluate(`window.__TAURI_VIDEO_TEST__.seek(13)`)
const seek = await waitFor((value) => value.currentTime >= 13)
screenshot('04-seek')

await evaluate(`(() => {
  const input = document.querySelector('.tvp-volume');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '0.35');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`)
const volume = await waitFor((value) => Math.abs(value.volume - 0.35) < 0.01)
screenshot('05-volume')

let zoom = { zoomLabel: '', fullscreenPresent: true }
if (platform.includes('tv')) {
  await evaluate(`document.querySelector('[aria-label^="Video zoom"]')?.click()`)
  await delay(500)
  zoom = await sample('zoom')
  screenshot('06-zoom')
}

let dpad = { focused: '' }
if (platform.includes('tv')) {
  execFileSync(adb, ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_DPAD_RIGHT'])
  await delay(250)
  dpad = await sample('dpad-right')
  screenshot('07-dpad-focus')
}

const overlayVisible = await evaluate(`(() => {
  const overlay = document.querySelector('.video-overlay');
  const slot = document.querySelector('.tvp-overlay-slot');
  return getComputedStyle(slot).pointerEvents === 'none'
    && overlay.complete && overlay.naturalWidth > 0
    && overlay.getBoundingClientRect().width > 0;
})()`)
const assertions = {
  playbackStarted: playing.currentTime >= 2 && playing.fps > 0,
  nativeSurfaceBackend: playing.backend.includes('surface-view'),
  audioTrackSelected: audio.tracks.filter((track) => track.kind === 'audio')[1]?.selected === true,
  subtitleTrackSelected: subtitle.tracks.some((track) => track.kind === 'subtitle' && track.selected),
  seekWorked: seek.currentTime >= 13,
  volumeWorked: Math.abs(volume.volume - 0.35) < 0.01,
  overlayVisible,
  zeroDroppedFrames: seek.droppedVideoFrames === 0,
  ...(platform.includes('tv') ? {
    zoomControlWorks: zoom.zoomLabel.includes('1.1'),
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
  samples: { playing, beforeAudio, audio, subtitle, seek, volume, zoom, dpad },
}
writeFileSync(join(logDirectory, `${platform}-native-controls.json`), `${JSON.stringify(report, null, 2)}\n`)
const gfxInfo = execFileSync(adb, [
  '-s', serial, 'shell', 'dumpsys', 'gfxinfo', 'io.github.taurivideo.signalbench', 'framestats',
])
writeFileSync(join(logDirectory, `${platform}-native-controls-gfxinfo.txt`), gfxInfo)
process.stdout.write(`${JSON.stringify({ report: report.passed, assertions })}\n`)
socket.close()
if (!report.passed) process.exitCode = 1
