import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  resolve: {
    // The local adapter link otherwise creates a second core module graph that
    // real registry consumers do not receive.
    dedupe: ['@get-air/video', 'effect'],
  },
  clearScreen: false,
  server: {
    fs: {
      allow: [fileURLToPath(new URL('../..', import.meta.url))],
    },
    host: host || false,
    port: 1430,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/target/**'],
    },
    hmr: host ? {
      protocol: 'ws',
      host,
      port: 1431,
    } : undefined,
  },
})
