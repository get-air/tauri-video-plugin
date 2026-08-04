import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cwd } from 'node:process'
import typescript from '@rollup/plugin-typescript'

const pkg = JSON.parse(readFileSync(join(cwd(), 'package.json'), 'utf8'))

export default {
  input: {
    index: 'guest-js/index.ts',
    react: 'react/index.tsx'
  },
  output: [
    {
      dir: 'dist-js',
      entryFileNames: '[name].js',
      format: 'esm',
      sourcemap: true
    },
    {
      dir: 'dist-js',
      entryFileNames: '[name].cjs',
      format: 'cjs',
      sourcemap: true
    }
  ],
  plugins: [
    typescript({
      declaration: true,
      declarationDir: 'dist-js',
      exclude: ['guest-js/**/*.test.ts']
    })
  ],
  external: [
    /^@tauri-apps\/api/,
    /^react(?:\/.*)?$/,
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.peerDependencies || {})
  ]
}
