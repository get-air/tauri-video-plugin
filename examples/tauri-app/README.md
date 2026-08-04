# Signal Bench example

Reference Tauri application for `tauri-plugin-video`. It demonstrates a CSS-sized `HTMLVideoElement`, DOM overlays, custom controls, live telemetry, seeking, and track selection.

```sh
npm install
npm run tauri dev
```

The default URL is the public Big Buck Bunny Matroska sample. Paste any reachable HTTP(S) MKV URL into the source field. For local file testing, pass a `file://` URL from a location allowed by the application.

Android project files are generated under `src-tauri/gen/android`. Install the official GStreamer Android SDK and follow the repository's `docs/android.md` before running an Android build.
