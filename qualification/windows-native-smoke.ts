#!/usr/bin/env -S npx tsx

import { ChromeRuntime, commandOptions, delay } from './chrome-devtools'

interface Sample {
  currentTime: number
  playing: boolean
  fps: number
  presentedFrames: number
  droppedFrames: number
  backend: string
  error: string
  video: { left: number; top: number; width: number; height: number }
  overlays: Array<{ left: number; top: number; width: number; height: number }>
}

const runtime = await ChromeRuntime.connect()
const options = commandOptions()

async function sample(): Promise<Sample> {
  return runtime.evaluate<Sample>(`(async () => {
    const bridge = window.__TAURI_VIDEO_TEST__;
    const snapshot = bridge?.snapshot();
    const stats = bridge?.controller ? await bridge.controller.stats() : null;
    const video = document.querySelector('video')?.getBoundingClientRect();
    const overlays = Array.from(document.querySelectorAll('[data-air-video-controls]'), element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    });
    return {
      currentTime: snapshot?.currentTime ?? 0,
      playing: snapshot?.playing ?? stats?.state === 'playing',
      fps: snapshot?.quality?.measuredFps ?? 0,
      presentedFrames: snapshot?.quality?.totalVideoFrames ?? 0,
      droppedFrames: snapshot?.quality?.droppedVideoFrames ?? 0,
      backend: stats?.hardwareBackend ?? '',
      error: document.querySelector('.player-error, .tvp-error')?.textContent?.trim() ?? '',
      video: video
        ? { left: video.left, top: video.top, width: video.width, height: video.height }
        : { left: 0, top: 0, width: 0, height: 0 },
      overlays,
    };
  })()`, true)
}

async function waitFor(predicate: (value: Sample) => boolean, timeoutMs = 60_000): Promise<Sample> {
  const started = Date.now()
  let value: Sample | undefined
  while (Date.now() - started < timeoutMs) {
    await delay(500)
    value = await sample()
    if (value.error) throw new Error(value.error)
    if (predicate(value)) return value
  }
  throw new Error(`Timed out waiting for native video: ${JSON.stringify(value)}`)
}

try {
  if (options.source) {
    await runtime.evaluate<void>(
      'void (window.__TAURI_VIDEO_PREVIOUS_CONTROLLER__ = window.__TAURI_VIDEO_TEST__?.controller)',
    )
    await runtime.evaluate<void>(`window.__TAURI_VIDEO_TEST__.loadSource(${JSON.stringify(options.source)})`, true)
    const started = Date.now()
    while (Date.now() - started < 60_000) {
      await delay(250)
      if (await runtime.evaluate<boolean>(`Boolean(
        window.__TAURI_VIDEO_TEST__?.controller
          && window.__TAURI_VIDEO_TEST__.controller !== window.__TAURI_VIDEO_PREVIOUS_CONTROLLER__
      )`)) break
    }
    if (!await runtime.evaluate<boolean>(`Boolean(
      window.__TAURI_VIDEO_TEST__?.controller
        && window.__TAURI_VIDEO_TEST__.controller !== window.__TAURI_VIDEO_PREVIOUS_CONTROLLER__
    )`)) {
      throw new Error('Timed out waiting for the replacement native video controller')
    }
    await runtime.evaluate<void>('delete window.__TAURI_VIDEO_PREVIOUS_CONTROLLER__')
  }
  await runtime.evaluate<void>('window.__TAURI_VIDEO_TEST__.play()', true)
  const playing = await waitFor((value) => (
    value.currentTime >= 2 && value.fps > 0 && value.presentedFrames > 0
  ))
  await runtime.evaluate<void>('window.__TAURI_VIDEO_TEST__.seek(10)', true)
  const seeked = await waitFor((value) => value.currentTime >= 10)
  await runtime.evaluate<void>('window.__TAURI_VIDEO_TEST__.pause()', true)
  const paused = await waitFor((value) => !value.playing)
  await runtime.evaluate<void>('window.__TAURI_VIDEO_TEST__.play()', true)
  const resumed = await waitFor((value) => value.playing && value.currentTime > paused.currentTime)
  process.stdout.write(`${JSON.stringify({ playing, seeked, paused, resumed }, null, 2)}\n`)
} finally {
  runtime.close()
}
