import { installFrameworkVideoDriver } from '@get-air/video/framework'

import {
  createTauriVideoClient,
  type TauriVideoClientOptions,
} from './index'

export * from '@get-air/video/framework'

/**
 * Route Air framework `<video>` intrinsics through the native Tauri backend.
 *
 * Call the returned cleanup when the Tauri shell is disposed to restore the
 * previously installed framework video driver.
 */
export function installTauriFrameworkVideo(
  options: TauriVideoClientOptions = {},
): () => void {
  return installFrameworkVideoDriver({
    client: createTauriVideoClient(options),
    backend: 'tauri',
  })
}

export type { TauriVideoClientOptions }
