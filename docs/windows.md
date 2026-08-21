# Windows runtime

Windows playback uses GStreamer with `d3d11videosink`. The sink renders into a
plugin-owned child `HWND`; decoded frames never pass through JavaScript, canvas,
or a localhost bridge. WebView2 does not alpha-compose transparent pixels with
a lower sibling child window, so the video child is kept above WebView2 instead.
Its Win32 window region is clipped to the visible `<video>` aperture and has the
same rounded and overflow-clipped geometry as the DOM anchor. The region is
applied to both the plugin host and GStreamer's dynamically created `GSTD3D11`
renderer window after the first presented frame.

Windows hardware flip surfaces cannot reliably interleave WebView pixels inside
the same screen rectangle. Interactive HTML controls must therefore be docked
outside the `<video>` anchor instead of overlaying it. The example reserves a
responsive 16:9 native stage and a separate 80 px WebView transport dock.

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
`SetWindowPos`, and atomically replace both the host and renderer window regions.
Paused layout changes also ask GStreamer to expose its last frame. Closing a
controller parks the pipeline, removes the window regions, and hides the child
so a later controller can reuse the native surface. Keep WebView controls outside
the anchor rectangle so they remain above the native presentation plane.

The Windows backend uses the same
`backendOptions.tauri.windows.buffer` opt-in overrides as Linux. Omit them to
leave buffering policy to GStreamer.
