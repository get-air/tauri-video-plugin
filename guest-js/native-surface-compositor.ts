import {
  visibleSurfaceBounds,
  type NativeSurfaceLayout,
  type VisibleSurfaceBounds,
} from './native-surface-layout'
import {
  CORNER_CLIP_PATHS,
  ZERO_RADII,
  ZERO_RADIUS_STYLES,
  cornerPanels,
  intersectBounds,
  mergeIntersectionRadii,
  outsidePanels,
  parseCornerRadii,
  radiiForIntersection,
  subtractRadius,
  type CornerRadii,
  type CornerRadiusStyles,
  type Rect,
} from './native-surface-geometry'
import {
  registerVideoControls as registerAirVideoControls,
  VIDEO_CONTROLS_ATTRIBUTE,
  type VideoControlsTarget,
} from '@get-air/video/controls'

export { VIDEO_CONTROLS_ATTRIBUTE, type VideoControlsTarget } from '@get-air/video/controls'
export { outsidePanels } from './native-surface-geometry'

/**
 * Marks arbitrary DOM as intentional video UI. The element can live anywhere
 * in the document; it does not need to be a child of or overlap the video.
 */
export function registerVideoControls(target: VideoControlsTarget): () => void {
  const release = registerAirVideoControls(target)
  refreshActiveOccluders()
  let registered = true
  return () => {
    if (!registered) return
    registered = false
    release()
    refreshActiveOccluders()
  }
}

export interface SurfaceCompositorFrame {
  bounds: VisibleSurfaceBounds
  width: number
  height: number
  radii: CornerRadii
  ancestors: readonly ElementFrame[]
  occluders: readonly ElementFrame[]
}

interface ElementFrame {
  element: HTMLElement
  rect: Rect
}

interface BackgroundPanel {
  clip: HTMLDivElement
  paint: HTMLDivElement
}

interface DrilledAncestor {
  element: HTMLElement
  previousOwner: string | null
  mirror: HTMLDivElement
  panels: BackgroundPanel[]
  clipsX: boolean
  clipsY: boolean
  borderLeft: number
  borderTop: number
  borderRight: number
  borderBottom: number
  radii: CornerRadiusStyles
  paintsBackground: boolean
}

interface BackgroundSnapshot {
  properties: readonly [string, string][]
  borderRadius: string
  clipsX: boolean
  clipsY: boolean
  borderLeft: number
  borderTop: number
  borderRight: number
  borderBottom: number
  radii: CornerRadiusStyles
  paintsBackground: boolean
}

interface ClippedOccluder {
  element: HTMLElement
  owner: string
  active: boolean
  previousOwner: string | null
  previousImage: InlinePropertySnapshot
  previousPosition: InlinePropertySnapshot
  previousSize: InlinePropertySnapshot
}

interface InlinePropertySnapshot {
  value: string
  priority: string
}

interface NativeCssSurfaceState {
  owner: string
  anchor: HTMLVideoElement
  layer: HTMLDivElement
  style: HTMLStyleElement
  drilled: DrilledAncestor[]
  rootHadClass: boolean
  previousSession: string | undefined
  anchorRadii: CornerRadiusStyles
  occluders: ClippedOccluder[]
  protectedElements: Set<HTMLElement>
  lastBounds?: VisibleSurfaceBounds
}

const BACKGROUND_PROPERTIES = [
  'background-color', 'background-image', 'background-position', 'background-size',
  'background-repeat', 'background-origin', 'background-clip', 'background-attachment',
  'background-blend-mode', 'box-sizing', 'padding-top', 'padding-right', 'padding-bottom',
  'padding-left', 'border-top-width', 'border-right-width', 'border-bottom-width',
  'border-left-width', 'border-top-style', 'border-right-style', 'border-bottom-style',
  'border-left-style',
] as const

const nativeCssSurfaceScope = globalThis as typeof globalThis & {
  __TAURI_VIDEO_NATIVE_CSS_SURFACE__?: NativeCssSurfaceState
}

