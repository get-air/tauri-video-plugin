import Blits from '@lightningjs/blits'
import { transparentCanvasRendererOptions } from '@get-air/video/canvas'

import App from './App'

const canvas = document.querySelector<HTMLCanvasElement>('#blits-canvas')
if (!canvas) throw new Error('Missing #blits-canvas')

Blits.Launch(App, 'app', {
  w: 1920,
  h: 1080,
  canvas,
  debugLevel: 1,
  maxFPS: 60,
  canvasColor: '#00000000',
  advanced: transparentCanvasRendererOptions,
})
