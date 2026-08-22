// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  VIDEO_PLAYER_ERROR_MARKER,
  type BackendVideoController,
  type VideoPluginError,
} from '@get-air/video'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
  Channel: class MockChannel<T> {
    onmessage: (message: T) => void = () => undefined
  },
}))

import {
  attachTauriBackend,
  getTauriVideoDiagnostics,
  TAURI_VIDEO_PACKAGE_NAME,
  TAURI_VIDEO_PACKAGE_VERSION,
  TAURI_VIDEO_PROTOCOL_VERSION,
} from './index'
import {
  sameNativeSurfacePosition,
  snapNativeSurfaceLayout,
  visibleSurfaceBounds,
} from './native-surface-layout'
import { clearVerifiedTauriVideoProtocolForTesting } from './protocol'

interface TestSnapshot {
  durationSeconds: number
  currentTimeSeconds: number
  bufferedSeconds: number
  playing: boolean
  videoWidth: number
  videoHeight: number
  hardwareBackend: string
  tracks: Array<{
    id: string
    index: number
    kind: 'video' | 'audio' | 'subtitle'
    language: string
    label: string
    codec: string
    selected: boolean
  }>
}

const controllers = new Set<BackendVideoController>()
let snapshot: TestSnapshot

function commandName(command: unknown): string {
  return String(command).replace('plugin:video|', '')
}

function nativeActions(): string[] {
  return mocks.invoke.mock.calls
    .filter(([command]) => commandName(command) === 'native_control')
    .map(([, options]) => String((options as { payload: { action: string } }).payload.action))
}

async function attach(
  options: Parameters<typeof attachTauriBackend>[1] = { source: 'movie.mkv' },
): Promise<BackendVideoController> {
  const element = document.createElement('video')
  document.body.append(element)
  const controller = await attachTauriBackend(element, {
    suspendWhenHidden: false,
    surfaceMode: 'transparent-canvas',
    ...options,
  })
  controllers.add(controller)
  return controller
}

beforeEach(() => {
  clearVerifiedTauriVideoProtocolForTesting()
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0')
  const gl = {
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88E4,
    FLOAT: 0x1406,
    TEXTURE_2D: 0x0DE1,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    CLAMP_TO_EDGE: 0x812F,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    LINEAR: 0x2601,
    VERTEX_SHADER: 0x8B31,
    FRAGMENT_SHADER: 0x8B30,
    COMPILE_STATUS: 0x8B81,
    LINK_STATUS: 0x8B82,
    createShader: vi.fn(() => ({})),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ''),
    createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => ''),
    useProgram: vi.fn(),
    createBuffer: vi.fn(() => ({})),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    getAttribLocation: vi.fn(() => 0),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    createTexture: vi.fn(() => ({})),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
  } as unknown as WebGLRenderingContext
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(gl)
  snapshot = {
    durationSeconds: 120,
    currentTimeSeconds: 0,
    bufferedSeconds: 12,
    playing: false,
    videoWidth: 1920,
    videoHeight: 1080,
    hardwareBackend: 'gstreamer-d3d11-win32',
    tracks: [
      {
        id: 'video-0', index: 0, kind: 'video', language: '', label: '',
        codec: 'h264', selected: true,
      },
      {
        id: 'audio-1', index: 1, kind: 'audio', language: 'en', label: 'English',
        codec: 'aac', selected: true,
      },
      {
        id: 'subtitle-2', index: 2, kind: 'subtitle', language: 'en', label: 'English',
        codec: 'webvtt', selected: true,
      },
    ],
  }
  mocks.invoke.mockReset()
  mocks.invoke.mockImplementation(async (command: unknown) => {
    if (commandName(command) === 'native_diagnostics') {
      return {
        protocolVersion: TAURI_VIDEO_PROTOCOL_VERSION,
        crateName: 'tauri-plugin-video',
        crateVersion: '0.1.0',
      }
    }
    if (commandName(command) === 'native_open'
      || commandName(command) === 'native_control'
      || commandName(command) === 'native_stats') {
      return structuredClone(snapshot)
    }
    return undefined
  })
})