/**
 * Owns the transparent aperture and exact background reconstruction around it.
 * Reads happen in `measure`; DOM writes happen in `commit`, keeping every
 * animation frame free of read/write layout thrashing.
 */
export class NativeSurfaceCompositor {
  readonly #owner: string
  readonly #anchor: HTMLVideoElement

  constructor(owner: string, anchor: HTMLVideoElement) {
    this.#owner = owner
    this.#anchor = anchor
    claimSurface(owner, anchor)
  }

  measure(layout: NativeSurfaceLayout, scale: number): SurfaceCompositorFrame {
    const state = this.#state()
    const surfaceBounds = {
      left: layout.x / scale,
      top: layout.y / scale,
      right: (layout.x + layout.width) / scale,
      bottom: (layout.y + layout.height) / scale,
    }
    let bounds = visibleSurfaceBounds(layout, scale, {
      width: window.innerWidth,
      height: window.innerHeight,
    })
    let radii = radiiForIntersection(
      bounds,
      surfaceBounds,
      parseCornerRadii(state?.anchorRadii ?? ZERO_RADIUS_STYLES, surfaceBounds),
    )
    if (!state) return {
      bounds,
      width: layout.width / scale,
      height: layout.height / scale,
      radii,
      ancestors: [],
      occluders: [],
    }
    const ancestors = state.drilled.map(({ element }) => ({
      element,
      rect: rectFrom(element.getBoundingClientRect()),
    }))
    const occluders = state.occluders.map(({ element }) => ({
      element,
      rect: rectFrom(element.getBoundingClientRect()),
    }))
    for (let index = 0; index < ancestors.length; index += 1) {
      const ancestor = state.drilled[index]
      const clip = ancestorClip(ancestors[index].rect, ancestor)
      if (!clip) continue
      const nextBounds = intersectBounds(bounds, clip)
      radii = mergeIntersectionRadii(
        bounds,
        radii,
        nextBounds,
        clip,
        innerCornerRadii(ancestor, ancestors[index].rect),
      )
      bounds = nextBounds
    }
    return {
      bounds,
      width: layout.width / scale,
      height: layout.height / scale,
      radii,
      ancestors,
      occluders,
    }
  }

  commit(frame: SurfaceCompositorFrame): void {
    const state = this.#state()
    if (!state) return
    state.lastBounds = frame.bounds
    for (let index = 0; index < state.drilled.length; index += 1) {
      const ancestor = state.drilled[index]
      const measured = frame.ancestors[index]
      if (measured?.element !== ancestor.element) continue
      commitAncestor(ancestor, measured.rect, frame.bounds, frame.radii)
    }
    for (let index = 0; index < state.occluders.length; index += 1) {
      const occluder = state.occluders[index]
      const measured = frame.occluders[index]
      if (measured?.element !== occluder.element) continue
      commitOccluder(occluder, measured.rect, frame.bounds)
    }
    const root = document.documentElement
    setProperty(root, '--tauri-native-video-left', `${frame.bounds.left}px`)
    setProperty(root, '--tauri-native-video-top', `${frame.bounds.top}px`)
    setProperty(root, '--tauri-native-video-right', `${frame.bounds.right}px`)
    setProperty(root, '--tauri-native-video-bottom', `${frame.bounds.bottom}px`)
    setProperty(root, '--tauri-native-video-width', `${frame.width}px`)
    setProperty(root, '--tauri-native-video-height', `${frame.height}px`)
  }

