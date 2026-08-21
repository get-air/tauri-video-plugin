# Windows runtime

Windows playback uses GStreamer `playbin3` with an `appsink`. Decoded RGBA
frames cross Tauri's raw binary `Channel` and are uploaded to a WebGL texture
inside the existing media-controller DOM. There is no native video HWND,
transparent WebView aperture, popup tool window, base64 serialization, or
localhost frame bridge.

The result is one ordinary opaque Tauri window. Video, controls, tooltips, and
arbitrary HTML participate in the same WebView composition, so Windows owns
dragging, live resize, maximize, fullscreen, and Snap Layouts atomically.

## Development runtime

Install the [official MSVC x86-64 GStreamer package](https://gstreamer.freedesktop.org/download/#windows)
with both runtime and development files. GStreamer 1.28 provides these through
one installer using the `devel` install type. Set
`GSTREAMER_1_0_ROOT_MSVC_X86_64` to the installation root if the installer does
not set it for the build environment.

The default crate features already include `gstreamer-runtime`:

```toml
tauri-plugin-video = { version = "0.3" }
```

`backend: 'tauri'` with `backendOptions.tauri.engine` omitted selects GStreamer
on Windows. Explicit `'gstreamer'` selects the same engine. mpv is not compiled
or selected there.

The WebGL presenter supports `fit`, crop-to-cover, `stretch`, and zoom without
changing the decoded stream.

## Decode and presentation

The sink negotiates system-memory RGBA for the binary frame boundary. When a
D3D11 decoder is available, `d3d11download` accepts its `D3D11Memory` output;
otherwise the same chain accepts normal system-memory output from software
decoders such as `avdec_h264`, `vp8dec`, or `theoradec`. Runtime telemetry names
the selected decoder rather than claiming hardware acceleration unconditionally.

The presenter performs one decoded-frame transfer into the WebView and one
WebGL texture upload. Its appsink queue is bounded to two frames and drops stale
frames instead of building an unbounded latency queue. `decodedFrameCopies`
reports the transported-frame count.

The Windows backend uses the same
`backendOptions.tauri.windows.buffer` opt-in overrides as Linux. Omit them to
leave buffering policy to GStreamer.
