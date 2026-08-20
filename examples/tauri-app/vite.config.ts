import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The adapter is file-linked in this repository's example. Resolve its
    // core dependency exactly as a published, flattened npm install would.
    dedupe: ['@get-air/video', 'effect', 'react', 'react-dom'],
  },
  clearScreen: false,
  server: {
    fs: {
      allow: [fileURLToPath(new URL('../..', import.meta.url))],
    },
    host: host || false,
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/target/**'],
    },
    hmr: host ? {
      protocol: 'ws',
      host,
      port: 1421,
    } : undefined,
  },
})
