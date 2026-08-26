import type { VisibleSurfaceBounds } from './native-surface-layout'

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export interface CornerRadius { x: number; y: number }
export type CornerRadii = readonly [CornerRadius, CornerRadius, CornerRadius, CornerRadius]
export type CornerRadiusStyles = readonly [string, string, string, string]

const ZERO_RADIUS: CornerRadius = Object.freeze({ x: 0, y: 0 })
export const ZERO_RADII: CornerRadii = Object.freeze([
  ZERO_RADIUS, ZERO_RADIUS, ZERO_RADIUS, ZERO_RADIUS,
])
export const ZERO_RADIUS_STYLES: CornerRadiusStyles = Object.freeze(['0px', '0px', '0px', '0px'])

export function outsidePanels(ancestor: Rect, hole: VisibleSurfaceBounds): readonly Rect[] {
  const right = ancestor.left + ancestor.width
  const bottom = ancestor.top + ancestor.height
  const intersectionLeft = clamp(hole.left, ancestor.left, right)
  const intersectionTop = clamp(hole.top, ancestor.top, bottom)
  const intersectionRight = clamp(hole.right, ancestor.left, right)
  const intersectionBottom = clamp(hole.bottom, ancestor.top, bottom)
  if (intersectionRight <= intersectionLeft || intersectionBottom <= intersectionTop) {
    return [{ left: 0, top: 0, width: ancestor.width, height: ancestor.height },
      EMPTY_PANEL, EMPTY_PANEL, EMPTY_PANEL]
  }
  const left = intersectionLeft - ancestor.left
  const top = intersectionTop - ancestor.top
  const localRight = intersectionRight - ancestor.left
  const localBottom = intersectionBottom - ancestor.top
  return [
    { left: 0, top: 0, width: ancestor.width, height: top },
    { left: 0, top: localBottom, width: ancestor.width, height: ancestor.height - localBottom },
    { left: 0, top, width: left, height: localBottom - top },
    { left: localRight, top, width: ancestor.width - localRight, height: localBottom - top },
  ]
}

export function intersectBounds(
  first: VisibleSurfaceBounds,
  second: VisibleSurfaceBounds,
): VisibleSurfaceBounds {
  const left = Math.max(first.left, second.left)
  const top = Math.max(first.top, second.top)
  return {
    left,
    top,
    right: Math.max(left, Math.min(first.right, second.right)),
    bottom: Math.max(top, Math.min(first.bottom, second.bottom)),
  }
}

export function subtractRadius(
  radius: CornerRadius,
  horizontal: number,
  vertical: number,
): CornerRadius {
  return { x: Math.max(0, radius.x - horizontal), y: Math.max(0, radius.y - vertical) }
}

export function parseCornerRadii(
  styles: CornerRadiusStyles,
  bounds: VisibleSurfaceBounds,
): CornerRadii {
  const width = Math.max(0, bounds.right - bounds.left)
  const height = Math.max(0, bounds.bottom - bounds.top)
  return styles.map((style) => {
    const [horizontal = '0', vertical = horizontal] = style.trim().split(/\s+/)
    return { x: radiusPixels(horizontal, width), y: radiusPixels(vertical, height) }
  }) as unknown as CornerRadii
}

export function radiiForIntersection(
  bounds: VisibleSurfaceBounds,
  shape: VisibleSurfaceBounds,
  radii: CornerRadii,
): CornerRadii {
  return [
    sameEdge(bounds.left, shape.left) && sameEdge(bounds.top, shape.top) ? radii[0] : ZERO_RADIUS,
    sameEdge(bounds.right, shape.right) && sameEdge(bounds.top, shape.top) ? radii[1] : ZERO_RADIUS,
    sameEdge(bounds.right, shape.right) && sameEdge(bounds.bottom, shape.bottom) ? radii[2] : ZERO_RADIUS,
    sameEdge(bounds.left, shape.left) && sameEdge(bounds.bottom, shape.bottom) ? radii[3] : ZERO_RADIUS,
  ]
}

export function mergeIntersectionRadii(
  previousBounds: VisibleSurfaceBounds,
  previousRadii: CornerRadii,
  bounds: VisibleSurfaceBounds,
  shape: VisibleSurfaceBounds,
  shapeRadii: CornerRadii,
): CornerRadii {
  const introduced = radiiForIntersection(bounds, shape, shapeRadii)
  return radiiForIntersection(bounds, previousBounds, previousRadii).map((radius, index) => ({
    x: Math.max(radius.x, introduced[index].x),
    y: Math.max(radius.y, introduced[index].y),
  })) as unknown as CornerRadii
}

export function cornerPanels(bounds: VisibleSurfaceBounds, radii: CornerRadii): readonly Rect[] {
  return [
    { left: bounds.left, top: bounds.top, width: radii[0].x, height: radii[0].y },
    { left: bounds.right - radii[1].x, top: bounds.top, width: radii[1].x, height: radii[1].y },
    { left: bounds.right - radii[2].x, top: bounds.bottom - radii[2].y,
      width: radii[2].x, height: radii[2].y },
    { left: bounds.left, top: bounds.bottom - radii[3].y, width: radii[3].x, height: radii[3].y },
  ]
}

function cornerClipPath(
  outer: readonly [number, number],
  center: readonly [number, number],
  startDegrees: number,
  endDegrees: number,
): string {
  const points: Array<readonly [number, number]> = [outer]
  for (let step = 0; step <= 8; step += 1) {
    const angle = (startDegrees + (endDegrees - startDegrees) * step / 8) * Math.PI / 180
    points.push([center[0] + 100 * Math.cos(angle), center[1] + 100 * Math.sin(angle)])
  }
  return `polygon(${points.map(([x, y]) => `${cleanPercent(x)}% ${cleanPercent(y)}%`).join(',')})`
}

function radiusPixels(value: string, extent: number): number {
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, value.endsWith('%') ? extent * parsed / 100 : parsed)
}

function sameEdge(first: number, second: number): boolean {
  return Math.abs(first - second) < 0.01
}

function cleanPercent(value: number): number {
  if (Math.abs(value) < 0.0001) return 0
  if (Math.abs(value - 100) < 0.0001) return 100
  return Math.round(value * 1_000) / 1_000
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

const EMPTY_PANEL: Rect = Object.freeze({ left: 0, top: 0, width: 0, height: 0 })
export const CORNER_CLIP_PATHS = Object.freeze([
  cornerClipPath([0, 0], [100, 100], -90, -180),
  cornerClipPath([100, 0], [0, 100], -90, 0),
  cornerClipPath([100, 100], [0, 0], 90, 0),
  cornerClipPath([0, 100], [100, 0], 90, 180),
])
