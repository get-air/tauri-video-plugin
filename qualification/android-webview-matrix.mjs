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
const baseUrl = options.base ?? 'https://10.0.2.2:9443'
const artifactRoot = options.artifacts ?? 'qualification/artifacts'
const platform = options.platform ?? 'android-phone'
const timeoutMs = Number(options.timeout ?? 35_000)

const allCases = [
  ['h264-aac-30', 'h264-aac-30.mkv'],
  ['h264-aac-60', 'h264-aac-60.mkv'],
  ['vp8-vorbis', 'vp8-vorbis.webm'],
  ['vp9-opus', 'vp9-opus.webm'],
  ['hevc-ac3', 'hevc-ac3.mkv'],
  ['mpeg4-mp3', 'mpeg4-mp3.avi'],
  ['h264-aac-ts', 'h264-aac.ts'],
  ['av1-opus', 'av1-opus.mkv'],
  ['av1-opus-320', 'av1-opus-320.mkv'],
  ['h264-flac', 'h264-flac.mkv'],
  ['multitrack-subtitles', 'h264-multitrack-subtitles.mkv'],
  ['hevc-main10-eac3', 'hevc-main10-eac3.mkv'],
  ['hevc-main10-eac3-30', 'hevc-main10-eac3-30.mkv'],
  ['hevc-main10-truehd', 'hevc-main10-truehd.mkv'],
  ['h264-dts', 'h264-dts.mkv'],
  ['h264-opus', 'h264-opus.mkv'],
  ['mpeg2-ac3-ts', 'mpeg2-ac3.ts'],
  ['prores-pcm', 'prores-pcm.mov'],
  ['ffv1-flac', 'ffv1-flac.mkv'],
  ['mjpeg-pcm', 'mjpeg-pcm.avi'],
]
const requestedCases = new Set((options.cases ?? '').split(',').filter(Boolean))
const cases = requestedCases.size
  ? allCases.filter(([name]) => requestedCases.has(name))
  : allCases

if (cases.length === 0) throw new Error('No requested matrix cases matched')

mkdirSync(join(artifactRoot, platform), { recursive: true })
mkdirSync(join(artifactRoot, 'logs'), { recursive: true })

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
      if (message.result.exceptionDetails) {
        const details = message.result.exceptionDetails
        reject(new Error(details.exception?.description ?? details.text ?? JSON.stringify(details)))
      }
      else resolve(message.result.result.value)
    })
    socket.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }))
  })
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const results = []
const browserSample = `(async () => {
  const bridge = window.__TAURI_VIDEO_TEST__;
  if (!bridge?.controller) {
    return { currentTime: 0, duration: 0, paused: true, readyState: 0, state: 'opening', backend: '', error: '', fpsBadge: '', totalVideoFrames: 0, droppedVideoFrames: 0, buffered: [], trackOptions: [] };
  }
  const snapshot = bridge.snapshot();
  const stats = await bridge.controller.stats();
  const grouped = ['audio', 'subtitle', 'video'].map(kind =>
    snapshot.tracks.filter(track => track.kind === kind).map(track => track.label || track.language || track.id)
  ).filter(group => group.length);
  return {
    currentTime: snapshot.currentTime,
    duration: snapshot.duration,
    paused: !stats.playing,
    readyState: 4,
    state: stats.playing ? 'playing' : 'paused',
    backend: stats.hardwareBackend || '',
    error: document.querySelector('.tvp-error')?.textContent?.trim() || '',
    fpsBadge: snapshot.quality ? snapshot.quality.measuredFps.toFixed(2) : '',
    totalVideoFrames: snapshot.quality?.totalVideoFrames || 0,
    droppedVideoFrames: snapshot.quality?.droppedVideoFrames || 0,
    buffered: [[snapshot.currentTime, snapshot.currentTime + snapshot.bufferedAhead]],
    trackOptions: grouped,
  };
})()`

for (const [name, filename] of cases) {
  const url = `${baseUrl}/${filename}`
  await evaluate(`(() => {
    const bridge = window.__TAURI_VIDEO_TEST__;
    if (bridge?.loadSource) {
      bridge.loadSource(${JSON.stringify(url)});
      return true;
    }
    const input = document.querySelector('#source-url');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(url)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const button = document.querySelector('.source-form button[type="submit"]');
    if (!button) return false;
    button.click();
    return true;
  })()`)

  const started = Date.now()
  let sample
  while (Date.now() - started < timeoutMs) {
    await delay(1_000)
    sample = await evaluate(browserSample)
    if (sample.error || (sample.currentTime >= 1 && !sample.paused)) break
  }

  let passed = Boolean(sample && !sample.error && sample.currentTime >= 1
    && !sample.paused && sample.totalVideoFrames > 0)
  if (passed) {
    execFileSync(adb, ['-s', serial, 'shell', 'dumpsys', 'gfxinfo', 'io.github.taurivideo.signalbench', 'reset'])
    await delay(4_000)
    sample = await evaluate(browserSample)
    passed = Boolean(!sample.error && sample.currentTime >= 1 && sample.totalVideoFrames > 0)
  }

  const screenshot = execFileSync(adb, ['-s', serial, 'exec-out', 'screencap', '-p'])
  writeFileSync(join(artifactRoot, platform, `matrix-${name}.png`), screenshot)
  const gfxInfo = execFileSync(adb, [
    '-s', serial, 'shell', 'dumpsys', 'gfxinfo', 'io.github.taurivideo.signalbench', 'framestats',
  ])
  writeFileSync(join(artifactRoot, 'logs', `${platform}-matrix-${name}-gfxinfo.txt`), gfxInfo)
  const result = { name, url, passed, elapsedMs: Date.now() - started, ...sample }
  results.push(result)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

socket.close()
writeFileSync(
  join(artifactRoot, 'logs', `${platform}-matrix.json`),
  `${JSON.stringify(results, null, 2)}\n`,
)
if (results.some((result) => !result.passed)) process.exitCode = 1