  /** Re-reads backgrounds and repairs the ancestor chain after DOM changes. */
  refresh(): void {
    const state = this.#state()
    if (!state) return
    const elements = collectAncestors(this.#anchor)
    const chainChanged = elements.length !== state.drilled.length
      || elements.some((element, index) => state.drilled[index]?.element !== element)
    if (chainChanged) rebuildAncestors(state, elements)
    else refreshBackgrounds(state)
    rebuildOccluders(state)
  }

  /**
   * Watches only mutations that can move the anchor or change a drilled
   * background. Unrelated component updates do not enter the layout path.
   */
  observe(onInvalidated: (backgroundChanged: boolean) => void): () => void {
    if (typeof MutationObserver === 'undefined') return () => undefined
    const observer = new MutationObserver((records) => {
      const state = this.#state()
      if (!state) return
      let layoutChanged = false
      let backgroundChanged = false
      for (const record of records) {
        if (record.type === 'attributes') {
          if (nativeCoordinateMutation(record)) continue
          if (record.target === this.#anchor
            || state.drilled.some(({ element }) => element === record.target)) {
            layoutChanged = true
            backgroundChanged = true
          }
          continue
        }
        if (stylesheetMutation(record) || structuralMutation(record, state)) backgroundChanged = true
        if (state.drilled.some(({ element }) => element === record.target)
          || mutationContains(record, this.#anchor)) {
          layoutChanged = true
        }
      }
      if (layoutChanged || backgroundChanged) onInvalidated(backgroundChanged)
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['class', 'style'],
      childList: true,
      subtree: true,
    })
    return () => observer.disconnect()
  }

  release(): void {
    releaseSurface(this.#owner)
  }

  #state(): NativeCssSurfaceState | undefined {
    const state = nativeCssSurfaceScope.__TAURI_VIDEO_NATIVE_CSS_SURFACE__
    return state?.owner === this.#owner && state.anchor === this.#anchor ? state : undefined
  }
}

function claimSurface(owner: string, anchor: HTMLVideoElement): void {
  const existing = nativeCssSurfaceScope.__TAURI_VIDEO_NATIVE_CSS_SURFACE__
  if (existing?.anchor === anchor && existing.layer.isConnected) {
    for (const ancestor of existing.drilled) {
      if (ancestor.element.getAttribute('data-tauri-native-video-hole') === existing.owner) {
        ancestor.element.setAttribute('data-tauri-native-video-hole', owner)
      }
    }
    for (const occluder of existing.occluders) {
      if (occluder.element.getAttribute(OCCLUDER_ATTRIBUTE) === existing.owner) {
        occluder.element.setAttribute(OCCLUDER_ATTRIBUTE, owner)
      }
      occluder.owner = owner
    }
    existing.owner = owner
    existing.style.textContent = holeStyle(owner)
    document.documentElement.dataset.tauriNativeVideoSession = owner
    return
  }
  if (existing) releaseSurface(existing.owner)
  removeOrphanedSurfaceNodes()

  const root = document.documentElement
  const layer = document.createElement('div')
  layer.dataset.tauriNativeVideoBackdrop = ''
  layer.setAttribute('aria-hidden', 'true')
  Object.assign(layer.style, {
    position: 'fixed',
    zIndex: '-2147483647',
    inset: '0',
    overflow: 'hidden',
    pointerEvents: 'none',
    contain: 'strict',
  })
  const style = document.createElement('style')
  style.dataset.tauriNativeVideoBackdropStyle = ''
  style.textContent = holeStyle(owner)
  layer.append(style)
  document.body.prepend(layer)

  const state: NativeCssSurfaceState = {
    owner,
    anchor,
    layer,
    style,
    drilled: [],
    rootHadClass: root.classList.contains('tauri-native-video'),
    previousSession: root.dataset.tauriNativeVideoSession,
    anchorRadii: readCornerRadiusStyles(anchor),
    occluders: [],
    protectedElements: new Set(),
  }
  rebuildAncestors(state, collectAncestors(anchor))
  root.dataset.tauriNativeVideoSession = owner
  root.classList.add('tauri-native-video')
  nativeCssSurfaceScope.__TAURI_VIDEO_NATIVE_CSS_SURFACE__ = state
  rebuildOccluders(state)
}

function rebuildAncestors(state: NativeCssSurfaceState, elements: readonly HTMLElement[]): void {
  for (const ancestor of state.drilled) restoreAncestor(ancestor, state.owner)
  state.drilled = []
  // The outer background paints first, then progressively more local surfaces.
  for (const element of [...elements].reverse()) {
    const ancestor = createAncestor(element, state.owner)
    state.drilled.unshift(ancestor)
    state.layer.append(ancestor.mirror)
  }
}

function rebuildOccluders(state: NativeCssSurfaceState): void {
  for (const occluder of state.occluders) restoreOccluder(occluder)
  state.occluders = []
  const protectedElements = new Set<HTMLElement>()
  protectPath(state.anchor, protectedElements)
  for (const controls of document.querySelectorAll<HTMLElement>(`[${VIDEO_CONTROLS_ATTRIBUTE}]`)) {
    protectPath(controls, protectedElements)
  }
  state.protectedElements = protectedElements

  const visit = (element: HTMLElement) => {
    if (element === state.layer || !element.isConnected) return
    if (element === state.anchor || element.hasAttribute(VIDEO_CONTROLS_ATTRIBUTE)) return
    if (protectedElements.has(element)) {
      for (const child of element.children) {
        if (child instanceof HTMLElement) visit(child)
      }
      return
    }
    if (element instanceof HTMLScriptElement || element instanceof HTMLStyleElement) return
    state.occluders.push({
      element,
      owner: state.owner,
      active: false,
      previousOwner: element.getAttribute(OCCLUDER_ATTRIBUTE),
      previousImage: inlineProperty(element, MASK_IMAGE_PROPERTY),
      previousPosition: inlineProperty(element, MASK_POSITION_PROPERTY),
      previousSize: inlineProperty(element, MASK_SIZE_PROPERTY),
    })
  }
  for (const child of document.body.children) {
    if (child instanceof HTMLElement) visit(child)
  }
  if (state.lastBounds) {
    for (const occluder of state.occluders) {
      commitOccluder(
        occluder,
        rectFrom(occluder.element.getBoundingClientRect()),
        state.lastBounds,
      )
    }
  }
}

function protectPath(element: HTMLElement, protectedElements: Set<HTMLElement>): void {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    protectedElements.add(current)
  }
}

function refreshActiveOccluders(): void {
  const state = nativeCssSurfaceScope.__TAURI_VIDEO_NATIVE_CSS_SURFACE__
  if (state) rebuildOccluders(state)
}

function createAncestor(element: HTMLElement, owner: string): DrilledAncestor {
  const mirror = document.createElement('div')
  mirror.dataset.tauriNativeVideoBackground = ''
  Object.assign(mirror.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    overflow: 'hidden',
    pointerEvents: 'none',
  })
  const ancestor = {
    element,
    previousOwner: element.getAttribute('data-tauri-native-video-hole'),
    mirror,
    panels: [],
    clipsX: false,
    clipsY: false,
    borderLeft: 0,
    borderTop: 0,
    borderRight: 0,
    borderBottom: 0,
    radii: ZERO_RADIUS_STYLES,
    paintsBackground: false,
  }
  const background = readBackground(element)
  element.setAttribute('data-tauri-native-video-hole', owner)
  applyBackground(ancestor, background)
  return ancestor
}

