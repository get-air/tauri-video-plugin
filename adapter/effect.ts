import { layerVideoBackends } from '@get-air/video/effect'

import { tauriVideoBackend, type TauriPlaybackOptions } from './index'

export * from '@get-air/video/effect'
export { VideoNativeProtocolMismatchError } from '../guest-js/protocol-error'

export function layerTauriVideoBackend(defaults: TauriPlaybackOptions = {}) {
  return layerVideoBackends([tauriVideoBackend(defaults)])
}

export const TauriVideoBackendLive = layerTauriVideoBackend()
