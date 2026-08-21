# Windows runtime

Windows playback uses GStreamer with `d3d11videosink`. The sink renders into a
plugin-owned child `HWND`; decoded frames never pass through JavaScript, canvas,
or a localhost bridge. WebView2 does not alpha-compose transparent pixels with
a lower sibling child window, so the video child is kept above WebView2 instead.
Its Win32 window region is clipped to the visible `<video>` aperture and has the
measured HTML control and overlay rectangles subtracted from it. Those holes
keep the WebView controls visible and interactive above the native pixels.

The DOM compositor publishes aperture, overflow clipping, rounded corners, and
registered control geometry. Application code can therefore place the `<video>`
anchor inside ordinary grid, flex, positioned, and scrolling layouts without
manually managing Win32 windows or copying decoded frames.

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

The current D3D11 sink safely supports `fit` and `stretch`, but not the common
API's crop-to-cover mode or arbitrary zoom. The controller therefore reports
`videoFit: false` and `videoZoom: false`; unsupported cover and zoom requests
reject instead of being silently treated as stretch.

## Native layout

The plugin creates one reusable child window and keeps it above WebView2.
Layout updates convert CSS logical pixels to Win32 physical pixels, call
`SetWindowPos`, and atomically replace the child window region. Registered HTML
controls remain WebView-owned and clickable because their rectangles are cut
out of the native region. Paused layout changes also ask GStreamer to expose its
last frame. Closing a controller parks the pipeline, removes the window region,
and hides the child so a later controller can reuse the native surface.

The Windows backend uses the same
`backendOptions.tauri.windows.buffer` opt-in overrides as Linux. Omit them to
leave buffering policy to GStreamer.
