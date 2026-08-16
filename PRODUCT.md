# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

TypeScript developers building Air-powered Tauri media applications for Linux,
Windows, Android mobile, and Android TV. They need native playback performance
while retaining the shared `@get-air/video` API, DOM layout, overlays, and
application chrome.

## Product Purpose

Provide a publishable Tauri plugin that streams containers and codecs a WebView cannot play directly, including remote MKV sources, without downloading or converting the complete file before playback. Success means playback feels native while the developer-facing API feels like working with an HTML video element.

## Positioning

The plugin keeps decoding and presentation on the platform-native accelerated path while adapting it to the controller contract owned by `@get-air/video`. Framework integrations and headed controls live in that core video package. The native video surface follows a normal DOM element so arbitrary HTML can be layered above it.

## Operating Context

Developers install the Rust plugin and `@get-air/video-tauri` alongside
`@get-air/video`, register the Tauri adapter, and attach playback to a positioned
video element through the shared API. React, Solid, and Blits integrations come
from `@get-air/video`; this repository's examples demonstrate the native adapter
and platform qualification.

## Capabilities and Constraints

- Stream remote media over HTTP and HTTPS with seeking and bounded buffering.
- Prefer hardware decoding and direct native presentation; avoid decoded-frame copies in the normal path.
- Support MP4, WebM, Ogg, MKV, and other containers supported by the active native backend.
- Expose audio, subtitle, and video track selection plus playback and buffer telemetry.
- Keep native tuning inside this adapter while consuming the platform-neutral controller contract from `@get-air/video`.
- Android TV controls must use spatial focus navigation and must not seek merely because focus moves left or right.
- The example must not imply that Windows support or package publication is complete before qualification and release actually occur.

## Brand Commitments

The project is Air's Tauri video adapter, published to npm as
`@get-air/video-tauri` and to crates.io as `tauri-plugin-video`. Its public
presentation is technical, direct, dark-mode-first, and evidence-led.

## Evidence on Hand

The repository contains the Rust plugin, Android implementation, TypeScript
adapter, native examples, qualification tools, tests, and CI. The shared
controller contract and framework players are maintained in the separate
`@get-air/video` repository. Public screenshots must be captured from the running
implementation. No customer logos, testimonials, or unsupported performance
benchmarks are available and none should be invented.

## Product Principles

- Native frames, web composition.
- Stream first; never require whole-file conversion.
- One predictable API across platforms.
- Measured compatibility and performance over claims.
- Lean native adapter by default; polished controls come from `@get-air/video`.

## Accessibility & Inclusion

Examples that consume the core package's controls must remain keyboard accessible,
expose meaningful names and state, preserve visible focus, honor reduced motion,
meet 48 dp touch targets on Android, and remain operable with an Android TV
remote.
