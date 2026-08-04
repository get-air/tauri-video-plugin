# tauri-plugin-video

Native video playback for Tauri 2, with normal HTML controls and overlays.

> Developer preview. Linux, Android, and Android TV are working. Windows is not qualified yet.

## What it does

- Streams MKV, WebM, AVI, MPEG-TS, and other containers without downloading the whole file.
- Uses native, hardware-accelerated video surfaces on Linux and Android.
- Keeps video frames out of JavaScript and canvas.
- Supports seeking, buffering, volume, audio tracks, text subtitles, and video tracks.
- Includes a framework-neutral API plus React and Android TV components.

## Install

The npm and crates.io packages are not published yet. After the first release:

```sh
npm install tauri-plugin-video-api
cargo add tauri-plugin-video
```

Register the Rust plugin:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_video::init())
    .run(tauri::generate_context!())?;
```

Add `video:default` to your Tauri capability.

## React

```tsx
import { VideoPlayer } from "tauri-plugin-video-api/react";
import "tauri-plugin-video-api/react/styles.css";

export function Player({ url }: { url: string }) {
  return <VideoPlayer source={url} autoPlay />;
}
```

The player can be sized and positioned with ordinary CSS. HTML children render above the native video surface.

## Headless

```ts
import { attachVideo } from "tauri-plugin-video-api/headless";

const element = document.querySelector("video")!;
const player = await attachVideo(element, { source: movieUrl });

await player.play();
await player.seek(60);
await player.selectTrack("audio", audioTrackId);
```

## Platform paths

| Platform | Playback path |
| --- | --- |
| Android / Android TV | Media3 → MediaCodec → `SurfaceView` |
| Linux | GStreamer → VA-API/GL |
| Windows | Compatibility path only; native D3D11 work remains |

No backend waits for the complete file before playback begins.

See [API documentation](docs/api.md), [Android setup](docs/android.md), and the [qualification report](qualification/REPORT.md).

Licensed under MIT or Apache-2.0.
