// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  NativeSurfaceCompositor,
  outsidePanels,
  registerVideoControls,
  VIDEO_CONTROLS_ATTRIBUTE,
} from './native-surface-compositor'

afterEach(() => {
  document.body.replaceChildren()
  document.body.removeAttribute('style')
  document.body.className = ''
  document.documentElement.className = ''
  document.documentElement.removeAttribute('style')
  delete document.documentElement.dataset.tauriNativeVideoSession
})

describe('outsidePanels', () => {
  it('partitions an ancestor around an inner aperture', () => {
    expect(outsidePanels(
      { left: 10, top: 20, width: 300, height: 200 },
      { left: 60, top: 70, right: 260, bottom: 170 },
    )).toEqual([
      { left: 0, top: 0, width: 300, height: 50 },
      { left: 0, top: 150, width: 300, height: 50 },
      { left: 0, top: 50, width: 50, height: 100 },
      { left: 250, top: 50, width: 50, height: 100 },
    ])
  })

  it('clamps a partially intersecting aperture without negative panels', () => {
    expect(outsidePanels(
      { left: 100, top: 100, width: 100, height: 100 },
      { left: 50, top: 50, right: 150, bottom: 150 },
    )).toEqual([
      { left: 0, top: 0, width: 100, height: 0 },
      { left: 0, top: 50, width: 100, height: 50 },
      { left: 0, top: 0, width: 0, height: 50 },
      { left: 50, top: 0, width: 50, height: 50 },
    ])
  })

  it('keeps the entire ancestor when it does not intersect the aperture', () => {
    expect(outsidePanels(
      { left: 0, top: 0, width: 50, height: 50 },
      { left: 100, top: 100, right: 200, bottom: 200 },
    )).toEqual([
      { left: 0, top: 0, width: 50, height: 50 },
      { left: 0, top: 0, width: 0, height: 0 },
      { left: 0, top: 0, width: 0, height: 0 },
      { left: 0, top: 0, width: 0, height: 0 },
    ])
  })
})

describe('registerVideoControls', () => {
  it('uses the backend-neutral Air control marker', () => {
    expect(VIDEO_CONTROLS_ATTRIBUTE).toBe('data-air-video-controls')
  })

  it('reference-counts registrations and restores pre-existing markup', () => {
    const first = document.createElement('nav')
    const second = document.createElement('aside')
    second.setAttribute(VIDEO_CONTROLS_ATTRIBUTE, 'custom')
    const releaseOne = registerVideoControls([first, second])
    const releaseTwo = registerVideoControls(first)

    expect(first.hasAttribute(VIDEO_CONTROLS_ATTRIBUTE)).toBe(true)
    expect(second.getAttribute(VIDEO_CONTROLS_ATTRIBUTE)).toBe('')
    releaseOne()
    expect(first.hasAttribute(VIDEO_CONTROLS_ATTRIBUTE)).toBe(true)
    expect(second.getAttribute(VIDEO_CONTROLS_ATTRIBUTE)).toBe('custom')
    releaseTwo()
    expect(first.hasAttribute(VIDEO_CONTROLS_ATTRIBUTE)).toBe(false)
  })
})

