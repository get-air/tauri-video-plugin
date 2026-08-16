// @vitest-environment happy-dom

import type { BackendVideoController } from '@get-air/video'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  attachNativeBackend: vi.fn(),
}))

vi.mock('../guest-js/index', () => ({
  attachTauriBackend: mocks.attachNativeBackend,
}))

import { attachTauriBackend, tauriVideoBackend } from './index'

describe('tauriVideoBackend', () => {
  it('is available only inside a supported Tauri runtime', async () => {
    const adapter = tauriVideoBackend()
    const tauriGlobal = { __TAURI_INTERNALS__: {} } as unknown as typeof globalThis

    expect(adapter.id).toBe('tauri')
    expect(adapter.autoPriority).toBe(250)
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
})
