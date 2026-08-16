---
name: effect-best-practices
description: >-
  Applies Air's Effect service, typed-error, lifecycle, and Promise-boundary
  rules to the Tauri adapter.
version: 1.0.0
---

# Effect best practices for the Tauri adapter

Use this skill whenever Effect layers, typed errors, adapter operations, or
Promise/Effect boundaries are designed, implemented, reviewed, or debugged.

## Required architecture

- Keep one Effect implementation. The package root runs it for ordinary
  Promise callers; `/effect` exposes it without a second adapter path.
- Run Effects only at the plain-JavaScript application boundary. Never call
  `Effect.runPromise` or `Effect.runSync` inside services or backend methods.
- Use `Effect.Service` for owned business services and declared dependencies;
  reserve externally provided tags/layers for injected infrastructure.
- Compose top-level layers with `Layer.mergeAll` or `Layer.provideMerge`, not
  deep repeated `Layer.provide` chains.
- Name service operations with `Effect.fn` where practical.

## Errors and IPC lifecycle

- Model distinct public failures with `Schema.TaggedError`, a useful `message`,
  and serializable diagnostics.
- Register adapter errors through core's extension seam. Preserve them through
  attach, fallback, controller operations, and Promise rejection; core must not
  import the adapter.
- Recover with `catchTag`/`catchTags`; do not erase typed errors with generic
  `catchAll`, thrown exceptions, or blanket remapping.
- Keep abort listeners, native sessions, aperture observers, and detached IPC
  tasks scoped and finalized. Destroy must be idempotent and leak-free.
- Protocol mismatch is a typed public failure before native playback opens.
- Use structured `Effect.log` instead of `console.log` in Effect code.

## Boundary rules

- Promise callers receive ordinary values and typed rejected errors, never
  `Effect`, `Option`, or unresolved requirements.
- Keep the native protocol wire data serializable and validate diagnostics at
  the boundary.
- Use the pinned Effect dependency and current official documentation rather
  than assuming API behavior from memory.

## Validation

Run after Effect or error-boundary changes:

```sh
npm run typecheck
npm run check:effect
npm test
```

The Effect language-service diagnostics are a required gate.

## Maintenance

This is a deliberately scoped copy of the organizational
`effect-best-practices` skill, upstream version 1.0.0. When the upstream skill
changes, review this file and the core video copy for relevant updates; avoid
adding unrelated atom, RPC, or application-only guidance.