function refreshBackgrounds(state: NativeCssSurfaceState): void {
  // Read the real page styling with the aperture rule temporarily disabled.
  // All writes happen before all reads, and all mirror writes happen after,
  // so one refresh causes at most one style/layout calculation.
  for (const ancestor of state.drilled) {
    if (ancestor.element.getAttribute('data-tauri-native-video-hole') === state.owner) {
      ancestor.element.removeAttribute('data-tauri-native-video-hole')
    }
  }
  const backgrounds = state.drilled.map(({ element }) => readBackground(element))
  state.anchorRadii = readCornerRadiusStyles(state.anchor)
  for (const ancestor of state.drilled) {
    ancestor.element.setAttribute('data-tauri-native-video-hole', state.owner)
  }
  for (let index = 0; index < state.drilled.length; index += 1) {
    applyBackground(state.drilled[index], backgrounds[index])
  }
}

function readBackground(element: HTMLElement): BackgroundSnapshot {
  const computed = getComputedStyle(element)
  return {
    properties: BACKGROUND_PROPERTIES.map((property) => (
      [property, computed.getPropertyValue(property)] as const)),
    borderRadius: computed.borderRadius,
    clipsX: clipsOverflow(computed.overflowX),
    clipsY: clipsOverflow(computed.overflowY),
    borderLeft: cssPixels(computed.borderLeftWidth),
    borderTop: cssPixels(computed.borderTopWidth),
    borderRight: cssPixels(computed.borderRightWidth),
    borderBottom: cssPixels(computed.borderBottomWidth),
    radii: readCornerRadiusStyles(element, computed),
    paintsBackground: hasVisibleBackground(computed),
  }
}

