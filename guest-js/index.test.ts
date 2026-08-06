import { describe, expect, it } from 'vitest'

import { bufferedAhead } from './index'
import {
  sameNativeSurfacePosition,
  snapNativeSurfaceLayout,
  visibleSurfaceBounds,
} from './native-surface-layout'

function ranges(values: Array<[number, number]>): TimeRanges {
  return {
    length: values.length,
    start: (index) => values[index][0],
    end: (index) => values[index][1],
  }
}

describe('bufferedAhead', () => {
  it('reports the active range and ignores gaps', () => {
    const value = ranges([
      [0, 3],
      [8, 14],
    ])
    expect(bufferedAhead(value, 10)).toBe(4)
    expect(bufferedAhead(value, 5)).toBe(0)
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
})
