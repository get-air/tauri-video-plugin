import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const tsx = new URL(
  process.platform === 'win32' ? '../../../node_modules/.bin/tsx.cmd' : '../../../node_modules/.bin/tsx',
  import.meta.url,
)

if (!existsSync(tsx)) run(['ci'])
run(['run', 'build'])

function run(arguments_) {
  const result = spawnSync(npm, arguments_, {
    cwd: repository,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
