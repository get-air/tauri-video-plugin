# Windows runtime

Windows playback uses GStreamer `playbin3` with `d3d11videosink`. The sink draws
onto a keyed shared D3D11 texture, and a DirectComposition flip-model swapchain
presents that texture under WebView2 on the existing Tauri HWND. Decoded pixels
never cross Tauri IPC or JavaScript. There is no second native video HWND,
popup tool window, base64 serialization, localhost frame bridge, canvas, or
WebGL upload.

The result is one ordinary top-level Tauri window. WebView2 uses its
Window-to-Visual hosting mode, with a CSS aperture over the video visual.
Controls, tooltips, and arbitrary HTML remain in the WebView visual above the
video, while Windows owns dragging, live resize, maximize, fullscreen, and Snap
Layouts atomically.

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

The D3D11 presenter supports `fit`, crop-to-cover, `stretch`, and zoom without
moving decoded pixels through the CPU. Crop-to-cover is negotiated by
GStreamer's `aspectratiocrop`; zoom is a DirectComposition transform.

## Decode and presentation

With a GStreamer D3D11 decoder, decode output remains in `D3D11Memory` through
presentation. `d3d11videosink` renders into the plugin's shared texture and the
presenter issues one GPU `CopyResource` into the composition swapchain. There
is no decoded-frame readback, CPU copy, IPC transfer, or WebView texture upload.

Software decoders such as `avdec_h264`, `vp8dec`, or `theoradec` remain valid;
GStreamer uploads their output at the D3D11 sink boundary. Runtime telemetry
names the decoder that was actually selected rather than claiming hardware
acceleration unconditionally. `decodedFrameCopies` is zero because no decoded
frame crosses the JavaScript/native boundary.

The Windows backend uses the same
`backendOptions.tauri.windows.buffer` opt-in overrides as Linux. Omit them to
leave buffering policy to GStreamer.
