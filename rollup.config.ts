import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cwd } from 'node:process'

import typescript from '@rollup/plugin-typescript'
import type { RollupOptions } from 'rollup'

interface PackageManifest {
  dependencies?: Record<string, string>
}

const manifest = JSON.parse(
  readFileSync(join(cwd(), 'package.json'), 'utf8'),
) as PackageManifest

const config: RollupOptions = {
  input: {
    index: 'adapter/index.ts',
    native: 'adapter/native.ts',
    effect: 'adapter/effect.ts',
  },
  output: {
    dir: 'dist-js',
    entryFileNames: '[name].js',
    format: 'esm',
    sourcemap: true,
  },
  plugins: [
    typescript({
      declaration: true,
      declarationDir: 'dist-js',
      include: [
        'adapter/**/*.ts',
        'guest-js/index.ts',
        'guest-js/models.ts',
        'guest-js/protocol.ts',
        'guest-js/protocol-error.ts',
        'guest-js/runtime-errors.ts',
        'guest-js/native-surface-layout.ts',
        'guest-js/native-surface-geometry.ts',
        'guest-js/native-surface-compositor.ts',
      ],
      exclude: ['**/*.test.ts'],
    }),
  ],
  external: [
    /^@get-air\/http(?:\/.*)?$/,
    /^@get-air\/video(?:\/.*)?$/,
    /^@tauri-apps\/api(?:\/.*)?$/,
    ...Object.keys(manifest.dependencies ?? {}),
  ],
}

export default config
