# Solid-TV / Blits native-video example

This app renders every visible control with Blits while the plugin owns a
native GStreamer/mpv/Media3/VLC surface underneath the WebView. The video is
not decoded into a canvas texture.

The full-screen Blits background uses the built-in `holePunch` shader at the
same authored rectangle passed to `attachBlitsVideo`. Text, badges, and the
control strip are then rendered after that background, so they remain normal
Blits UI above the native picture.

```sh
npm install
npm run tauri dev
```

Set `VITE_VIDEO_SOURCE` to try another URL. The default is the W3C Sintel MP4.
