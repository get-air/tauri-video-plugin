// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../guest-js/index', async (importOriginal) => {
  const original = await importOriginal<typeof import('../guest-js/index')>()
  return {
    ...original,
    attachVideo: vi.fn(() => new Promise(() => undefined)),
  }
})

import { VideoControlRegion, VideoPlayer } from './index'
import { attachVideo } from '../guest-js/index'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.head.querySelector('[data-tauri-video-player-styles]')?.remove()
})

describe('React integration', () => {
  it('installs scoped styles and marks built-in overlays without setup CSS', async () => {
    await act(async () => {
      root.render(<VideoPlayer source="https://example.test/movie.mkv" />)
    })

    const styles = document.head.querySelector<HTMLStyleElement>(
      '[data-tauri-video-player-styles]',
    )
    expect(styles).not.toBeNull()
    expect(container.querySelector('.tvp-controls')?.hasAttribute('data-tauri-video-controls'))
      .toBe(true)
    expect(container.querySelector('.tvp-overlay-slot')?.hasAttribute('data-tauri-video-controls'))
      .toBe(true)
    expect(attachVideo).toHaveBeenCalledWith(
      container.querySelector('video'),
      expect.objectContaining({
        source: 'https://example.test/movie.mkv',
        autoplay: false,
        deviceProfile: 'auto',
      }),
    )
  })

  it('supports a control region mounted independently from the player', async () => {
    await act(async () => {
      root.render(
        <aside>
          <VideoControlRegion className="application-toolbar">
            <button type="button">Play</button>
          </VideoControlRegion>
        </aside>,
      )
    })

    const toolbar = container.querySelector('.application-toolbar')
    expect(toolbar?.hasAttribute('data-tauri-video-controls')).toBe(true)
    expect(toolbar?.closest('.tvp-player')).toBeNull()
  })
})
