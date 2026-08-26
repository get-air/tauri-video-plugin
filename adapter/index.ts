import type { HttpTransport } from '@get-air/http'
import {
  createVideoClient,
  markVideoPlayerError,
  type AttachVideoOptions,
  type BackendVideoController,
  type VideoBackendAdapter,
  type VideoClient,
  type VideoClientOptions,
  type VideoController,
  type VideoSource,
} from '@get-air/video'

import type { VideoNativeProtocolMismatchError } from '../guest-js/protocol-error'
import { configureNativeVideoErrorFactories } from '../guest-js/runtime-errors'

import {
  attachTauriBackend as attachNativeBackend,
  type NativeAttachVideoOptions,
  type NativeBufferOptions,
  type TauriPlaybackOptions,
} from '../guest-js/index'

configureNativeVideoErrorFactories({
  protocolMismatch: async (details) => {
    const { VideoNativeProtocolMismatchError } = await import('../guest-js/protocol-error')
    return markVideoPlayerError(new VideoNativeProtocolMismatchError(details))
  },
  featureUnavailable: async (details) => {
    const { VideoFeatureUnavailableError } = await import('@get-air/video/effect')
    return new VideoFeatureUnavailableError(details)
  },
})

export * from '@get-air/video'
export {
  registerVideoControls,
  VIDEO_CONTROLS_ATTRIBUTE,
  type VideoControlsTarget,
} from '../guest-js/native-surface-compositor'
export {
  getTauriVideoDiagnostics,
  TAURI_VIDEO_PACKAGE_NAME,
  TAURI_VIDEO_PACKAGE_VERSION,
  TAURI_VIDEO_PROTOCOL_VERSION,
  verifyTauriVideoProtocol,
  type NativeVideoPluginDiagnostics,
  type TauriVideoDiagnostics,
  type VideoNativeProtocolMismatchError,
} from '../guest-js/protocol'

export type {
  AndroidPlaybackOptions,
  LinuxPlaybackOptions,
  NativeBufferOptions,
  NativeVideoBackend,
  TauriPlaybackOptions,
  WindowsPlaybackOptions,
} from '../guest-js/index'

declare module '@get-air/video' {
  interface MediaInfo {
    seekableStartSeconds?: number
    seekableEndSeconds?: number
  }

  interface VideoBackendOptionsMap {
    tauri: TauriPlaybackOptions
  }

  interface VideoPlayerErrorMap {
    VideoNativeProtocolMismatchError: VideoNativeProtocolMismatchError
  }
}

export interface TauriVideoClientOptions extends VideoClientOptions {
  readonly playback?: TauriPlaybackOptions
}

export function tauriVideoBackend(
  defaults: TauriPlaybackOptions = {},
): VideoBackendAdapter {
  return {
    id: 'tauri',
    isAvailable: ({ userAgent, global }) => hasTauriRuntime(global)
      && /Android|Linux|Windows/i.test(userAgent),
    open: ({ element, options }) => attachTauriBackend(element, options, defaults),
  }
}

/** Create the common Air client with the native Tauri backend installed. */
export function createTauriVideoClient(
  options: TauriVideoClientOptions = {},
): VideoClient {
  const { playback, adapters, ...clientOptions } = options
  return createVideoClient({
    ...clientOptions,
    adapters: [tauriVideoBackend(playback), ...(adapters ?? [])],
  })
}

const defaultTauriVideoClient = createTauriVideoClient()

/** Same Promise API as @get-air/video, with the Tauri adapter installed. */
export function attachVideo(
  element: HTMLVideoElement,
  options: AttachVideoOptions,
): Promise<VideoController> {
  return defaultTauriVideoClient.attach(element, options)
}

export function attachTauriVideo(
  element: HTMLVideoElement,
  options: AttachVideoOptions,
): Promise<VideoController> {
  return defaultTauriVideoClient.attach(element, { ...options, backend: 'tauri' })
}

/** Raw adapter factory for advanced registry/Effect integrations. */
export function attachTauriBackend(
  element: HTMLVideoElement,
  options: AttachVideoOptions,
  defaults: TauriPlaybackOptions = {},
): Promise<BackendVideoController> {
  const playback = mergePlayback(defaults, options.backendOptions?.tauri)
  const nativeOptions: NativeAttachVideoOptions = {
    ...options,
    backend: 'tauri',
    playback,
  }
  return attachNativeBackend(element, nativeOptions)
}

function mergePlayback(
  defaults: TauriPlaybackOptions,
  requested: TauriPlaybackOptions | undefined,
): TauriPlaybackOptions {
  return {
    ...defaults,
    ...requested,
    android: mergePlatformOptions(defaults.android, requested?.android),
    androidTv: mergePlatformOptions(defaults.androidTv, requested?.androidTv),
    linux: mergePlatformOptions(defaults.linux, requested?.linux),
    windows: mergePlatformOptions(defaults.windows, requested?.windows),
  }
}

function mergePlatformOptions<T extends { buffer?: NativeBufferOptions }>(
  defaults: T | undefined,
  requested: T | undefined,
): T | undefined {
  if (!defaults && !requested) return undefined
  return {
    ...defaults,
    ...requested,
    buffer: defaults?.buffer || requested?.buffer
      ? { ...defaults?.buffer, ...requested?.buffer }
      : undefined,
  } as T
}

function hasTauriRuntime(global: typeof globalThis): boolean {
  return '__TAURI_INTERNALS__' in global || '__TAURI__' in global
}

// Keep these public core types visible in generated API documentation without
// creating a second copy of their contracts.
export type { AttachVideoOptions, VideoClient, VideoController, VideoSource, HttpTransport }
