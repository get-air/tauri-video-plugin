import {
  NativeSurfaceCompositor,
  registerVideoControls,
} from '../guest-js/native-surface-compositor'
import { snapNativeSurfaceLayout } from '../guest-js/native-surface-layout'

declare global {
  interface Window {
    __TAURI_VIDEO_COMPOSITOR_FIXTURE__: {
      render: () => void
      refresh: () => void
    }
  }
}

const video = document.querySelector<HTMLVideoElement>('#video-anchor')!
const nativeSimulation = document.querySelector<HTMLElement>('#native-simulation')!
const controls = document.querySelector<HTMLElement>('#external-controls')!
const overlay = document.querySelector<HTMLElement>('.overlay-badge')!
const compositor = new NativeSurfaceCompositor('qualification-fixture', video)
registerVideoControls([controls, overlay, nativeSimulation])

function render(): void {
  const rect = video.getBoundingClientRect()
  const layout = snapNativeSurfaceLayout(rect, false, 1)
  const frame = compositor.measure(layout, 1)
  compositor.commit(frame)
  Object.assign(nativeSimulation.style, {
    left: `${frame.bounds.left}px`,
    top: `${frame.bounds.top}px`,
    width: `${frame.bounds.right - frame.bounds.left}px`,
    height: `${frame.bounds.bottom - frame.bounds.top}px`,
  })
}

window.__TAURI_VIDEO_COMPOSITOR_FIXTURE__ = {
  render,
  refresh: () => compositor.refresh(),
}

const resize = new ResizeObserver(render)
resize.observe(video)
compositor.observe((backgroundChanged) => {
  if (backgroundChanged) compositor.refresh()
  requestAnimationFrame(render)
})
window.addEventListener('scroll', render, { capture: true, passive: true })
window.addEventListener('resize', render, { passive: true })
requestAnimationFrame(render)
