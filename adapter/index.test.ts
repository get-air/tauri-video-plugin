// @vitest-environment happy-dom

import {
  markVideoPlayerError,
  VIDEO_PLAYER_ERROR_MARKER,
  type BackendVideoController,
} from '@get-air/video'
import type { VideoPlayerError } from '@get-air/video/effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  attachNativeBackend: vi.fn(),
}))

vi.mock('../guest-js/index', () => ({
  attachTauriBackend: mocks.attachNativeBackend,
}))

import { VideoNativeProtocolMismatchError } from '../guest-js/protocol-error'
import {
  attachTauriBackend,
  createTauriVideoClient,
  TAURI_VIDEO_PACKAGE_NAME,
  TAURI_VIDEO_PACKAGE_VERSION,
  TAURI_VIDEO_PROTOCOL_VERSION,
  tauriVideoBackend,
} from './index'

describe('tauriVideoBackend', () => {
  it('is available only inside a supported Tauri runtime', async () => {
    const adapter = tauriVideoBackend()
    const tauriGlobal = { __TAURI_INTERNALS__: {} } as unknown as typeof globalThis

    expect(adapter.id).toBe('tauri')
    expect(adapter.id).toBe('tauri')
    expect(await adapter.isAvailable({ userAgent: 'Windows', global: tauriGlobal })).toBe(true)
    expect(await adapter.isAvailable({ userAgent: 'Macintosh', global: tauriGlobal })).toBe(false)
    expect(await adapter.isAvailable({
      userAgent: 'Windows',
      global: {} as typeof globalThis,
    })).toBe(false)
  })
})

describe('attachTauriBackend', () => {
  beforeEach(() => {
    mocks.attachNativeBackend.mockReset()
    mocks.attachNativeBackend.mockResolvedValue({} as BackendVideoController)
  })

  it('maps adapter defaults and per-load options into native settings', async () => {
    const element = document.createElement('video')
    await attachTauriBackend(element, {
      source: 'movie.mkv',
      backendOptions: {
        tauri: {
          engine: 'gstreamer',
          linux: { buffer: { maxSeconds: 18 } },
        },
      },
    }, {
      engine: 'mpv',
      linux: { buffer: { minSeconds: 2, maxSeconds: 12 } },
      windows: { buffer: { maxSeconds: 10 } },
    })

    expect(mocks.attachNativeBackend).toHaveBeenCalledWith(element, expect.objectContaining({
      source: 'movie.mkv',
      backend: 'tauri',
      nativeBackend: 'gstreamer',
      platform: {
        android: undefined,
        androidTv: undefined,
        linux: { buffer: { minSeconds: 2, maxSeconds: 18 } },
        windows: { buffer: { maxSeconds: 10 } },
      },
    }))
  })

  it('preserves a typed native protocol mismatch through the public client', async () => {
    const mismatch = markVideoPlayerError(new VideoNativeProtocolMismatchError({
      expectedProtocolVersion: TAURI_VIDEO_PROTOCOL_VERSION,
      actualProtocolVersion: TAURI_VIDEO_PROTOCOL_VERSION + 1,
      packageName: TAURI_VIDEO_PACKAGE_NAME,
      packageVersion: TAURI_VIDEO_PACKAGE_VERSION,
      crateName: 'tauri-plugin-video',
      crateVersion: 'incompatible-test-version',
      message: 'native protocol mismatch',
    }))
    const registeredError: VideoPlayerError = mismatch
    expect(registeredError._tag).toBe('VideoNativeProtocolMismatchError')
    mocks.attachNativeBackend.mockRejectedValue(mismatch)
    Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    const userAgent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0')

    try {
      const attachment = createTauriVideoClient().attach(document.createElement('video'), {
        source: 'movie.mkv',
        backend: 'tauri',
      })
      const caught = await attachment.then(
        () => undefined,
        (error: unknown) => error,
      )
      expect({
        tag: (caught as { _tag?: unknown } | undefined)?._tag,
        message: (caught as { message?: unknown } | undefined)?.message,
        marked: (caught as Record<PropertyKey, unknown> | undefined)
          ?.[VIDEO_PLAYER_ERROR_MARKER],
        expectedProtocolVersion: (caught as { expectedProtocolVersion?: unknown } | undefined)
          ?.expectedProtocolVersion,
        actualProtocolVersion: (caught as { actualProtocolVersion?: unknown } | undefined)
          ?.actualProtocolVersion,
        packageVersion: (caught as { packageVersion?: unknown } | undefined)?.packageVersion,
        crateVersion: (caught as { crateVersion?: unknown } | undefined)?.crateVersion,
      }).toEqual({
        tag: 'VideoNativeProtocolMismatchError',
        message: 'native protocol mismatch',
        marked: true,
        expectedProtocolVersion: TAURI_VIDEO_PROTOCOL_VERSION,
        actualProtocolVersion: TAURI_VIDEO_PROTOCOL_VERSION + 1,
        packageVersion: TAURI_VIDEO_PACKAGE_VERSION,
        crateVersion: 'incompatible-test-version',
      })
    } finally {
      userAgent.mockRestore()
      Reflect.deleteProperty(globalThis, '__TAURI_INTERNALS__')
    }
  })
})
