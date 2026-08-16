# Windows runtime

Windows playback uses GStreamer with `d3d11videosink`. The sink renders into a
plugin-owned child `HWND` below the WebView; decoded frames never pass through
JavaScript, canvas, or a localhost bridge. The existing DOM compositor opens the
same exact aperture used on Linux, so application code can place the `<video>`
anchor inside ordinary grid, flex, positioned, and scrolling layouts without
manually making page backgrounds transparent.

## Development runtime

Install the [official MSVC x86-64 GStreamer package](https://gstreamer.freedesktop.org/download/#windows)
with both runtime and development files. GStreamer 1.28 provides these through
one installer using the `devel` install type. Set
`GSTREAMER_1_0_ROOT_MSVC_X86_64` to the installation root if the installer does
not set it for the build environment.

The default crate features already include `gstreamer-runtime`:

```toml
tauri-plugin-video = { version = "0.2" }
```

`backend: 'tauri'` with `backendOptions.tauri.engine` omitted or set to
`'auto'` selects GStreamer on Windows. Explicit `'gstreamer'` selects the same
engine. mpv is not compiled or selected there.

The current D3D11 sink safely supports `fit` and `stretch`, but not the common
API's crop-to-cover mode or arbitrary zoom. The controller therefore reports
`videoFit: false` and `videoZoom: false`; unsupported cover and zoom requests
reject instead of being silently treated as stretch.

## Native layout

The plugin creates one reusable child window and keeps it at the bottom of the
Tauri window's child-window z-order. Layout updates convert CSS logical pixels
to Win32 physical pixels using the window DPI and call `SetWindowPos`; paused
layout changes also ask GStreamer to expose its last frame. Closing a controller
parks the pipeline and hides the child window so a later controller can reuse
the native surface.

The Windows backend uses the same
`backendOptions.tauri.windows.buffer` opt-in overrides as Linux. Omit them to
leave buffering policy to GStreamer.
