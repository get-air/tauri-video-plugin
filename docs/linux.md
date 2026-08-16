# Linux runtime

Linux playback uses GStreamer by default and can optionally use libmpv. Both render through a native GTK GPU widget below the transparent WebView. The plugin installs a `GtkOverlay` around Tauri's original window child so the video can follow the HTML anchor while normal DOM controls remain above it. Decoded frames never cross into JavaScript or canvas.

## Optional libmpv backend

Enable `mpv-runtime` and provide the system libmpv development package at build
time:

```toml
tauri-plugin-video = { version = "0.1", features = ["mpv-runtime"] }
```

```ts
import { createTauriVideoClient } from '@get-air/video-tauri'

const client = createTauriVideoClient()
const player = await client.attach(video, {
  source: { uri, headers, cookies, userAgent, referrer },
  backend: 'tauri',
  backendOptions: { tauri: { engine: 'mpv' } },
})
```

The implementation uses libmpv's render API with `GtkGLArea` and its currently
bound framebuffer. Frames remain on the native OpenGL path; the plugin does not
read pixels back into Rust or JavaScript. Render notifications are coalesced in
a one-item main-context channel so decoder callbacks cannot flood GTK. Position,
duration, cache end, tracks, selected streams, frame drops, hardware decoder,
seeking, and volume are translated into the same controller model as GStreamer.
mpv also implements all three common fit modes and video zoom. GStreamer's GTK
sink safely supports `fit` and `stretch`, but not crop-to-cover or arbitrary
zoom, so its controller reports `videoFit: false` and `videoZoom: false` and
rejects those unsupported operations.

The Tauri adapter's `engine: 'auto'` selects GStreamer on Linux. libmpv is an
explicit alternative, and requesting it without `mpv-runtime` returns an
actionable runtime error.

## Buffering and memory

Both native Linux backends keep their own buffering defaults unless the
application supplies an override. Configure either backend through the same API:

```ts
await client.attach(video, {
  source: uri,
  backend: 'tauri',
  backendOptions: {
    tauri: {
      engine: 'gstreamer', // or 'mpv'
      linux: {
        buffer: { maxSeconds: 15, maxBytes: 64 * 1024 * 1024 },
      },
    },
  },
})
```

On Linux, only `maxSeconds` and `maxBytes` are used. `minSeconds`,
`playSeconds`, and `rebufferSeconds` configure Android Media3 and do not change
either Linux backend.

GStreamer clamps the duration to 3-120 seconds and the byte target between
4 MiB and 2,147,483,647 bytes when provided. Omitted values leave `playbin3`'s
`buffer-duration` and `buffer-size` untouched. Buffering messages temporarily put
the pipeline in `PAUSED` until the backend's target is full, while preserving
whether the caller actually requested play or pause.

mpv clamps an explicit duration to 3-120 seconds and an explicit aggregate
packet-cache target to at least 8 MiB. When `maxBytes` is provided, one quarter
(up to 16 MiB) is assigned to backward packets and the remainder to forward
packets, with cross-cache donation disabled so the requested aggregate remains
predictable. Without overrides, mpv's native cache values and donation behavior
remain intact. They are captured at handle creation so reusing the player after
an explicitly tuned source correctly restores its native defaults.

These values bound encoded source or demuxer packet buffering; they are not
whole-process memory limits. Decoder reference frames, audio/video output
queues, GL textures, subtitle-composition textures, allocator overhead, and the
WebView remain outside the byte target. GStreamer's `encodedBytesBuffered`
snapshot is an estimate only when an explicit byte target exists; it reports
zero when the backend owns an unknown automatic target. Measure process RSS/PSS
on deployment hardware before overriding either backend.

## GStreamer 1.26+ subtitle composition

