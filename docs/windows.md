# Windows runtime

Windows playback uses GStreamer `playbin3` and WebView2 TextureStream. The
plugin creates a D3D11 device on WebView2's render adapter, negotiates NV12
`D3D11Memory`, and presents a pool of reusable GPU textures as a `MediaStream`
on the application's real HTML `<video>` element.

Video, controls, tooltips, clipping, scrolling, transforms, fullscreen, and
Snap Layouts therefore belong to the same Chromium compositor. Windows has no
second video HWND, transparent aperture, native overlay window, decoded-frame
IPC, canvas, or WebGL upload.

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

TextureStream is currently a WebView2 experimental API. The plugin enables its
`msWebView2TextureStream` browser feature before WebView2 starts and verifies
the COM and JavaScript interfaces before opening playback. Applications should
qualify and pin a WebView2 Fixed Version Runtime for deterministic deployment.

## Decode and presentation

On hardware that exposes GStreamer's D3D11 decoder and video processor, decode,
NV12 conversion, and presentation stay in GPU memory. Each frame performs one
NV12 GPU resource copy into a WebView2-owned pooled texture. There is no decoded
frame readback, CPU pixel copy, or JavaScript binary transfer.

Software decoders such as `avdec_h264`, `vp8dec`, and `theoradec` remain valid.
Their output is converted to NV12 and uploaded once at the D3D11 boundary. This
fallback is intentionally slower than the hardware path; runtime telemetry
names the decoder actually selected instead of claiming acceleration.

The HTML video element handles `fit`, crop-to-cover, `stretch`, and zoom with
normal CSS geometry. Resizing and scrolling do not invoke native layout code or
resize decoded textures. `decodedFrameCopies` remains zero because no decoded
frame crosses the JavaScript/native boundary.

The Windows backend uses the same
`backendOptions.tauri.windows.buffer` opt-in overrides as Linux. Omit them to
leave buffering policy to GStreamer.
