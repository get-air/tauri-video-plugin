import {
  attachVideo,
  type AttachVideoOptions,
  type VideoController,
} from '../guest-js/index'

/** A rectangle in the authored coordinate system of a Blits application. */
export interface BlitsVideoRect {
  x: number
  y: number
  width: number
  height: number
}

export interface BlitsCanvasBoundsSource {
  getBoundingClientRect(): Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>
}

export interface BlitsHolePunch {
  type: 'holePunch'
  x: number
  y: number
  w: number
  h: number
  radius: number | number[]
}

export interface AttachBlitsVideoOptions
  extends Omit<AttachVideoOptions, 'surfaceMode'> {
  /** Canvas passed to `Blits.Launch`. */
  canvas: HTMLCanvasElement
  /** Authored app width passed to `Blits.Launch` (defaults to 1920). */
  appWidth?: number
  /** Authored app height passed to `Blits.Launch` (defaults to 1080). */
  appHeight?: number
  /** Static aperture or a getter for animated/reactive Blits layouts. */
  rect: BlitsVideoRect | (() => BlitsVideoRect)
}

export interface BlitsVideoController extends VideoController {
  /** Invisible DOM anchor used only for native-surface geometry and visibility. */
  readonly anchor: HTMLVideoElement
  /** Synchronize after changing a static rect outside Blits' render loop. */
  updateLayout(): void
}

/**
 * Renderer settings required for a live transparent aperture. Spread these
 * into the settings passed to `Blits.Launch`.
 */
export const transparentBlitsSettings = Object.freeze({
  canvasColor: '#00000000',
  advanced: Object.freeze({
    clearColor: 0x00000000,
    enableClear: true,
  }),
})

/** Shader value for the opaque Blits background that surrounds native video. */
export function blitsVideoHole(
  rect: BlitsVideoRect,
  radius: number | number[] = 0,
): BlitsHolePunch {
  assertRect(rect)
  return {
    type: 'holePunch',
    x: rect.x,
    y: rect.y,
    w: rect.width,
    h: rect.height,
    radius,
  }
}

/** Convert Blits authored coordinates into WebView viewport CSS pixels. */
export function blitsRectToViewport(
  canvas: BlitsCanvasBoundsSource,
  rect: BlitsVideoRect,
  appWidth = 1920,
  appHeight = 1080,
): BlitsVideoRect {
  assertRect(rect)
  if (!(appWidth > 0) || !(appHeight > 0)) {
    throw new RangeError('appWidth and appHeight must be positive')
  }
  const canvasRect = canvas.getBoundingClientRect()
  return {
    x: canvasRect.left + rect.x * canvasRect.width / appWidth,
    y: canvasRect.top + rect.y * canvasRect.height / appHeight,
    width: rect.width * canvasRect.width / appWidth,
    height: rect.height * canvasRect.height / appHeight,
  }
}

/**
 * Attach native playback beneath a Blits canvas. The returned controller is
 * the regular package controller; only geometry and canvas transparency are
 * adapted. Video frames never enter the canvas or a WebGL texture.
 */
export async function attachBlitsVideo(
  options: AttachBlitsVideoOptions,
): Promise<BlitsVideoController> {
  const {
    canvas,
    rect,
    appWidth = 1920,
    appHeight = 1080,
    ...videoOptions
  } = options
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new TypeError('attachBlitsVideo requires the canvas passed to Blits.Launch')
  }

  const anchor = document.createElement('video')
  anchor.setAttribute('aria-hidden', 'true')
  anchor.tabIndex = -1
  anchor.style.setProperty('position', 'fixed', 'important')
  anchor.style.setProperty('pointer-events', 'none', 'important')
  anchor.style.setProperty('margin', '0', 'important')
  anchor.style.setProperty('border', '0', 'important')
  anchor.style.setProperty('padding', '0', 'important')
  document.body.append(anchor)

  const releaseTransparency = claimTransparentWebView(canvas)
  let controller: VideoController | undefined
  let animationFrame: number | undefined
  let destroyed = false
  let lastRect = ''

  const updateLayout = () => {
    if (destroyed) return
    const logicalRect = typeof rect === 'function' ? rect() : rect
    const viewportRect = blitsRectToViewport(canvas, logicalRect, appWidth, appHeight)
    const nextRect = [viewportRect.x, viewportRect.y, viewportRect.width, viewportRect.height]
      .map((value) => value.toFixed(3))
      .join(':')
    if (nextRect === lastRect) return
    lastRect = nextRect
    anchor.style.left = `${viewportRect.x}px`
    anchor.style.top = `${viewportRect.y}px`
    anchor.style.width = `${viewportRect.width}px`
    anchor.style.height = `${viewportRect.height}px`
    controller?.refreshLayout()
  }

  const tick = () => {
    updateLayout()
    if (!destroyed) animationFrame = requestAnimationFrame(tick)
  }

  updateLayout()
  try {
    controller = await attachVideo(anchor, {
      ...videoOptions,
      surfaceMode: 'transparent-canvas',
    })
  } catch (error) {
    destroyed = true
    releaseTransparency()
    anchor.remove()
    throw error
  }

  const nativeDestroy = controller.destroy.bind(controller)
  const destroy = async () => {
    if (destroyed) return
    destroyed = true
    if (animationFrame !== undefined) cancelAnimationFrame(animationFrame)
    try {
      await nativeDestroy()
    } finally {
      releaseTransparency()
      anchor.remove()
    }
  }
  Object.defineProperties(controller, {
    anchor: { configurable: false, enumerable: true, value: anchor },
    updateLayout: { configurable: false, enumerable: false, value: updateLayout },
    destroy: { configurable: false, enumerable: false, value: destroy },
  })
  animationFrame = requestAnimationFrame(tick)
  return controller as BlitsVideoController
}

interface StyleLease {
  count: number
  value: string
  priority: string
}

const backgroundLeases = new WeakMap<HTMLElement, StyleLease>()

function claimTransparentWebView(canvas: HTMLCanvasElement): () => void {
  const elements = [document.documentElement, document.body, canvas]
  for (const element of elements) claimTransparentBackground(element)
  let active = true
  return () => {
    if (!active) return
    active = false
    for (const element of elements) releaseTransparentBackground(element)
  }
}

function claimTransparentBackground(element: HTMLElement): void {
  const lease = backgroundLeases.get(element)
  if (lease) {
    lease.count += 1
    return
  }
  backgroundLeases.set(element, {
    count: 1,
    value: element.style.getPropertyValue('background'),
    priority: element.style.getPropertyPriority('background'),
  })
  element.style.setProperty('background', 'transparent', 'important')
}

function releaseTransparentBackground(element: HTMLElement): void {
  const lease = backgroundLeases.get(element)
  if (!lease) return
  lease.count -= 1
  if (lease.count > 0) return
  if (lease.value) element.style.setProperty('background', lease.value, lease.priority)
  else element.style.removeProperty('background')
  backgroundLeases.delete(element)
}

function assertRect(rect: BlitsVideoRect): void {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) {
    throw new RangeError('Blits video rect values must be finite')
  }
  if (!(rect.width > 0) || !(rect.height > 0)) {
    throw new RangeError('Blits video rect width and height must be positive')
  }
}
