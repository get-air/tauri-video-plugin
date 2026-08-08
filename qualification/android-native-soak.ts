#!/usr/bin/env -S npx tsx

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ChromeRuntime, commandOptions, delay } from './chrome-devtools'

interface QualitySample {
  measuredFps: number
  totalVideoFrames: number
  droppedVideoFrames: number
}

interface PlaybackSnapshot {
  currentTime: number
  bufferedAhead: number
  quality: QualitySample
}

interface PlaybackStats { playing: boolean; encodedBytesBuffered: number }
interface BrowserSample { snapshot: PlaybackSnapshot; stats: PlaybackStats; error: string }
interface MemorySample { pssKiB: number; rssKiB: number; nativeHeapKiB: number }
interface SoakSample extends BrowserSample { elapsedSeconds: number; memory: MemorySample }

interface SoakAssertions {
  timelineAdvanced: boolean
  sourceCadenceHeld: boolean
  zeroDroppedFrames: boolean
  encodedBufferBounded: boolean
  processMemoryBounded: boolean
  noPlaybackError: boolean
}

const options = commandOptions()
const adb = options.adb ?? 'adb'
const serial = options.serial ?? 'emulator-5554'
const platform = options.platform ?? 'android-native'
const source = options.source ?? 'https://10.0.2.2:9443/h264-aac-long-30.mkv'
const seconds = Number(options.seconds ?? 30)
const expectedFps = Number(options['expected-fps'] ?? 30)
const minimumFps = Number(options['minimum-fps'] ?? Math.max(1, expectedFps - 8))
const alreadyLoaded = options['already-loaded'] === '1'
const artifactRoot = options.artifacts ?? 'qualification/artifacts'
const outputDirectory = join(artifactRoot, platform)
const logDirectory = join(artifactRoot, 'logs')
mkdirSync(outputDirectory, { recursive: true })
mkdirSync(logDirectory, { recursive: true })

const runtime = await ChromeRuntime.connect()
const evaluate = <T>(expression: string): Promise<T> => runtime.evaluate<T>(expression, true)
const packageName = 'io.github.taurivideo.signalbench'
const pid = execFileSync(adb, ['-s', serial, 'shell', 'pidof', packageName], { encoding: 'utf8' }).trim()

function sourceLabel(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}/…/${url.pathname.split('/').filter(Boolean).at(-1) ?? 'media'}`
  } catch {
    return 'local-media'
  }
}

function memory(): MemorySample {
  const value = execFileSync(adb, ['-s', serial, 'shell', 'dumpsys', 'meminfo', packageName], { encoding: 'utf8' })
  const total = value.match(/TOTAL PSS:\s+(\d+).*TOTAL RSS:\s+(\d+)/)
  const native = value.match(/^\s*Native Heap\s+(\d+)/m)
  return {
    pssKiB: Number(total?.[1] ?? 0),
    rssKiB: Number(total?.[2] ?? 0),
    nativeHeapKiB: Number(native?.[1] ?? 0),
  }
}

function screenshot(name: string): void {
  const image = execFileSync(adb, ['-s', serial, 'exec-out', 'screencap', '-p'])
  writeFileSync(join(outputDirectory, `soak-${name}.png`), image)
}

async function browserSample(): Promise<BrowserSample | null> {
  return evaluate<BrowserSample | null>(`(async () => {
    const bridge = window.__TAURI_VIDEO_TEST__;
    if (!bridge?.controller) return null;
    const snapshot = bridge.snapshot();
    const stats = await bridge.controller.stats();
    return { snapshot, stats, error: document.querySelector('.tvp-error')?.textContent?.trim() ?? '' };
  })()`)
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

let ready: BrowserSample | null | undefined
for (let attempt = 0; attempt < 90; attempt += 1) {
  await delay(500)
  ready = await browserSample()
  if (ready?.error) throw new Error(ready.error)
  if (ready && ready.snapshot.currentTime >= 1 && ready.stats.playing) break
}
if (!ready || ready.snapshot.currentTime < 1) throw new Error('Long-stream playback did not start')

const samples: SoakSample[] = []
screenshot('00-start')
for (let second = 1; second <= seconds; second += 1) {
  await delay(1_000)
  const browser = await browserSample()
  if (!browser) throw new Error('Qualification bridge disappeared during soak')
  const sample = { elapsedSeconds: second, ...browser, memory: memory() }
  samples.push(sample)
  process.stdout.write(`${JSON.stringify({
    second,
    position: browser.snapshot.currentTime,
    fps: browser.snapshot.quality.measuredFps,
    dropped: browser.snapshot.quality.droppedVideoFrames,
    buffer: browser.snapshot.bufferedAhead,
    encodedMiB: browser.stats.encodedBytesBuffered / 1024 / 1024,
    pssMiB: sample.memory.pssKiB / 1024,
  })}\n`)
  if (second === Math.ceil(seconds / 2)) screenshot('01-mid')
}
screenshot('02-end')

const stable = samples.slice(Math.min(2, samples.length))
const fps = stable.map((sample) => sample.snapshot.quality.measuredFps)
const report: {
  platform: string
  serial: string
  pid: string
  source: string
  seconds: number
  passed: boolean
  summary: {
    startPosition: number
    endPosition: number
    averageFps: number
    minimumFps: number
    droppedFrames: number
    maximumPssMiB: number
    maximumEncodedMiB: number
    minimumBufferSeconds: number
  }
  samples: SoakSample[]
  assertions?: SoakAssertions
} = {
  platform,
  serial,
  pid,
  source: sourceLabel(source),
  seconds,
  passed: false,
  summary: {
    startPosition: samples[0]?.snapshot.currentTime ?? 0,
    endPosition: samples.at(-1)?.snapshot.currentTime ?? 0,
    averageFps: fps.reduce((sum, value) => sum + value, 0) / Math.max(1, fps.length),
    minimumFps: Math.min(...fps),
    droppedFrames: samples.at(-1)?.snapshot.quality.droppedVideoFrames ?? 0,
    maximumPssMiB: Math.max(...samples.map((sample) => sample.memory.pssKiB / 1024)),
    maximumEncodedMiB: Math.max(...samples.map((sample) => sample.stats.encodedBytesBuffered / 1024 / 1024)),
    minimumBufferSeconds: Math.min(...stable.map((sample) => sample.snapshot.bufferedAhead)),
  },
  samples,
}
report.assertions = {
  timelineAdvanced: report.summary.endPosition - report.summary.startPosition >= seconds - 2,
  sourceCadenceHeld: report.summary.averageFps >= expectedFps - 2
    && report.summary.minimumFps >= minimumFps,
  zeroDroppedFrames: report.summary.droppedFrames === 0,
  encodedBufferBounded: report.summary.maximumEncodedMiB <= 96,
  processMemoryBounded: report.summary.maximumPssMiB <= 400,
  noPlaybackError: samples.every((sample) => !sample.error),
}
report.passed = Object.values(report.assertions).every(Boolean)
writeFileSync(join(logDirectory, `${platform}-native-soak.json`), `${JSON.stringify(report, null, 2)}\n`)
const gfxInfo = execFileSync(adb, [
  '-s', serial, 'shell', 'dumpsys', 'gfxinfo', packageName, 'framestats',
])
writeFileSync(join(logDirectory, `${platform}-native-soak-gfxinfo.txt`), gfxInfo)
process.stdout.write(`${JSON.stringify({ passed: report.passed, summary: report.summary, assertions: report.assertions })}\n`)
runtime.close()
if (!report.passed) process.exitCode = 1
