import { invoke } from '@tauri-apps/api/core'
import { markVideoPlayerError } from '@get-air/video'

import type { VideoNativeProtocolMismatchError } from './protocol-error'

const COMMAND = 'plugin:video|'

/**
 * Increment only for a backward-incompatible native command, payload,
 * response, or serialized-error change. Additive diagnostics and capabilities
 * remain compatible at the same protocol version.
 */
export const TAURI_VIDEO_PROTOCOL_VERSION = 1 as const
export const TAURI_VIDEO_PACKAGE_NAME = '@get-air/video-tauri' as const
// Kept explicit so diagnostics work in browsers. A focused test enforces that
// this value cannot drift from package.json during a version bump.
export const TAURI_VIDEO_PACKAGE_VERSION = '0.3.0' as const

export interface NativeVideoPluginDiagnostics {
  readonly protocolVersion: number
  readonly crateName: string
  readonly crateVersion: string
}

export interface TauriVideoDiagnostics extends NativeVideoPluginDiagnostics {
  readonly packageName: typeof TAURI_VIDEO_PACKAGE_NAME
  readonly packageVersion: string
}

export type { VideoNativeProtocolMismatchError }

let verifiedProtocol: Promise<TauriVideoDiagnostics> | undefined

/** Read npm-adapter and native-crate identity without opening a player. */
export async function getTauriVideoDiagnostics(): Promise<TauriVideoDiagnostics> {
  const native = decodeNativeDiagnostics(
    await invoke<unknown>(`${COMMAND}native_diagnostics`),
  )
  return {
    ...native,
    packageName: TAURI_VIDEO_PACKAGE_NAME,
    packageVersion: TAURI_VIDEO_PACKAGE_VERSION,
  }
}

/**
 * Verify the JS/Rust wire contract before any stateful native command runs.
 * Missing diagnostic support identifies an older, incompatible Rust plugin.
 */
export function verifyTauriVideoProtocol(): Promise<TauriVideoDiagnostics> {
  if (verifiedProtocol) return verifiedProtocol

  const attempt = verifyTauriVideoProtocolUncached().catch((error: unknown) => {
    // A transient invoke or startup-order failure must not poison later
    // attachments. Only successful compatibility checks are cached.
    if (verifiedProtocol === attempt) verifiedProtocol = undefined
    throw error
  })
  verifiedProtocol = attempt
  return attempt
}

async function verifyTauriVideoProtocolUncached(): Promise<TauriVideoDiagnostics> {
  let diagnostics: TauriVideoDiagnostics
  try {
    diagnostics = await getTauriVideoDiagnostics()
  } catch (cause) {
    throw await protocolMismatch({
      message: `${TAURI_VIDEO_PACKAGE_NAME}@${TAURI_VIDEO_PACKAGE_VERSION} could not verify the native video protocol. Update @get-air/video-tauri and tauri-plugin-video to a compatible pair.`,
      cause: errorMessage(cause),
    })
  }

  if (diagnostics.protocolVersion !== TAURI_VIDEO_PROTOCOL_VERSION) {
    throw await protocolMismatch({
      actualProtocolVersion: diagnostics.protocolVersion,
      crateName: diagnostics.crateName,
      crateVersion: diagnostics.crateVersion,
      message: `${TAURI_VIDEO_PACKAGE_NAME}@${TAURI_VIDEO_PACKAGE_VERSION} expects native video protocol ${TAURI_VIDEO_PROTOCOL_VERSION}, but ${diagnostics.crateName}@${diagnostics.crateVersion} reports ${diagnostics.protocolVersion}. Update the npm package and Rust crate to a compatible pair.`,
    })
  }

  return diagnostics
}

/** @internal Test isolation for the module-level successful-handshake cache. */
export function clearVerifiedTauriVideoProtocolForTesting(): void {
  verifiedProtocol = undefined
}

interface ProtocolMismatchDetails {
  readonly actualProtocolVersion?: number
  readonly crateName?: string
  readonly crateVersion?: string
  readonly message: string
  readonly cause?: string
}

async function protocolMismatch(
  details: ProtocolMismatchDetails,
): Promise<VideoNativeProtocolMismatchError> {
  // Keep Effect out of the successful Promise entrypoint. The schema-backed
  // error module is loaded only when compatibility validation fails.
  const { VideoNativeProtocolMismatchError } = await import('./protocol-error')
  return markVideoPlayerError(new VideoNativeProtocolMismatchError({
    expectedProtocolVersion: TAURI_VIDEO_PROTOCOL_VERSION,
    packageName: TAURI_VIDEO_PACKAGE_NAME,
    packageVersion: TAURI_VIDEO_PACKAGE_VERSION,
    ...details,
  }))
}

function decodeNativeDiagnostics(value: unknown): NativeVideoPluginDiagnostics {
  if (!isRecord(value)
    || !Number.isInteger(value.protocolVersion)
    || typeof value.crateName !== 'string'
    || value.crateName.length === 0
    || typeof value.crateVersion !== 'string'
    || value.crateVersion.length === 0) {
    throw new TypeError('native_diagnostics returned an invalid response')
  }
  return {
    protocolVersion: value.protocolVersion as number,
    crateName: value.crateName,
    crateVersion: value.crateVersion,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (isRecord(error) && typeof error.message === 'string') return error.message
  return String(error)
}