afterEach(async () => {
  await Promise.all([...controllers].map((controller) => controller.destroy()))
  controllers.clear()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('native controller contract', () => {
  it('keeps package diagnostics aligned with package.json', () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { name: string; version: string }

    expect(TAURI_VIDEO_PACKAGE_NAME).toBe(manifest.name)
    expect(TAURI_VIDEO_PACKAGE_VERSION).toBe(manifest.version)
  })

  it('reports diagnostics, verifies before native_open, and caches a successful check', async () => {
    await expect(getTauriVideoDiagnostics()).resolves.toEqual({
      protocolVersion: TAURI_VIDEO_PROTOCOL_VERSION,
      packageName: TAURI_VIDEO_PACKAGE_NAME,
      packageVersion: TAURI_VIDEO_PACKAGE_VERSION,
      crateName: 'tauri-plugin-video',
      crateVersion: '0.1.0',
    })
    mocks.invoke.mockClear()

    await attach()
    await attach()

    expect(mocks.invoke.mock.calls.map(([command]) => commandName(command)))
      .toEqual([
        'native_diagnostics',
        'native_open',
        'native_open',
      ])
    const open = mocks.invoke.mock.calls.find(([command]) => commandName(command) === 'native_open')
    expect((open?.[1] as { payload?: unknown })?.payload).toMatchObject({
      protocolVersion: TAURI_VIDEO_PROTOCOL_VERSION,
      packageVersion: TAURI_VIDEO_PACKAGE_VERSION,
    })
  })

  it('sends the Windows video aperture and HTML overlay rectangles to native code', async () => {
    const element = document.createElement('video')
    const controls = document.createElement('div')
    document.body.append(element, controls)
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
      left: 40,
      top: 60,
      right: 680,
      bottom: 420,
      width: 640,
      height: 360,
      x: 40,
      y: 60,
      toJSON: () => ({}),
    })
    vi.spyOn(controls, 'getBoundingClientRect').mockReturnValue({
      left: 40,
      top: 360,
      right: 680,
      bottom: 420,
      width: 640,
      height: 60,
      x: 40,
      y: 360,
      toJSON: () => ({}),
    })

    const controller = await attachTauriBackend(element, {
      source: 'movie.mkv',
      suspendWhenHidden: false,
      surfaceMode: 'transparent-canvas',
      controlRegions: [controls],
    })
    controllers.add(controller)

    const open = mocks.invoke.mock.calls.find(([command]) => commandName(command) === 'native_open')
    expect((open?.[1] as { payload?: Record<string, unknown> })?.payload)
      .not.toHaveProperty('surfaceAperture')
  })

  it('rejects a different native protocol before opening a player', async () => {
    mocks.invoke.mockImplementation(async (command: unknown) => {
      if (commandName(command) === 'native_diagnostics') {
        return {
          protocolVersion: TAURI_VIDEO_PROTOCOL_VERSION + 1,
          crateName: 'tauri-plugin-video',
          crateVersion: '0.2.0',
        }
      }
      throw new Error(`unexpected command: ${commandName(command)}`)
    })

    await expect(attach()).rejects.toMatchObject({
      _tag: 'VideoNativeProtocolMismatchError',
      expectedProtocolVersion: TAURI_VIDEO_PROTOCOL_VERSION,
      actualProtocolVersion: TAURI_VIDEO_PROTOCOL_VERSION + 1,
      packageName: TAURI_VIDEO_PACKAGE_NAME,
      packageVersion: TAURI_VIDEO_PACKAGE_VERSION,
      crateName: 'tauri-plugin-video',
      crateVersion: '0.2.0',
    })
    expect(mocks.invoke.mock.calls.map(([command]) => commandName(command)))
      .toEqual(['native_diagnostics'])
  })

  it('reports a missing diagnostics command as a typed protocol mismatch', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('Command native_diagnostics not found'))

    const failure = await attach().then(
      () => undefined,
      (error: unknown) => error as {
        _tag: string
        expectedProtocolVersion: number
        actualProtocolVersion?: number
        packageName: string
        packageVersion: string
        cause?: string
      },
    )
    expect(failure).toMatchObject({
      _tag: 'VideoNativeProtocolMismatchError',
      expectedProtocolVersion: TAURI_VIDEO_PROTOCOL_VERSION,
      packageName: TAURI_VIDEO_PACKAGE_NAME,
      packageVersion: TAURI_VIDEO_PACKAGE_VERSION,
    })
    expect(failure?.actualProtocolVersion).toBeUndefined()
    expect(failure?.cause).toBe('Command native_diagnostics not found')
    expect((failure as Record<PropertyKey, unknown> | undefined)?.[VIDEO_PLAYER_ERROR_MARKER])
      .toBe(true)
    expect(mocks.invoke.mock.calls.map(([command]) => commandName(command)))
      .toEqual(['native_diagnostics'])

    mocks.invoke.mockImplementation(async (command: unknown) => {
      if (commandName(command) === 'native_diagnostics') {
        return {
          protocolVersion: TAURI_VIDEO_PROTOCOL_VERSION,
          crateName: 'tauri-plugin-video',
          crateVersion: '0.1.0',
        }
      }
      if (commandName(command) === 'native_open') return structuredClone(snapshot)
      return undefined
    })
    await expect(attach()).resolves.toMatchObject({ sessionId: expect.any(String) })
  })

  it('exposes stable, unique, platform-correct session IDs', async () => {
    const first = await attach()
    const second = await attach()

    expect(first.sessionId).toMatch(/^windows-native-surface-/)
    expect(second.sessionId).toMatch(/^windows-native-surface-/)
    expect(second.sessionId).not.toBe(first.sessionId)
    expect((await first.stats()).sessionId).toBe(first.sessionId)
  })

  it('rejects unknown or non-disableable tracks without changing local or native state', async () => {
    const controller = await attach()
    const originalTracks = controller.tracks.map((track) => ({ ...track }))
    mocks.invoke.mockClear()

    await expect(controller.selectTrack('subtitle', 'missing')).rejects.toThrow(
      'Unknown subtitle track: missing',
    )
    await expect(controller.selectTrack('audio', 'missing')).rejects.toThrow(
      'Unknown audio track: missing',
    )
    await expect(controller.selectTrack('audio')).rejects.toMatchObject({
      _tag: 'VideoFeatureUnavailableError',
      feature: 'audioTrackDisable',
    })

    mocks.invoke.mockImplementation(async (command: unknown, options?: unknown) => {
      if (commandName(command) === 'native_control'
        && (options as { payload?: { action?: string } })?.payload?.action === 'track') {
        throw new Error('native track selection failed')
      }
      return structuredClone(snapshot)
    })
    await expect(controller.selectTrack('audio', 'audio-1'))
      .rejects.toThrow('native track selection failed')

    expect(controller.tracks).toEqual(originalTracks)
    expect(nativeActions()).toEqual(['track'])
  })

  it('publishes detached IPC failures and removes its abort listener on destroy', async () => {
    const abortController = new AbortController()
    const add = vi.spyOn(abortController.signal, 'addEventListener')
    const remove = vi.spyOn(abortController.signal, 'removeEventListener')
    const controller = await attach({ source: 'movie.mkv', signal: abortController.signal })
    const abortHandler = add.mock.calls.find(([type]) => type === 'abort')?.[1]
    let failingAction = 'pause'
    mocks.invoke.mockImplementation(async (command: unknown, options?: unknown) => {
      if (commandName(command) === 'native_control'
        && (options as { payload?: { action?: string } })?.payload?.action === failingAction) {
        throw new Error(`${failingAction} IPC failed`)
      }
      if (commandName(command) === 'native_open' || commandName(command) === 'native_stats') {
        return structuredClone(snapshot)
      }
      return undefined
    })
    const error = new Promise<VideoPluginError>((resolve) => {
      controller.addEventListener('error', (event) => {
        resolve((event as CustomEvent<VideoPluginError>).detail)
      }, { once: true })
    })

    controller.pause()
    await expect(error).resolves.toMatchObject({ code: 'transport', message: 'pause IPC failed' })

    failingAction = 'seek'
    const facadeError = new Promise<VideoPluginError>((resolve) => {
      controller.addEventListener('error', (event) => {
        resolve((event as CustomEvent<VideoPluginError>).detail)
      }, { once: true })
    })
    controller.element.currentTime = 5
    await expect(facadeError).resolves.toMatchObject({ code: 'transport', message: 'seek IPC failed' })

    await controller.destroy()
    controllers.delete(controller)

    expect(abortHandler).toBeTypeOf('function')
    expect(remove).toHaveBeenCalledWith('abort', abortHandler)
  })

  it('exposes complete Windows DirectComposition geometry without JS frame copies', async () => {
    const controller = await attach()
    expect(controller.capabilities).toMatchObject({ videoFit: true, videoZoom: true })
    mocks.invoke.mockClear()

    await controller.setVideoFit('stretch')
    await controller.setVideoFit('cover')
    await controller.setVideoZoom(1.25)

    expect(nativeActions()).toEqual(['stretch', 'crop', 'zoom'])
    await expect(controller.stats()).resolves.toMatchObject({ decodedFrameCopies: 0 })
  })

  it('preserves complete fit and zoom support for Linux mpv', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Linux x86_64')
    snapshot.hardwareBackend = 'mpv:vaapi:h264:gtk-glarea'
    const controller = await attach({ source: 'movie.mkv', nativeBackend: 'mpv' })
    expect(controller.capabilities).toMatchObject({ videoFit: true, videoZoom: true })
    mocks.invoke.mockClear()

    await controller.setVideoFit('cover')
    await controller.setVideoZoom(1.5)

    expect(nativeActions()).toEqual(['crop', 'zoom'])
  })
})