function applyBackground(ancestor: DrilledAncestor, snapshot: BackgroundSnapshot): void {
  ancestor.paintsBackground = snapshot.paintsBackground
  if (snapshot.paintsBackground && ancestor.panels.length === 0) createBackgroundPanels(ancestor)
  setStyle(ancestor.mirror, 'display', snapshot.paintsBackground ? 'block' : 'none')
  for (const panel of ancestor.panels) {
    for (const [property, value] of snapshot.properties) {
      setStyle(panel.paint, property, value)
    }
    setStyle(panel.paint, 'border-color', 'transparent')
  }
  setStyle(ancestor.mirror, 'border-radius', snapshot.borderRadius)
  ancestor.clipsX = snapshot.clipsX
  ancestor.clipsY = snapshot.clipsY
  ancestor.borderLeft = snapshot.borderLeft
  ancestor.borderTop = snapshot.borderTop
  ancestor.borderRight = snapshot.borderRight
  ancestor.borderBottom = snapshot.borderBottom
  ancestor.radii = snapshot.radii
}

function commitAncestor(
  ancestor: DrilledAncestor,
  rect: Rect,
  hole: VisibleSurfaceBounds,
  radii: CornerRadii,
): void {
  if (!ancestor.paintsBackground) return
  setStyle(ancestor.mirror, 'transform', `translate3d(${rect.left}px, ${rect.top}px, 0)`)
  setStyle(ancestor.mirror, 'width', `${Math.max(0, rect.width)}px`)
  setStyle(ancestor.mirror, 'height', `${Math.max(0, rect.height)}px`)
  const panels = outsidePanels(rect, hole)
  for (let index = 0; index < 4; index += 1) {
    const panel = ancestor.panels[index]
    const region = panels[index]
    setStyle(panel.clip, 'transform', `translate3d(${region.left}px, ${region.top}px, 0)`)
    setStyle(panel.clip, 'width', `${Math.max(0, region.width)}px`)
    setStyle(panel.clip, 'height', `${Math.max(0, region.height)}px`)
    setStyle(panel.paint, 'transform', `translate3d(${-region.left}px, ${-region.top}px, 0)`)
    setStyle(panel.paint, 'width', `${Math.max(0, rect.width)}px`)
    setStyle(panel.paint, 'height', `${Math.max(0, rect.height)}px`)
  }
  const corners = cornerPanels(hole, radii)
  for (let index = 0; index < 4; index += 1) {
    const panel = ancestor.panels[index + 4]
    const region = corners[index]
    const localLeft = region.left - rect.left
    const localTop = region.top - rect.top
    setStyle(panel.clip, 'transform', `translate3d(${localLeft}px, ${localTop}px, 0)`)
    setStyle(panel.clip, 'width', `${Math.max(0, region.width)}px`)
    setStyle(panel.clip, 'height', `${Math.max(0, region.height)}px`)
    setStyle(panel.paint, 'transform', `translate3d(${-localLeft}px, ${-localTop}px, 0)`)
    setStyle(panel.paint, 'width', `${Math.max(0, rect.width)}px`)
    setStyle(panel.paint, 'height', `${Math.max(0, rect.height)}px`)
  }
}

