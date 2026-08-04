# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

React and TypeScript developers building Tauri media applications for Windows, Linux, Android mobile, and Android TV. They need native playback performance while retaining HTML/CSS layout, overlays, and application chrome.

## Product Purpose

Provide a publishable Tauri plugin that streams containers and codecs a WebView cannot play directly, including remote MKV sources, without downloading or converting the complete file before playback. Success means playback feels native while the developer-facing API feels like working with an HTML video element.

## Positioning

The plugin keeps decoding and presentation on the platform-native accelerated path while exposing one headless TypeScript controller and optional React controls. The native video surface follows a normal DOM element so arbitrary HTML can be layered above it.

## Operating Context

Developers install the Rust and npm packages, attach playback to a positioned video element or use the headed React component, then control play, pause, seek, volume, fit, zoom, buffering, quality telemetry, and audio/subtitle/video tracks. The example application is both a quick-start and an interactive compatibility demonstration.

## Capabilities and Constraints

- Stream remote media over HTTP and HTTPS with seeking and bounded buffering.
- Prefer hardware decoding and direct native presentation; avoid decoded-frame copies in the normal path.
- Support MP4, WebM, Ogg, MKV, and other containers supported by the active native backend.
- Expose audio, subtitle, and video track selection plus playback and buffer telemetry.
- Keep the headless API platform-neutral while allowing Android, Android TV, Linux, and Windows-specific tuning.
- Android TV controls must use spatial focus navigation and must not seek merely because focus moves left or right.
- The example must not imply that Windows support or package publication is complete before qualification and release actually occur.

## Brand Commitments

The project name is `tauri-plugin-video`. The public presentation is technical, direct, dark-mode-first, and evidence-led. Player controls in the example use an established open-source player UI rather than a bespoke visual design.

## Evidence on Hand

The repository contains the Rust plugin, Android implementation, TypeScript headless API, React headed player, emulator qualification tools, tests, and CI. Public screenshots must be captured from the running implementation. No customer logos, testimonials, or unsupported performance benchmarks are available and none should be invented.

## Product Principles

- Native frames, web composition.
- Stream first; never require whole-file conversion.
- One predictable API across platforms.
- Measured compatibility and performance over claims.
- Headless by default, polished controls when wanted.

## Accessibility & Inclusion

Controls must remain keyboard accessible, expose meaningful names and state, preserve visible focus, honor reduced motion, meet 48 dp touch targets on Android, and remain operable with an Android TV remote.
