import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  cleanup: vi.fn(),
  client: { attach: vi.fn() },
  createTauriVideoClient: vi.fn(),
  installFrameworkVideoDriver: vi.fn(),
}))

vi.mock('@get-air/video/framework', () => ({
  installFrameworkVideoDriver: mocks.installFrameworkVideoDriver,
}))

vi.mock('./index', () => ({
  createTauriVideoClient: mocks.createTauriVideoClient,
}))

import { installTauriFrameworkVideo } from './framework'

describe('installTauriFrameworkVideo', () => {
  beforeEach(() => {
    mocks.createTauriVideoClient.mockReset().mockReturnValue(mocks.client)
    mocks.installFrameworkVideoDriver.mockReset().mockReturnValue(mocks.cleanup)
    mocks.cleanup.mockReset()
  })

  it('installs a Tauri client as the literal framework video driver', () => {
    const options = { playback: { engine: 'gstreamer' as const } }

    const cleanup = installTauriFrameworkVideo(options)

    expect(mocks.createTauriVideoClient).toHaveBeenCalledOnce()
    expect(mocks.createTauriVideoClient).toHaveBeenCalledWith(options)
    expect(mocks.installFrameworkVideoDriver).toHaveBeenCalledOnce()
    expect(mocks.installFrameworkVideoDriver).toHaveBeenCalledWith({
      client: mocks.client,
      backend: 'tauri',
    })
    expect(cleanup).toBe(mocks.cleanup)
  })
})
