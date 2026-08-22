# Native stream lab

The React + TypeScript reference app for `tauri-plugin-video` and
`@get-air/video-tauri`.

It creates a Tauri-enabled `VideoClient`, injects that client into the
platform-neutral `@get-air/video/react` component/API, and combines it with
[Media Chrome](https://github.com/muxinc/media-chrome), native audio/subtitle
selectors, fit and zoom controls, live FPS/buffer telemetry, and a real HTML
image overlay. The source library includes MP4, WebM, Ogg, and a 1.1 GB MKV that
streams over HTTPS ranges.

```sh
npm install
npm run tauri dev
```

The startup command installs the repository-root build dependencies when they
are absent and rebuilds the linked `@get-air/video-tauri` guest adapter before
Vite starts. A clean clone therefore cannot mix an older generated JavaScript
adapter with the current Rust plugin.

Paste any reachable HTTP(S) video URL into the source field or choose a free Sintel sample. Append `?tv=1` (or set `VITE_VIDEO_TV=1`) to use the Android TV player with spatial navigation.

Android project files are generated under `src-tauri/gen/android`. Follow
[`../../docs/android.md`](../../docs/android.md) for Media3 and the optional
explicit LibVLC engine.
