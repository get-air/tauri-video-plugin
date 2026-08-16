import { rm } from 'node:fs/promises'
import { rollup, type OutputOptions } from 'rollup'

import config from '../rollup.config'

const { output, ...input } = config
const outputs: OutputOptions[] = Array.isArray(output) ? output : output ? [output] : []
await rm('dist-js', { recursive: true, force: true })
const bundle = await rollup(input)

try {
  for (const options of outputs) await bundle.write(options)
} finally {
  await bundle.close()
}

// Remove declarations produced by older build configurations without making
// the live package entrypoints disappear underneath a linked example app.
await Promise.all([
  rm('dist-js/qualification', { recursive: true, force: true }),
  rm('dist-js/scripts', { recursive: true, force: true }),
  rm('dist-js/rollup.config.d.ts', { force: true }),
  rm('dist-js/react/index.test.d.ts', { force: true }),
])
