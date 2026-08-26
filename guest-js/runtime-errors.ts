export interface TaggedNativeVideoError extends Error {
  readonly _tag: string
}

export interface ProtocolMismatchDetails {
  readonly expectedProtocolVersion: number
  readonly actualProtocolVersion?: number
  readonly packageName: string
  readonly packageVersion: string
  readonly crateName?: string
  readonly crateVersion?: string
  readonly message: string
  readonly cause?: string
}

export interface FeatureUnavailableDetails {
  readonly backend: string
  readonly feature: string
  readonly message: string
}

export interface NativeVideoErrorFactories {
  readonly protocolMismatch: (
    details: ProtocolMismatchDetails,
  ) => Promise<TaggedNativeVideoError>
  readonly featureUnavailable: (
    details: FeatureUnavailableDetails,
  ) => Promise<TaggedNativeVideoError>
}

class LeanNativeVideoError extends Error implements TaggedNativeVideoError {
  readonly _tag: string

  constructor(tag: string, details: ProtocolMismatchDetails | FeatureUnavailableDetails) {
    super(details.message)
    this.name = tag
    this._tag = tag
    Object.assign(this, details)
    Object.defineProperty(this, Symbol.for('@get-air/video/VideoPlayerError'), {
      value: true,
      enumerable: false,
    })
  }
}

let factories: NativeVideoErrorFactories = {
  protocolMismatch: async (details) => new LeanNativeVideoError(
    'VideoNativeProtocolMismatchError',
    details,
  ),
  featureUnavailable: async (details) => new LeanNativeVideoError(
    'VideoFeatureUnavailableError',
    details,
  ),
}

/** @internal Install the schema-backed factories used by the full entrypoint. */
export function configureNativeVideoErrorFactories(
  next: NativeVideoErrorFactories,
): void {
  factories = next
}

export function nativeProtocolMismatchError(
  details: ProtocolMismatchDetails,
): Promise<TaggedNativeVideoError> {
  return factories.protocolMismatch(details)
}

export function nativeFeatureUnavailableError(
  details: FeatureUnavailableDetails,
): Promise<TaggedNativeVideoError> {
  return factories.featureUnavailable(details)
}
