# Android and Android TV

The default native engine is Media3: it demuxes the source, MediaCodec decodes it, and
`PlayerView` presents into a direct `SurfaceView`. The Tauri WebView stays above
that surface for controls and HTML overlays.

LibVLC is retained as an explicit engine only:

```ts
import { createTauriVideoClient } from '@get-air/video-tauri'

const client = createTauriVideoClient()
await client.attach(video, {
  source: uri,
  backend: 'tauri',
  backendOptions: { tauri: { engine: 'libvlc' } },
})
```

Media3 errors are returned to the caller. There is no Media3-to-LibVLC startup
timer, codec heuristic, retry loop, or automatic handoff.

## Settings

```ts
await client.attach(video, {
  source: { uri, headers, cookies, userAgent, referrer },
  backend: 'tauri',
  deviceProfile: 'tv',
  backendOptions: {
    tauri: {
      engine: 'media3',
      android: {
        decoderFallback: true,
        dolbyVision: 'hevc-base-layer',
      },
    },
  },
})
```

`decoderFallback` lets Media3 try another installed MediaCodec decoder without
changing playback engines. Dolby Vision profile 7 uses its standards-compliant
HEVC base layer by default because some TV decoders advertise DV support but
render black; use `dolbyVision: 'platform'` to disable that workaround.

When buffer options are omitted, Media3 and LibVLC own their cache behavior.
Explicit values tune the selected engine and are filled on demand.

For a private media PKI, set `TAURI_VIDEO_EXTRA_CA` during the Android build and
use `tlsCaFile: 'bundled'`. Hostname verification remains enabled.

LibVLC materially increases APK size. Publish ABI-specific artifacts and review
its LGPL/source-offer and bundled-codec distribution obligations.