function commitOccluder(
  occluder: ClippedOccluder,
  rect: Rect,
  hole: VisibleSurfaceBounds,
): void {
  const right = rect.left + rect.width
  const bottom = rect.top + rect.height
  const left = Math.max(rect.left, hole.left)
  const top = Math.max(rect.top, hole.top)
  const clippedRight = Math.min(right, hole.right)
  const clippedBottom = Math.min(bottom, hole.bottom)
  if (rect.width <= 0 || rect.height <= 0 || clippedRight <= left || clippedBottom <= top) {
    restoreOccluder(occluder)
    return
  }
  let image = ''
  let position = ''
  let size = ''
  for (const panel of outsidePanels(rect, hole)) {
    if (panel.width <= 0 || panel.height <= 0) continue
    const separator = image ? ',' : ''
    image += `${separator}linear-gradient(#000, #000)`
    position += `${separator}${panel.left}px ${panel.top}px`
    size += `${separator}${panel.width}px ${panel.height}px`
  }
  if (!image) {
    image = 'linear-gradient(transparent, transparent)'
    position = '0 0'
    size = '100% 100%'
  }
  if (occluder.element.getAttribute(OCCLUDER_ATTRIBUTE) !== occluder.owner) {
    occluder.element.setAttribute(OCCLUDER_ATTRIBUTE, occluder.owner)
  }
  occluder.active = true
  setProperty(occluder.element, MASK_IMAGE_PROPERTY, image, 'important')
  setProperty(occluder.element, MASK_POSITION_PROPERTY, position, 'important')
  setProperty(occluder.element, MASK_SIZE_PROPERTY, size, 'important')
}

function createBackgroundPanels(ancestor: DrilledAncestor): void {
  ancestor.panels = Array.from({ length: 8 }, (_, index) => {
    const clip = document.createElement('div')
    const paint = document.createElement('div')
    Object.assign(clip.style, { position: 'absolute', overflow: 'hidden' })
    Object.assign(paint.style, { position: 'absolute', top: '0', left: '0' })
    if (index >= 4) clip.style.clipPath = CORNER_CLIP_PATHS[index - 4]
    clip.append(paint)
    ancestor.mirror.append(clip)
    return { clip, paint }
  })
}

function releaseSurface(owner: string): void {
  const state = nativeCssSurfaceScope.__TAURI_VIDEO_NATIVE_CSS_SURFACE__
  if (!state || state.owner !== owner) return
  for (const ancestor of state.drilled) restoreAncestor(ancestor, owner)
  for (const occluder of state.occluders) restoreOccluder(occluder)
  state.layer.remove()
  const root = document.documentElement
  if (state.previousSession === undefined) delete root.dataset.tauriNativeVideoSession
  else root.dataset.tauriNativeVideoSession = state.previousSession
  if (!state.rootHadClass) root.classList.remove('tauri-native-video')
  for (const property of NATIVE_VIDEO_CSS_PROPERTIES) root.style.removeProperty(property)
  delete nativeCssSurfaceScope.__TAURI_VIDEO_NATIVE_CSS_SURFACE__
}

function restoreAncestor(ancestor: DrilledAncestor, owner: string): void {
  if (ancestor.element.getAttribute('data-tauri-native-video-hole') === owner) {
    if (ancestor.previousOwner === null) ancestor.element.removeAttribute('data-tauri-native-video-hole')
    else ancestor.element.setAttribute('data-tauri-native-video-hole', ancestor.previousOwner)
  }
  ancestor.mirror.remove()
}

function restoreOccluder(occluder: ClippedOccluder): void {
  if (!occluder.active) return
  if (occluder.element.getAttribute(OCCLUDER_ATTRIBUTE) === occluder.owner) {
    if (occluder.previousOwner === null) occluder.element.removeAttribute(OCCLUDER_ATTRIBUTE)
    else occluder.element.setAttribute(OCCLUDER_ATTRIBUTE, occluder.previousOwner)
  }
  restoreInlineProperty(occluder.element, MASK_IMAGE_PROPERTY, occluder.previousImage)
  restoreInlineProperty(occluder.element, MASK_POSITION_PROPERTY, occluder.previousPosition)
  restoreInlineProperty(occluder.element, MASK_SIZE_PROPERTY, occluder.previousSize)
  occluder.active = false
}

