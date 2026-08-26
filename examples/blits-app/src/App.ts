import Blits from '@lightningjs/blits'
import {
  attachCanvasVideo,
  type CanvasVideoController,
  type CanvasVideoRect,
} from '@get-air/video/canvas'
import { createTauriVideoClient } from '@get-air/video-tauri'

const APP_WIDTH = 1920
const APP_HEIGHT = 1080
const VIDEO_RECT: CanvasVideoRect = {
  x: 426,
  y: 164,
  width: 1068,
  height: 600,
}
const VIDEO_SOURCE = import.meta.env.VITE_VIDEO_SOURCE
  || 'https://media.w3.org/2010/05/sintel/trailer.mp4'
const videoClient = createTauriVideoClient({
  playback: { engine: 'gstreamer' },
})
const backgroundShader = JSON.stringify({
  type: 'holePunch',
  x: VIDEO_RECT.x,
  y: VIDEO_RECT.y,
  w: VIDEO_RECT.width,
  h: VIDEO_RECT.height,
  radius: 26,
})
  .replaceAll('"', "'")

let video: CanvasVideoController | undefined
let removeTimeListener: (() => void) | undefined
let removeErrorListener: (() => void) | undefined

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export default Blits.Application({
  template: `
    <Element w="1920" h="1080">
      <Element w="1920" h="1080" color="#07111fff" shader="${backgroundShader}" />

      <Element x="72" y="48" w="10" h="52" color="#55e6c1ff" rounded="5" />
      <Text x="104" y="46" size="42" color="#f4f7fbff" content="NATIVE SIGNAL" />
      <Text x="105" y="96" size="20" color="#8393a7ff" content="BLITS APERTURE DEMO" />
      <Element x="1570" y="54" w="278" h="54" color="#112339ff" rounded="27" />
      <Element x="1592" y="73" w="16" h="16" color="#55e6c1ff" rounded="8" />
      <Text x="1622" y="66" size="22" color="#dce7f4ff" content="NATIVE SURFACE" />

      <Element x="410" y="148" w="1100" h="4" color="#55e6c1ff" />
      <Element x="410" y="776" w="1100" h="4" color="#20364fff" />
      <Element x="410" y="148" w="4" h="632" color="#20364fff" />
      <Element x="1506" y="148" w="4" h="632" color="#20364fff" />

      <Element x="448" y="184" w="188" h="42" color="#07111fcc" rounded="21" />
      <Text x="474" y="192" size="20" color="#f4f7fbff" content="SINTEL · 1080P" />

      <Element x="426" y="674" w="1068" h="90" color="#07111fd9" />
      <Element x="458" y="696" w="820" h="7" color="#52637a99" rounded="4" />
      <Element x="458" y="696" :w="$progressWidth" h="7" color="#55e6c1ff" rounded="4" />
      <Text x="458" y="718" size="22" color="#f4f7fbff" :content="$playing ? '❚❚' : '▶'" />
      <Text x="510" y="716" size="20" color="#dce7f4ff" :content="$timeLabel" />
      <Text x="1338" y="716" size="18" color="#9cacc0ff" content="VIDEO STAYS OUTSIDE WEBGL" />

      <Element x="72" y="830" w="1776" h="178" color="#0d1b2cff" rounded="24" />
      <Text x="108" y="862" size="22" color="#7890aaff" content="REMOTE CONTROLS" />

      <Element x="108" y="910" w="220" h="64" :color="$selected === 0 ? '#55e6c1ff' : '#182c43ff'" rounded="16" />
      <Text x="157" y="926" size="24" :color="$selected === 0 ? '#06121fff' : '#dce7f4ff'" :content="$playing ? 'PAUSE' : 'PLAY'" />

      <Element x="348" y="910" w="220" h="64" :color="$selected === 1 ? '#55e6c1ff' : '#182c43ff'" rounded="16" />
      <Text x="397" y="926" size="24" :color="$selected === 1 ? '#06121fff' : '#dce7f4ff'" content="− 10 SEC" />

      <Element x="588" y="910" w="220" h="64" :color="$selected === 2 ? '#55e6c1ff' : '#182c43ff'" rounded="16" />
      <Text x="637" y="926" size="24" :color="$selected === 2 ? '#06121fff' : '#dce7f4ff'" content="+ 10 SEC" />

      <Text x="880" y="914" size="22" color="#dce7f4ff" :content="$status" />
      <Text x="880" y="950" size="18" color="#7890aaff" content="Left / right to move · Enter to select · Space toggles" />
    </Element>
  `,

  state() {
    return {
      selected: 0,
      playing: false,
      currentTime: 0,
      duration: 0,
      progressWidth: 0,
      timeLabel: '0:00 / 0:00',
      status: 'OPENING NATIVE PIPELINE',
    }
  },

  hooks: {
    ready() {
      this.$focus()
      void this.openVideo()
    },
    destroy() {
      removeTimeListener?.()
      removeErrorListener?.()
      void video?.destroy()
      video = undefined
    },
  },

  input: {
    left() {
      this.selected = Math.max(0, this.selected - 1)
    },
    right() {
      this.selected = Math.min(2, this.selected + 1)
    },
    enter() {
      void this.activate()
    },
    space() {
      void this.togglePlayback()
    },
  },

  methods: {
    async openVideo(): Promise<void> {
      const canvas = document.querySelector<HTMLCanvasElement>('#blits-canvas')
      if (!canvas) throw new Error('Missing #blits-canvas')
      try {
        video = await attachCanvasVideo({
          client: videoClient,
          canvas,
          rect: VIDEO_RECT,
          appWidth: APP_WIDTH,
          appHeight: APP_HEIGHT,
          source: VIDEO_SOURCE,
          backend: 'tauri',
          autoplay: true,
        })
        this.duration = video.media.durationSeconds ?? 0
        this.playing = true
        this.status = 'PLAYING THROUGH THE NATIVE BACKEND'
        this.updateTime(0)
        removeTimeListener = video.on('timeupdate', (event) => {
          this.updateTime(event.detail.currentTime)
        })
        removeErrorListener = video.on('error', (event) => {
          this.status = `ERROR · ${event.detail.message}`
        })
        video.anchor.addEventListener('play', () => { this.playing = true })
        video.anchor.addEventListener('pause', () => { this.playing = false })
      } catch (error) {
        this.status = `ERROR · ${error instanceof Error ? error.message : String(error)}`
      }
    },

    updateTime(seconds: number): void {
      this.currentTime = seconds
      this.duration = video?.media.durationSeconds ?? this.duration
      this.progressWidth = this.duration > 0
        ? Math.min(820, Math.max(0, 820 * seconds / this.duration))
        : 0
      this.timeLabel = `${clock(seconds)} / ${clock(this.duration)}`
    },

    async activate(): Promise<void> {
      if (!video) return
      if (this.selected === 0) await this.togglePlayback()
      if (this.selected === 1) await video.seek(Math.max(0, this.currentTime - 10))
      if (this.selected === 2) await video.seek(Math.min(this.duration, this.currentTime + 10))
    },

    async togglePlayback(): Promise<void> {
      if (!video) return
      if (this.playing) video.pause()
      else await video.play()
    },
  },
})
