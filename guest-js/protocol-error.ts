import { Schema } from 'effect'

/**
 * The installed npm adapter and Rust plugin do not speak the same native IPC
 * protocol. Updating them to a compatible pair is the only recovery.
 */
export class VideoNativeProtocolMismatchError extends Schema.TaggedError<VideoNativeProtocolMismatchError>()(
  'VideoNativeProtocolMismatchError',
  {
    expectedProtocolVersion: Schema.Int,
    actualProtocolVersion: Schema.optional(Schema.Int),
    packageName: Schema.String,
    packageVersion: Schema.String,
    crateName: Schema.optional(Schema.String),
    crateVersion: Schema.optional(Schema.String),
    message: Schema.String,
    cause: Schema.optional(Schema.String),
  },
) {}
