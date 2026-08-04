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
const platform = options.platform ?? 'android-phone'
const source = options.source ?? 'https://10.0.2.2:9443/h264-multitrack-subtitles-30.mkv'
const artifactRoot = options.artifacts ?? 'qualification/artifacts'
const outputDirectory = join(artifactRoot, platform)
const logDirectory = join(artifactRoot, 'logs')

mkdirSync(outputDirectory, { recursive: true })
mkdirSync(logDirectory, { recursive: true })

let nextId = 0
const pending = new Map()
let socket
async function connect() {
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
  if (!targets[0]?.webSocketDebuggerUrl) throw new Error('Android WebView DevTools target is unavailable')
  socket = new WebSocket(targets[0].webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    pending.get(message.id)?.(message)
    pending.delete(message.id)
  }
}
await connect()

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
  const result = await evaluate(`(() => {
    const video = document.querySelector('video');
    const quality = video.getVideoPlaybackQuality?.();
    const selects = [...document.querySelectorAll('.track-bank select')];
    return {
      label: ${JSON.stringify(label)},
      currentTime: video.currentTime,
      src: video.src,
      duration: video.duration,
      paused: video.paused,
      volume: video.volume,
      readyState: video.readyState,
      state: document.querySelector('.panel-title strong')?.textContent?.trim() ?? '',
      error: document.querySelector('.error-banner')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
      fpsBadge: document.querySelector('.fps-badge')?.textContent?.trim() ?? '',
      totalVideoFrames: quality?.totalVideoFrames ?? 0,
      droppedVideoFrames: quality?.droppedVideoFrames ?? 0,
      buffered: Array.from({ length: video.buffered.length }, (_, index) => [
        video.buffered.start(index), video.buffered.end(index),
      ]),
      tracks: selects.map(select => ({
        value: select.value,
        selected: select.selectedOptions[0]?.textContent?.trim() ?? '',
        options: [...select.options].map(option => option.textContent.trim()),
      })),
    };
  })()`)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return result
}

function screenshot(name) {
  const image = execFileSync(adb, ['-s', serial, 'exec-out', 'screencap', '-p'])
  writeFileSync(join(outputDirectory, `controls-${name}.png`), image)
}

async function pointFor(selector) {
  return evaluate(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return {
      x: Math.round((rect.left + rect.width / 2) * window.devicePixelRatio),
      y: Math.round((rect.top + rect.height / 2) * window.devicePixelRatio),
    };
  })()`)
}

async function tap(selector) {
  if (platform.includes('tv')) {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus(); true`)
    execFileSync(adb, ['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_DPAD_CENTER'])
    return
  }
  const point = await pointFor(selector)
  execFileSync(adb, ['-s', serial, 'shell', 'input', 'tap', String(point.x), String(point.y)])
}

async function waitFor(predicate, timeoutMs = 40_000) {
  const started = Date.now()
  let value
  while (Date.now() - started < timeoutMs) {
    await delay(1_000)
    value = await sample('poll')
    if (predicate(value)) return value
    if (value.error) throw new Error(value.error)
  }
  throw new Error(`Timed out after ${timeoutMs}ms; last sample: ${JSON.stringify(value)}`)
}

const phases = []
await evaluate(`(() => {
  const input = document.querySelector('#source-url');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(source)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('.load-button').click();
  return true;
})()`)
phases.push(await waitFor((value) => value.currentTime >= 2 && !value.paused))
screenshot('01-playing-overlay')

const beforeAudio = await sample('before-audio-switch')
await evaluate(`(() => {
  const select = document.querySelectorAll('.track-bank select')[0];
  select.value = select.options[1].value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return select.value;
})()`)
const afterAudio = await waitFor((value) => (
  value.tracks[0]?.selected.startsWith('ja')
  && value.src !== beforeAudio.src
  && value.currentTime >= beforeAudio.currentTime - 1
  && !value.paused
))
phases.push({ ...afterAudio, label: 'after-audio-switch' })
screenshot('02-audio-ja')

const beforeSubtitle = await sample('before-subtitle-switch')
await evaluate(`(() => {
  const select = document.querySelectorAll('.track-bank select')[1];
  select.value = select.options[1].value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return select.value;
})()`)
const afterSubtitle = await waitFor((value) => (
  value.tracks[1]?.selected !== 'Off'
  && value.src !== beforeSubtitle.src
  && value.currentTime >= beforeSubtitle.currentTime - 1
  && !value.paused
))
phases.push({ ...afterSubtitle, label: 'after-subtitle-switch' })
await delay(1_500)
screenshot('03-subtitle-en-overlay')

await evaluate(`(() => {
  const timeline = document.querySelector('.timeline');
  timeline.value = '13';
  timeline.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`)
const afterSeek = await waitFor((value) => value.currentTime >= 13 && !value.paused)
phases.push({ ...afterSeek, label: 'after-seek' })
screenshot('04-seek-13s')

await evaluate(`(() => {
  const volume = document.querySelector('.volume');
  volume.value = '0.35';
  volume.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`)
await delay(500)
const afterVolume = await sample('volume-35-percent')
phases.push(afterVolume)
screenshot('05-volume-35')

let paused
if (!platform.includes('tv')) {
  await tap('.round-button')
  paused = await waitFor((value) => value.paused, 10_000)
  phases.push(paused)
  screenshot('06-paused')
}

const assertions = {
  playbackStarted: phases[0].currentTime >= 2 && !phases[0].error,
  audioTrackChangedWithoutRestart: afterAudio.tracks[0]?.selected.startsWith('ja')
    && afterAudio.currentTime >= beforeAudio.currentTime - 1,
  subtitleTrackSelected: afterSubtitle.tracks[1]?.selected !== 'Off',
  seekRestoredTimeline: afterSeek.currentTime >= 13,
  volumeChanged: Math.abs(afterVolume.volume - 0.35) < 0.01,
  ...(paused ? { pauseWorked: paused.paused } : {}),
  overlayVisible: Boolean(await evaluate(`(() => {
    const overlay = document.querySelector('.video-overlay');
    const badge = document.querySelector('.overlay-badge');
    return getComputedStyle(overlay).pointerEvents === 'none'
      && badge.complete && badge.naturalWidth > 0
      && overlay.getBoundingClientRect().width > 0;
  })()`)),
}
const report = { platform, serial, source, passed: Object.values(assertions).every(Boolean), assertions, phases }
writeFileSync(join(logDirectory, `${platform}-controls.json`), `${JSON.stringify(report, null, 2)}\n`)
const gfxInfo = execFileSync(adb, [
  '-s', serial, 'shell', 'dumpsys', 'gfxinfo', 'io.github.taurivideo.signalbench', 'framestats',
])
writeFileSync(join(logDirectory, `${platform}-controls-gfxinfo.txt`), gfxInfo)
socket.close()
if (!report.passed) process.exitCode = 1