describe('native surface geometry', () => {
  it('uses the same integer logical pixels as the Linux GTK host', () => {
    const layout = snapNativeSurfaceLayout(
      { left: 10.49, top: 20.51, width: 500.5, height: 300.49 },
      false,
      1,
    )
    expect(layout).toEqual({ x: 10, y: 21, width: 501, height: 300 })
    expect(visibleSurfaceBounds(layout, 1, { width: 1200, height: 800 }))
      .toEqual({ left: 10, top: 21, right: 511, bottom: 321 })
  })

  it('converts Android physical-pixel edges back to an exact CSS aperture', () => {
    const scale = 2.625
    const layout = snapNativeSurfaceLayout(
      { left: 7.8, top: 11.4, width: 320.6, height: 180.4 },
      true,
      scale,
    )
    const bounds = visibleSurfaceBounds(layout, scale, { width: 400, height: 300 })
    expect(layout).toEqual({ x: 20, y: 29, width: 841, height: 473 })
    expect(bounds.right - bounds.left).toBe(layout.width / scale)
    expect(bounds.bottom - bounds.top).toBe(layout.height / scale)
  })

  it('clamps a partially offscreen surface without exposing the viewport', () => {
    expect(visibleSurfaceBounds(
      { x: -24, y: -10, width: 300, height: 200 },
      1,
      { width: 240, height: 180 },
    )).toEqual({ left: 0, top: 0, right: 240, bottom: 180 })
  })

  it('treats Android root scrolling as the same document-space layout', () => {
    const before = { x: 20, y: 600, width: 900, height: 500, scrollX: 0, scrollY: 0 }
    const after = { x: 20, y: 180, width: 900, height: 500, scrollX: 0, scrollY: 420 }
    expect(sameNativeSurfacePosition(after, before, true)).toBe(true)
    expect(sameNativeSurfacePosition(after, before, false)).toBe(false)
  })

  it('still sends Android layout changes caused by nested scrollers', () => {
    const before = { x: 20, y: 600, width: 900, height: 500, scrollX: 0, scrollY: 0 }
    const nestedScroll = { x: 20, y: 180, width: 900, height: 500, scrollX: 0, scrollY: 0 }
    expect(sameNativeSurfacePosition(nestedScroll, before, true)).toBe(false)
  })

  it('treats Windows overlay movement as a native surface-region change', () => {
    const before = {
      x: 20,
      y: 40,
      width: 900,
      height: 500,
      scrollX: 0,
      scrollY: 0,
      surfaceAperture: { left: 20, top: 40, width: 900, height: 500 },
      surfaceOverlays: [{ left: 20, top: 480, width: 900, height: 60 }],
    }
    const after = {
      ...before,
      surfaceOverlays: [{ left: 20, top: 460, width: 900, height: 80 }],
    }
    expect(sameNativeSurfacePosition(after, before, false)).toBe(false)
  })
})