On GStreamer 1.26 and newer, the plugin works around subtitle flicker observed
with overlay metadata reaching `gtkglsink`. It inserts
[`gloverlaycompositor`](https://gstreamer.freedesktop.org/documentation/opengl/gloverlaycompositor.html)
and requires plain RGBA `GLMemory` downstream, which flattens
`GstVideoOverlayCompositionMeta` into the video texture before the GTK sink
draws it. The operation stays on the GL path; it does add a compositor pass and
texture memory outside the encoded-buffer target.

Verify that the OpenGL element from GStreamer Base Plug-ins is installed:

```sh
gst-inspect-1.0 gloverlaycompositor
```

If the element is unavailable, playback falls back to the direct `gtkglsink`
path and logs a warning; video still plays, but subtitles may flicker. GStreamer
versions older than 1.26 keep the direct path.

## Tauri 2.11.4 GTK compatibility

`tauri-runtime-wry` 2.11.4 assumes that the WebView's second GTK ancestor is always a `GtkWindow` and uses an infallible downcast in its pointer and touch resize callbacks. A native overlay adds one legitimate ancestor. Compositors and desktop environments differ in which pointer path they deliver, so the bad assumption may remain hidden on one desktop and abort the process on another. COSMIC exposed it while dragging the window; the same defect can be reached on X11 or Wayland through mouse, pen, or touch input.

Tauri fixed the unsafe downcast upstream in [tauri-apps/tauri#15701](https://github.com/tauri-apps/tauri/pull/15701). Until a crates.io release includes that change, host applications using the Linux native surface should patch the coherent Tauri runtime set:

```toml
[patch.crates-io]
tauri-runtime = { git = "https://github.com/tauri-apps/tauri.git", rev = "5a882eccfda53a189ec076c79c4ad186f50db5ff" }
tauri-runtime-wry = { git = "https://github.com/tauri-apps/tauri.git", rev = "5a882eccfda53a189ec076c79c4ad186f50db5ff" }
tauri-utils = { git = "https://github.com/tauri-apps/tauri.git", rev = "5a882eccfda53a189ec076c79c4ad186f50db5ff" }
```

Pin all three entries to the same revision. Patching only `tauri-runtime-wry` creates two source-distinct copies of the runtime trait and will not compile.

The example keeps native window decorations enabled. This lets the compositor own window movement and edge resizing even though the WebView has an additional overlay ancestor. Frameless applications should use Tauri's explicit `startDragging()` API for drag regions and qualify resize behavior on both X11 and Wayland.

## Opaque application background with an automatic video aperture

The application does not need a transparent page or a transparent Tauri window.
When the native host starts, the plugin makes WebKit's backing layer transparent
at runtime while retaining an opaque native black floor inside the GTK window.
The controller drills only the video aperture; the host does not need a root
component, wrapper class, backdrop stylesheet, or `"transparent": true` window
setting.

When native playback starts, the controller:

1. Finds every DOM ancestor between the video anchor and the document root and temporarily makes only their backgrounds transparent.
2. Reconstructs each solid, gradient, or image background in a non-interactive layer around the video rectangle, preserving its original coordinate system.
3. Snaps the hole to the exact integer coordinates sent to GTK or Android, avoiding fractional one-pixel seams.
4. Intersects the aperture with nested `overflow` scroll/clipping ancestors.
5. Clips unrelated DOM branches where they cross the aperture while preserving registered controls and overlays.
6. Observes ancestor style and structure changes and restores the original DOM attributes when the owning session closes.

The Linux host paints an opaque native black layer below both the video widget
and WebView. GTK allocates that layer with the window itself, so even a delayed
WebKit frame during interactive resize cannot expose the desktop behind the
application.

Layout changes use a two-phase commit. The plugin moves the native surface first and publishes the matching WebView aperture only after the native command succeeds. Rapid scrolling and resizing may briefly retain the previous aligned frame, but they cannot open a hole at coordinates where the native video has not arrived.

The Linux player also keeps one `gtkglsink`, GL context, and GTK widget alive for the application lifetime. Closing a controller parks the pipeline in `READY`; opening another source reconfigures that same pipeline only after it reaches `READY`. This releases the old stream and decoders without destroying a GPU widget that GDK may still be drawing, and it prevents stale position, track, and bus data from leaking into the replacement controller.

The controller still adds `tauri-native-video` to the root and publishes the snapped bounds for applications that want additional effects:

- `--tauri-native-video-left`
- `--tauri-native-video-top`
- `--tauri-native-video-right`
- `--tauri-native-video-bottom`
- `--tauri-native-video-width`
- `--tauri-native-video-height`

CSS controls and overlays remain above the native surface and backdrop. Session ownership prevents cleanup from an old React controller from restoring backgrounds or removing coordinates owned by its replacement.

## Desktop acceptance test

With video actively playing, verify all of the following:

1. Drag the decorated window from each edge and title bar.
2. Resize from every edge and corner while the video surface follows its HTML anchor; newly exposed window area must be black rather than transparent.
3. Enter and leave fullscreen while controls and arbitrary HTML remain above the video.
4. Scroll the document and confirm the native surface remains aligned with the anchor.
5. Repeat with mouse and touch input when available.
6. Repeat on an X11 session and a Wayland session; the process must not panic or abort.

The fix is compositor-independent: unexpected GTK ancestry becomes a normal non-resize event instead of an infallible cast. Desktop-specific testing is still useful for placement, scaling, and input routing.
