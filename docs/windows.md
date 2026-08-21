# Windows runtime

Windows playback uses GStreamer with `d3d11videosink`. The sink renders into a
plugin-owned, non-activating tool window directly behind the Tauri window;
decoded frames never pass through JavaScript, canvas, or a localhost bridge.
The transparent WebView aperture reveals that lower video window while controls,
tooltips, and arbitrary HTML remain in the Tauri window above it—the same visual
stacking model used on Linux.

The Tauri window that hosts video must be created with `transparent: true` on
Windows. Prefer a `tauri.windows.conf.json` platform override so other desktop
targets keep their existing window configuration. Platform-specific window
arrays replace the base array, so repeat the complete window entry and add:

```json
{
  "app": {
    "windows": [{ "transparent": true }]
  }
}
```

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

The plugin creates one reusable popup tool window and keeps it immediately
behind the Tauri window without activating it or adding a taskbar entry. Layout
updates convert CSS logical pixels to Win32 desktop coordinates and call
`SetWindowPos`. A native subclass follows `WM_WINDOWPOSCHANGED`, DPI, visibility,
activation, minimize, and restore messages on the Tauri UI thread, keeping both
windows aligned during live dragging without a polling delay. Paused layout
changes ask GStreamer to expose its last frame, and closing parks and hides the
reusable surface.

The Windows backend uses the same
`backendOptions.tauri.windows.buffer` opt-in overrides as Linux. Omit them to
leave buffering policy to GStreamer.
