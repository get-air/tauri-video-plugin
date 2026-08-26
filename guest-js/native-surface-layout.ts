export interface NativeSurfaceLayout {
  x: number
  y: number
  width: number
  height: number
}

export interface NativeSurfacePosition extends NativeSurfaceLayout {
  scrollX: number
  scrollY: number
}

export interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

export interface ViewportLike {
  width: number
  height: number
}

export interface VisibleSurfaceBounds {
  left: number
  top: number
  right: number
  bottom: number
}

export function snapNativeSurfaceLayout(
  rect: RectLike,
  android: boolean,
  scale: number,
): NativeSurfaceLayout {
  const snap = android ? Math.trunc : Math.round
  return {
    x: snap(rect.left * scale),
    y: snap(rect.top * scale),
    width: Math.max(1, snap(rect.width * scale)),
    height: Math.max(1, snap(rect.height * scale)),
  }
}

export function visibleSurfaceBounds(
  layout: NativeSurfaceLayout,
  scale: number,
  viewport: ViewportLike,
): VisibleSurfaceBounds {
  return {
    left: clamp(layout.x / scale, 0, viewport.width),
    top: clamp(layout.y / scale, 0, viewport.height),
    right: clamp((layout.x + layout.width) / scale, 0, viewport.width),
    bottom: clamp((layout.y + layout.height) / scale, 0, viewport.height),
  }
}

export function sameNativeSurfacePosition(
  left: NativeSurfacePosition,
  right: NativeSurfacePosition | undefined,
  android: boolean,
): boolean {
  if (!right) return false
  const leftX = android ? left.x + left.scrollX : left.x
  const leftY = android ? left.y + left.scrollY : left.y
  const rightX = android ? right.x + right.scrollX : right.x
  const rightY = android ? right.y + right.scrollY : right.y
  return Math.abs(leftX - rightX) < 0.5
    && Math.abs(leftY - rightY) < 0.5
    && Math.abs(left.width - right.width) < 0.5
    && Math.abs(left.height - right.height) < 0.5
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
