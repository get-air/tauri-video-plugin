import { describe, expect, it } from 'vitest'

import {
  blitsRectToViewport,
  blitsVideoHole,
  transparentBlitsSettings,
} from './index'

describe('Blits native-video aperture', () => {
  it('maps authored coordinates through the visible canvas bounds', () => {
    const canvas = {
      getBoundingClientRect: () => ({
        left: 10,
        top: 20,
        width: 960,
        height: 540,
      }),
    }
    expect(blitsRectToViewport(canvas, {
      x: 240,
      y: 180,
      width: 1440,
      height: 720,
    })).toEqual({
      x: 130,
      y: 110,
      width: 720,
      height: 360,
    })
  })

  it('builds the renderer-native holePunch shader value', () => {
    expect(blitsVideoHole({ x: 100, y: 80, width: 1280, height: 720 }, 24))
      .toEqual({
        type: 'holePunch',
        x: 100,
        y: 80,
        w: 1280,
        h: 720,
        radius: 24,
      })
  })

  it('keeps transparent clear enabled for every rendered frame', () => {
    expect(transparentBlitsSettings).toEqual({
      canvasColor: '#00000000',
      advanced: { clearColor: 0x00000000, enableClear: true },
    })
  })
})