function collectAncestors(anchor: HTMLElement): HTMLElement[] {
  const elements: HTMLElement[] = []
  for (let element = anchor.parentElement; element; element = element.parentElement) {
    elements.push(element)
  }
  return elements
}

function removeOrphanedSurfaceNodes(): void {
  for (const orphan of document.querySelectorAll('[data-tauri-native-video-backdrop]')) orphan.remove()
  for (const orphan of document.querySelectorAll('[data-tauri-native-video-hole]')) {
    orphan.removeAttribute('data-tauri-native-video-hole')
  }
}

function holeStyle(owner: string): string {
  return `
    [data-tauri-native-video-hole="${owner}"] { background: transparent !important; }
    body[data-tauri-native-video-hole="${owner}"] { position: relative !important; isolation: isolate !important; }
    [${OCCLUDER_ATTRIBUTE}="${owner}"] {
      -webkit-mask-image: var(${MASK_IMAGE_PROPERTY}) !important;
      -webkit-mask-position: var(${MASK_POSITION_PROPERTY}) !important;
      -webkit-mask-size: var(${MASK_SIZE_PROPERTY}) !important;
      -webkit-mask-repeat: no-repeat !important;
      -webkit-mask-origin: border-box !important;
      -webkit-mask-clip: border-box !important;
      -webkit-mask-composite: source-over !important;
      mask-image: var(${MASK_IMAGE_PROPERTY}) !important;
      mask-position: var(${MASK_POSITION_PROPERTY}) !important;
      mask-size: var(${MASK_SIZE_PROPERTY}) !important;
      mask-repeat: no-repeat !important;
      mask-origin: border-box !important;
      mask-clip: border-box !important;
      mask-composite: add !important;
      mask-mode: alpha !important;
    }
  `
}

function rectFrom(rect: DOMRect | DOMRectReadOnly): Rect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

function readCornerRadiusStyles(
  element: HTMLElement,
  computed = getComputedStyle(element),
): CornerRadiusStyles {
  return [
    computed.borderTopLeftRadius,
    computed.borderTopRightRadius,
    computed.borderBottomRightRadius,
    computed.borderBottomLeftRadius,
  ]
}

function stylesheetMutation(record: MutationRecord): boolean {
  if (record.target instanceof HTMLStyleElement) return true
  return someChangedNode(record, (node) => (
    node instanceof HTMLStyleElement
    || (node instanceof HTMLLinkElement && node.rel === 'stylesheet')
  ))
}

function structuralMutation(record: MutationRecord, state: NativeCssSurfaceState): boolean {
  if (record.type !== 'childList') return false
  if (record.target instanceof HTMLElement && state.protectedElements.has(record.target)) return true
  return someChangedNode(record, (node) => (
    node === state.anchor
    || (node instanceof Element && (
      node.contains(state.anchor)
      || node.matches(`[${VIDEO_CONTROLS_ATTRIBUTE}]`)
      || Boolean(node.querySelector(`[${VIDEO_CONTROLS_ATTRIBUTE}]`))
    ))
  ))
}

function nativeCoordinateMutation(record: MutationRecord): boolean {
  if (record.target !== document.documentElement || record.attributeName !== 'style') return false
  return withoutNativeCoordinates(record.oldValue ?? '')
    === withoutNativeCoordinates(document.documentElement.getAttribute('style') ?? '')
}

function withoutNativeCoordinates(style: string): string {
  return style
    .replace(/--tauri-native-video-(?:left|top|right|bottom|width|height)\s*:[^;]*(?:;|$)/gi, '')
    .replace(/\s+/g, '')
}

function mutationContains(record: MutationRecord, anchor: HTMLElement): boolean {
  if (record.target instanceof Node && record.target.contains(anchor)) return true
  return someChangedNode(record, (node) => (
    node === anchor || (node instanceof Node && node.contains(anchor))
  ))
}

