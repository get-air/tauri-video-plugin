import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { cwd } from 'node:process'

import typescript from '@rollup/plugin-typescript'
import type { Plugin, RollupOptions } from 'rollup'

interface PackageManifest {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const manifest = JSON.parse(
  readFileSync(join(cwd(), 'package.json'), 'utf8'),
) as PackageManifest

const cssAsText: Plugin = {
  name: 'css-as-text',
  resolveId(source, importer) {
    if (!importer || !source.endsWith('.css?raw')) return null
    return resolve(dirname(importer), source.slice(0, -4))
  },
  transform(code, id) {
    if (!id.endsWith('.css')) return null
    return { code: `export default ${JSON.stringify(code)}`, map: null }
  },
}

const config: RollupOptions = {
  input: {
    index: 'guest-js/index.ts',
    blits: 'blits/index.ts',
    react: 'react/index.tsx',
  },
  output: [
    {
      dir: 'dist-js',
      entryFileNames: '[name].js',
      format: 'esm',
      sourcemap: true,
    },
    {
      dir: 'dist-js',
      entryFileNames: '[name].cjs',
      format: 'cjs',
      sourcemap: true,
    },
  ],
  plugins: [
    cssAsText,
    typescript({
      declaration: true,
      declarationDir: 'dist-js',
      include: ['guest-js/**/*.ts', 'blits/**/*.ts', 'react/**/*.ts', 'react/**/*.tsx'],
      exclude: ['**/*.test.ts', '**/*.test.tsx'],
    }),
  ],
  external: [
    /^@tauri-apps\/api/,
    /^react(?:\/.*)?$/,
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ],
}

export default config