describe('NativeSurfaceCompositor', () => {
  it('reconstructs nested backgrounds around the aperture and restores the page', () => {
    const shell = document.createElement('main')
    const card = document.createElement('section')
    const video = document.createElement('video')
    shell.style.backgroundImage = 'linear-gradient(90deg, red, blue)'
    card.style.backgroundColor = 'rgb(20, 30, 40)'
    shell.append(card)
    card.append(video)
    document.body.append(shell)
    setRect(shell, { left: 20, top: 30, width: 700, height: 500 })
    setRect(card, { left: 100, top: 80, width: 500, height: 320 })
    setRect(document.body, { left: 0, top: 0, width: 800, height: 600 })
    setRect(document.documentElement, { left: 0, top: 0, width: 800, height: 600 })

    const compositor = new NativeSurfaceCompositor('test-owner', video)
    const frame = compositor.measure({ x: 140, y: 120, width: 320, height: 180 }, 1)
    compositor.commit(frame)

    expect(shell.getAttribute('data-tauri-native-video-hole')).toBe('test-owner')
    expect(card.getAttribute('data-tauri-native-video-hole')).toBe('test-owner')
    expect(document.documentElement.classList.contains('tauri-native-video')).toBe(true)
    const mirrors = document.querySelectorAll('[data-tauri-native-video-background]')
    expect(mirrors).toHaveLength(4)
    const paintLayers = document.querySelectorAll<HTMLDivElement>(
      '[data-tauri-native-video-background] > div > div',
    )
    // Transparent structural ancestors do not receive panel trees or enter the
    // per-frame write loop.
    expect(paintLayers).toHaveLength(16)
    expect([...paintLayers].some((layer) => layer.style.backgroundImage.includes('linear-gradient')))
      .toBe(true)
    expect(document.documentElement.style.getPropertyValue('--tauri-native-video-left')).toBe('140px')

    compositor.release()
    expect(document.querySelector('[data-tauri-native-video-backdrop]')).toBeNull()
    expect(shell.hasAttribute('data-tauri-native-video-hole')).toBe(false)
    expect(card.hasAttribute('data-tauri-native-video-hole')).toBe(false)
    expect(document.documentElement.classList.contains('tauri-native-video')).toBe(false)
  })

  it('transfers the same anchor without allowing stale cleanup to close the aperture', () => {
    const video = document.createElement('video')
    document.body.append(video)
    setRect(document.body, { left: 0, top: 0, width: 800, height: 600 })
    setRect(document.documentElement, { left: 0, top: 0, width: 800, height: 600 })
    const first = new NativeSurfaceCompositor('first', video)
    const second = new NativeSurfaceCompositor('second', video)

    first.release()
    expect(document.body.getAttribute('data-tauri-native-video-hole')).toBe('second')
    expect(document.querySelector('[data-tauri-native-video-backdrop]')).not.toBeNull()
    second.release()
    expect(document.querySelector('[data-tauri-native-video-backdrop]')).toBeNull()
  })

  it('clips the aperture to nested scroll containers', () => {
    const scroller = document.createElement('div')
    const video = document.createElement('video')
    scroller.style.overflowX = 'hidden'
    scroller.style.overflowY = 'hidden'
    scroller.style.border = '4px solid red'
    scroller.style.borderRadius = '20px'
    document.body.style.backgroundColor = 'white'
    scroller.append(video)
    document.body.append(scroller)
    setRect(scroller, { left: 100, top: 80, width: 300, height: 200 })
    setRect(document.body, { left: 0, top: 0, width: 800, height: 600 })
    setRect(document.documentElement, { left: 0, top: 0, width: 800, height: 600 })

    const compositor = new NativeSurfaceCompositor('clipped', video)
    const frame = compositor.measure({ x: 60, y: 40, width: 500, height: 360 }, 1)

    expect(frame.bounds).toEqual({ left: 104, top: 84, right: 396, bottom: 276 })
    expect(frame.radii).toEqual([
      { x: 16, y: 16 },
      { x: 16, y: 16 },
      { x: 16, y: 16 },
      { x: 16, y: 16 },
    ])
    compositor.commit(frame)
    const cornerMasks = document.querySelectorAll<HTMLDivElement>(
      '[data-tauri-native-video-background] > div:nth-of-type(n+5)',
    )
    expect([...cornerMasks].some((mask) => mask.style.clipPath.startsWith('polygon('))).toBe(true)
    compositor.release()
  })

  it('applies border radius authored directly on the video anchor', () => {
    const video = document.createElement('video')
    video.style.borderRadius = '12px 18px 24px 30px'
    document.body.append(video)
    setRect(document.body, { left: 0, top: 0, width: 800, height: 600 })
    setRect(document.documentElement, { left: 0, top: 0, width: 800, height: 600 })

    const compositor = new NativeSurfaceCompositor('rounded-anchor', video)
    const frame = compositor.measure({ x: 100, y: 100, width: 400, height: 240 }, 1)

    expect(frame.radii).toEqual([
      { x: 12, y: 12 },
      { x: 18, y: 18 },
      { x: 24, y: 24 },
      { x: 30, y: 30 },
    ])
    compositor.release()
  })

  it('ignores its own coordinate writes and unrelated component styles', async () => {
    const shell = document.createElement('main')
    const video = document.createElement('video')
    const unrelated = document.createElement('aside')
    shell.append(video)
    document.body.append(shell, unrelated)
    setRect(shell, { left: 50, top: 50, width: 500, height: 300 })
    setRect(document.body, { left: 0, top: 0, width: 800, height: 600 })
    setRect(document.documentElement, { left: 0, top: 0, width: 800, height: 600 })
    const compositor = new NativeSurfaceCompositor('observed', video)
    const invalidated = vi.fn()
    const stop = compositor.observe(invalidated)

    compositor.commit(compositor.measure({ x: 100, y: 100, width: 320, height: 180 }, 1))
    await Promise.resolve()
    unrelated.style.color = 'red'
    await Promise.resolve()
    expect(invalidated).not.toHaveBeenCalled()

    shell.style.backgroundColor = 'blue'
    await Promise.resolve()
    expect(invalidated).toHaveBeenCalledOnce()
    expect(invalidated).toHaveBeenCalledWith(true)
    stop()
    compositor.release()
  })

  it('cuts unrelated page branches out of the aperture while preserving controls anywhere', () => {
    const app = document.createElement('main')
    const video = document.createElement('video')
    const opaqueSibling = document.createElement('article')
    const coveredSibling = document.createElement('section')
    const toolbar = document.createElement('nav')
    toolbar.append(document.createElement('button'))
    opaqueSibling.style.clipPath = 'inset(2px)'
    opaqueSibling.style.setProperty('--tauri-native-video-mask-size', '13px 17px')
    app.append(video)
    document.body.append(opaqueSibling, coveredSibling, app, toolbar)
    setRect(app, { left: 0, top: 0, width: 800, height: 600 })
    setRect(opaqueSibling, { left: 80, top: 80, width: 500, height: 300 })
    setRect(coveredSibling, { left: 140, top: 120, width: 100, height: 80 })
    setRect(toolbar, { left: 100, top: 100, width: 320, height: 60 })
    setRect(document.body, { left: 0, top: 0, width: 800, height: 600 })
    setRect(document.documentElement, { left: 0, top: 0, width: 800, height: 600 })

    const compositor = new NativeSurfaceCompositor('page-aperture', video)
    const frame = compositor.measure({ x: 100, y: 100, width: 320, height: 180 }, 1)
    compositor.commit(frame)

    expect(opaqueSibling.style.clipPath).toBe('inset(2px)')
    expect(opaqueSibling.getAttribute('data-tauri-native-video-occluder')).toBe('page-aperture')
    expect(opaqueSibling.style.getPropertyValue('--tauri-native-video-mask-size')).not.toBe('')
    expect(opaqueSibling.style.getPropertyPriority('--tauri-native-video-mask-size')).toBe('important')
    expect(coveredSibling.style.getPropertyValue('--tauri-native-video-mask-image'))
      .toBe('linear-gradient(transparent, transparent)')
    expect(coveredSibling.style.getPropertyValue('--tauri-native-video-mask-size')).toBe('100% 100%')
    expect(toolbar.getAttribute('data-tauri-native-video-occluder')).toBe('page-aperture')
    const releaseControls = registerVideoControls(toolbar)
    expect(toolbar.hasAttribute('data-tauri-native-video-occluder')).toBe(false)
    expect(toolbar.querySelector('button')?.hasAttribute('data-tauri-native-video-occluder')).toBe(false)
    compositor.release()
    expect(opaqueSibling.style.clipPath).toBe('inset(2px)')
    expect(opaqueSibling.style.getPropertyValue('--tauri-native-video-mask-size')).toBe('13px 17px')
    releaseControls()
  })

  it('batches geometry reads before writes and makes stable commits allocation-light', () => {
    const rectReads: ReturnType<typeof vi.fn>[] = []
    let parent = document.body
    for (let index = 0; index < 12; index += 1) {
      const ancestor = document.createElement('div')
      if (index % 3 === 0) ancestor.style.backgroundColor = `rgb(${index + 20}, 30, 40)`
      parent.append(ancestor)
      parent = ancestor
      const read = vi.fn(() => domRect({ left: 0, top: 0, width: 800, height: 600 }))
      ancestor.getBoundingClientRect = read
      rectReads.push(read)
    }
    const video = document.createElement('video')
    parent.append(video)
    for (let index = 0; index < 20; index += 1) {
      const branch = document.createElement('section')
      document.body.append(branch)
      const read = vi.fn(() => domRect({ left: 700, top: 0, width: 100, height: 100 }))
      branch.getBoundingClientRect = read
      rectReads.push(read)
    }
    setRect(document.body, { left: 0, top: 0, width: 800, height: 600 })
    setRect(document.documentElement, { left: 0, top: 0, width: 800, height: 600 })
    const compositor = new NativeSurfaceCompositor('performance', video)
    const computedStyle = vi.spyOn(globalThis, 'getComputedStyle')

    const frame = compositor.measure({ x: 100, y: 100, width: 480, height: 270 }, 1)
    expect(computedStyle).not.toHaveBeenCalled()
    expect(rectReads.every((read) => read.mock.calls.length === 1)).toBe(true)

    compositor.commit(frame)
    const styleWrites = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty')
    compositor.commit(frame)
    expect(styleWrites).not.toHaveBeenCalled()
    expect(rectReads.every((read) => read.mock.calls.length === 1)).toBe(true)
    styleWrites.mockRestore()
    computedStyle.mockRestore()
    compositor.release()
  })
})

function setRect(element: Element, rect: { left: number; top: number; width: number; height: number }): void {
  element.getBoundingClientRect = () => domRect(rect)
}

function domRect(rect: { left: number; top: number; width: number; height: number }): DOMRect {
  return {
    ...rect,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  }
}
