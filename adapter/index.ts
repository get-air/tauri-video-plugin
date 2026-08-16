import type { HttpTransport } from '@get-air/http'
import {
  createVideoClient,
  type AttachVideoOptions,
  type BackendVideoController,
  type VideoBackendAdapter,
  type VideoClient,
  type VideoClientOptions,
  type VideoController,
  type VideoSource,
} from '@get-air/video'

import type { VideoNativeProtocolMismatchError } from '../guest-js/protocol-error'

import {
  attachTauriBackend as attachNativeBackend,
  type AndroidPlaybackOptions as LegacyAndroidPlaybackOptions,
  type LinuxPlaybackOptions as LegacyLinuxPlaybackOptions,
  type NativeAttachVideoOptions,
  type NativeBufferOptions as LegacyNativeBufferOptions,
  type NativeVideoBackend,
  type WindowsPlaybackOptions as LegacyWindowsPlaybackOptions,
} from '../guest-js/index'

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

// These aliases intentionally keep the adapter's native configuration public
// without putting any native concept in @get-air/video.
export type NativeBufferOptions = LegacyNativeBufferOptions
export type AndroidPlaybackOptions = LegacyAndroidPlaybackOptions
export type LinuxPlaybackOptions = LegacyLinuxPlaybackOptions
export type WindowsPlaybackOptions = LegacyWindowsPlaybackOptions
export type { NativeVideoBackend }

export interface TauriPlaybackOptions {
  /** Native engine selected behind the Tauri adapter. */
  engine?: NativeVideoBackend
  android?: AndroidPlaybackOptions
  /** Merged over android when deviceProfile is tv. */
  androidTv?: AndroidPlaybackOptions
  linux?: LinuxPlaybackOptions
  windows?: WindowsPlaybackOptions
}

declare module '@get-air/video' {
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
    autoPriority: 250,
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
  const legacy: NativeAttachVideoOptions = {
    ...options,
    backend: 'tauri',
    nativeBackend: playback.engine ?? 'auto',
    platform: {
      android: playback.android,
      androidTv: playback.androidTv,
      linux: playback.linux,
      windows: playback.windows,
    },
  }
  return attachNativeBackend(element, legacy) as Promise<BackendVideoController>
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