function someChangedNode(record: MutationRecord, predicate: (node: Node) => boolean): boolean {
  for (const node of record.addedNodes) if (predicate(node)) return true
  for (const node of record.removedNodes) if (predicate(node)) return true
  return false
}

function setStyle(element: HTMLElement, property: string, value: string): void {
  let values = committedStyleValues.get(element)
  if (!values) {
    values = new Map()
    committedStyleValues.set(element, values)
  }
  if (values.get(property) === value) return
  if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value)
  values.set(property, value)
}

function setProperty(element: HTMLElement, property: string, value: string, priority = ''): void {
  if (element.style.getPropertyValue(property) !== value
    || (priority && element.style.getPropertyPriority(property) !== priority)) {
    element.style.setProperty(property, value, priority)
  }
}

function inlineProperty(element: HTMLElement, property: string): InlinePropertySnapshot {
  return {
    value: element.style.getPropertyValue(property),
    priority: element.style.getPropertyPriority(property),
  }
}

function restoreInlineProperty(
  element: HTMLElement,
  property: string,
  snapshot: InlinePropertySnapshot,
): void {
  if (snapshot.value) element.style.setProperty(property, snapshot.value, snapshot.priority)
  else element.style.removeProperty(property)
}

function ancestorClip(
  rect: Rect,
  ancestor: DrilledAncestor,
): VisibleSurfaceBounds | undefined {
  if (!ancestor.clipsX && !ancestor.clipsY) return undefined
  return {
    left: ancestor.clipsX ? rect.left + ancestor.borderLeft : Number.NEGATIVE_INFINITY,
    top: ancestor.clipsY ? rect.top + ancestor.borderTop : Number.NEGATIVE_INFINITY,
    right: ancestor.clipsX
      ? rect.left + rect.width - ancestor.borderRight
      : Number.POSITIVE_INFINITY,
    bottom: ancestor.clipsY
      ? rect.top + rect.height - ancestor.borderBottom
      : Number.POSITIVE_INFINITY,
  }
}

function innerCornerRadii(ancestor: DrilledAncestor, rect: Rect): CornerRadii {
  if (!ancestor.clipsX || !ancestor.clipsY) return ZERO_RADII
  const radii = parseCornerRadii(ancestor.radii, {
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
  })
  return [
    subtractRadius(radii[0], ancestor.borderLeft, ancestor.borderTop),
    subtractRadius(radii[1], ancestor.borderRight, ancestor.borderTop),
    subtractRadius(radii[2], ancestor.borderRight, ancestor.borderBottom),
    subtractRadius(radii[3], ancestor.borderLeft, ancestor.borderBottom),
  ]
}

function clipsOverflow(value: string): boolean {
  return value === 'hidden' || value === 'clip' || value === 'scroll' || value === 'auto'
}

function hasVisibleBackground(computed: CSSStyleDeclaration): boolean {
  const image = computed.backgroundImage.trim()
  if (image && image !== 'none') return true
  const color = computed.backgroundColor.trim().toLowerCase()
  if (!color || color === 'transparent') return false
  if (/\/\s*0(?:\.0+)?\s*\)$/.test(color)) return false
  if (/rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(color)) return false
  return true
}

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const NATIVE_VIDEO_CSS_PROPERTIES = [
  '--tauri-native-video-left',
  '--tauri-native-video-top',
  '--tauri-native-video-right',
  '--tauri-native-video-bottom',
  '--tauri-native-video-width',
  '--tauri-native-video-height',
] as const

const committedStyleValues = new WeakMap<HTMLElement, Map<string, string>>()
const OCCLUDER_ATTRIBUTE = 'data-tauri-native-video-occluder'
const MASK_IMAGE_PROPERTY = '--tauri-native-video-mask-image'
const MASK_POSITION_PROPERTY = '--tauri-native-video-mask-position'
const MASK_SIZE_PROPERTY = '--tauri-native-video-mask-size'
