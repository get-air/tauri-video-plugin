import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const errors = []
const corePackageName = '@get-air/video'

const prereleaseIdentifier = String.raw`(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`
const semver = new RegExp(
  String.raw`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-${prereleaseIdentifier}(?:\.${prereleaseIdentifier})*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`,
)

const parseSemver = (value) => {
  if (typeof value !== 'string' || !semver.test(value)) return undefined

  const withoutBuild = value.split('+', 1)[0]
  const prereleaseStart = withoutBuild.indexOf('-')
  const core = prereleaseStart === -1
    ? withoutBuild
    : withoutBuild.slice(0, prereleaseStart)
  const prerelease = prereleaseStart === -1
    ? []
    : withoutBuild.slice(prereleaseStart + 1).split('.')
  const [major, minor, patch] = core.split('.').map(Number)

  return { major, minor, patch, prerelease }
}

const compareSemver = (left, right) => {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }

  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0
    return left.prerelease.length === 0 ? 1 : -1
  }

  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === undefined ? -1 : 1
    }
    if (leftPart === rightPart) continue

    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

const hasOwn = (record, key) => Object.prototype.hasOwnProperty.call(record ?? {}, key)
const markdownValue = (value) => value.trim().replace(/^`([^`]+)`$/, '$1')
const stableJson = (value) => JSON.stringify(value, (_key, child) => {
  if (child === null || Array.isArray(child) || typeof child !== 'object') return child
  return Object.fromEntries(Object.entries(child).sort(([left], [right]) => left.localeCompare(right)))
})

const readText = (path) => readFileSync(resolve(root, path), 'utf8')

const readJson = (path) => {
  try {
    return JSON.parse(readText(path))
  } catch (error) {
    console.error(`Unable to read ${path}: ${error.message}`)
    process.exit(1)
  }
}

const checkLocalDependencies = (manifest, label, allowed = {}) => {
  for (const section of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
      if (typeof specifier !== 'string' || !/^(?:file:|link:|workspace:)/.test(specifier)) continue
      if (allowed[name] === specifier) continue
      errors.push(`${label} has forbidden local ${section} entry ${name}: ${specifier}`)
    }
  }
}

const tomlString = (source, key) => {
  const match = source.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm'))
  return match?.[1]
}

const tomlTable = (source, table) => {
  const lines = source.split(/\r?\n/)
  const header = `[${table}]`
  const start = lines.findIndex((line) => line.trim() === header)
  if (start === -1) return undefined

  const body = []
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break
    body.push(line)
  }
  return body.join('\n')
}

const args = process.argv.slice(2)
let expectedTag
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--tag' && args[index + 1]) {
    expectedTag = args[index + 1]
    index += 1
  } else {
    errors.push(`Unknown or incomplete argument: ${args[index]}`)
  }
}

const packageJson = readJson('package.json')
const packageLock = readJson('package-lock.json')
const tauriExample = readJson('examples/tauri-app/package.json')
const blitsExample = readJson('examples/blits-app/package.json')
const tauriExampleLock = readJson('examples/tauri-app/package-lock.json')
const blitsExampleLock = readJson('examples/blits-app/package-lock.json')
const cargoTomlText = readText('Cargo.toml')
const cargoLockText = readText('Cargo.lock')
const tauriExampleCargoLock = readText('examples/tauri-app/src-tauri/Cargo.lock')
const blitsExampleCargoLock = readText('examples/blits-app/src-tauri/Cargo.lock')
const changelog = readText('CHANGELOG.md')
const protocol = readText('guest-js/protocol.ts')
const rustModels = readText('src/models.rs')
const versioning = readText('VERSIONING.md')

checkLocalDependencies(packageJson, 'package.json')
checkLocalDependencies(tauriExample, 'examples/tauri-app/package.json', {
  '@get-air/video-tauri': 'file:../..',
})
checkLocalDependencies(blitsExample, 'examples/blits-app/package.json', {
  '@get-air/video-tauri': 'file:../..',
})

const cargoPackage = tomlTable(cargoTomlText, 'package')
const cargoName = cargoPackage && tomlString(cargoPackage, 'name')
const cargoVersion = cargoPackage && tomlString(cargoPackage, 'version')

const parseCargoLockPackages = (source) => source
  .split(/^\s*\[\[package\]\]\s*$/m)
  .slice(1)
  .map((block) => ({
    name: tomlString(block, 'name'),
    version: tomlString(block, 'version'),
    source: tomlString(block, 'source'),
  }))

const rootCargoPackages = parseCargoLockPackages(cargoLockText).filter(
  (entry) => entry.name === cargoName && entry.source === undefined,
)

if (packageJson.name !== '@get-air/video-tauri') {
  errors.push(`package.json name must be @get-air/video-tauri, found ${packageJson.name}`)
}
if (packageLock.name !== packageJson.name) {
  errors.push(`package-lock.json name ${packageLock.name} does not match package.json name ${packageJson.name}`)
}
if (packageLock.packages?.['']?.name !== packageJson.name) {
  errors.push('package-lock.json root package name does not match package.json')
}
if (cargoName !== 'tauri-plugin-video') {
  errors.push(`Cargo.toml package name must be tauri-plugin-video, found ${cargoName}`)
}
if (rootCargoPackages.length !== 1) {
  errors.push(`Cargo.lock must contain exactly one root tauri-plugin-video package, found ${rootCargoPackages.length}`)
}

const lockRoot = packageLock.packages?.['']
const packagePeerRange = packageJson.peerDependencies?.[corePackageName]
const lockPeerRange = lockRoot?.peerDependencies?.[corePackageName]
const packageDevVersion = packageJson.devDependencies?.[corePackageName]
const lockDevVersion = lockRoot?.devDependencies?.[corePackageName]

const linkedManifestFields = [
  'name',
  'version',
  'license',
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'engines',
]
const checkNpmExample = (label, manifest, lock) => {
  const rootEntry = lock.packages?.['']
  const linkedAdapter = lock.packages?.['../..']
  const adapterLink = lock.packages?.['node_modules/@get-air/video-tauri']
  const expectedCoreRange = `^${packageDevVersion}`

  if (manifest.dependencies?.[corePackageName] !== expectedCoreRange) {
    errors.push(`${label}/package.json must depend on ${corePackageName} ${expectedCoreRange}`)
  }
  for (const dependency of [corePackageName, '@get-air/video-tauri']) {
    if (rootEntry?.dependencies?.[dependency] !== manifest.dependencies?.[dependency]) {
      errors.push(`${label}/package-lock.json root ${dependency} does not match package.json`)
    }
  }
  if (adapterLink?.link !== true || adapterLink?.resolved !== '../..') {
    errors.push(`${label}/package-lock.json does not link @get-air/video-tauri to ../..`)
  }
  if (lock.packages?.[`node_modules/${corePackageName}`]?.version !== packageDevVersion) {
    errors.push(`${label}/package-lock.json does not install tested core ${packageDevVersion}`)
  }
  for (const field of linkedManifestFields) {
    if (stableJson(linkedAdapter?.[field]) !== stableJson(packageJson[field])) {
      errors.push(`${label}/package-lock.json has stale linked-adapter ${field} metadata`)
    }
  }
}

checkNpmExample('examples/tauri-app', tauriExample, tauriExampleLock)
checkNpmExample('examples/blits-app', blitsExample, blitsExampleLock)

for (const [label, source] of [
  ['examples/tauri-app/src-tauri/Cargo.lock', tauriExampleCargoLock],
  ['examples/blits-app/src-tauri/Cargo.lock', blitsExampleCargoLock],
]) {
  const packages = parseCargoLockPackages(source).filter(
    (entry) => entry.name === cargoName && entry.source === undefined,
  )
  if (packages.length !== 1 || packages[0]?.version !== cargoVersion) {
    errors.push(`${label} must contain exactly one local ${cargoName}@${cargoVersion}`)
  }
}

if (hasOwn(packageJson.dependencies, corePackageName)) {
  errors.push(`${corePackageName} must not be a normal dependency in package.json`)
}
if (hasOwn(lockRoot?.dependencies, corePackageName)) {
  errors.push(`${corePackageName} must not be a normal dependency in the package-lock.json root package`)
}
if (typeof packagePeerRange !== 'string') {
  errors.push(`${corePackageName} must be a required peerDependency in package.json`)
}
if (lockPeerRange !== packagePeerRange) {
  errors.push(`package-lock.json peer range ${lockPeerRange} does not match package.json peer range ${packagePeerRange}`)
}
if (packageJson.peerDependenciesMeta?.[corePackageName]?.optional === true) {
  errors.push(`${corePackageName} must not be an optional peer in package.json`)
}
if (lockRoot?.peerDependenciesMeta?.[corePackageName]?.optional === true) {
  errors.push(`${corePackageName} must not be an optional peer in package-lock.json`)
}
if (lockDevVersion !== packageDevVersion) {
  errors.push(`package-lock.json dev version ${lockDevVersion} does not match package.json dev version ${packageDevVersion}`)
}
if (packageLock.packages?.[`node_modules/${corePackageName}`]?.version !== packageDevVersion) {
  errors.push(`package-lock.json installed ${corePackageName} version does not match the exact devDependency ${packageDevVersion}`)
}

let peerLower
let peerUpper
if (typeof packagePeerRange === 'string') {
  const boundedRange = packagePeerRange.match(/^>=(\S+) <(\S+)$/)
  if (boundedRange === null) {
    errors.push(`${corePackageName} peer range must use the explicit bounded form ">=LOWER <UPPER", found ${packagePeerRange}`)
  } else {
    peerLower = parseSemver(boundedRange[1])
    peerUpper = parseSemver(boundedRange[2])
    if (peerLower === undefined || peerUpper === undefined) {
      errors.push(`${corePackageName} peer range bounds must be valid SemVer versions, found ${packagePeerRange}`)
    } else if (compareSemver(peerLower, peerUpper) >= 0) {
      errors.push(`${corePackageName} peer range lower bound must be less than its upper bound, found ${packagePeerRange}`)
    }
  }
}

const parsedDevVersion = parseSemver(packageDevVersion)
if (parsedDevVersion === undefined) {
  errors.push(`${corePackageName} devDependency must be one exact SemVer version, found ${packageDevVersion}`)
} else if (
  peerLower !== undefined
  && peerUpper !== undefined
  && (compareSemver(parsedDevVersion, peerLower) < 0 || compareSemver(parsedDevVersion, peerUpper) >= 0)
) {
  errors.push(`${corePackageName} devDependency ${packageDevVersion} is outside peer range ${packagePeerRange}`)
}

const protocolPackageVersion = protocol.match(
  /^export const TAURI_VIDEO_PACKAGE_VERSION\s*=\s*['"]([^'"]+)['"]\s+as const\s*$/m,
)?.[1]
const protocolVersionSource = protocol.match(
  /^export const TAURI_VIDEO_PROTOCOL_VERSION\s*=\s*(\d+)\s+as const\s*$/m,
)?.[1]
const protocolVersion = protocolVersionSource === undefined
  ? undefined
  : Number(protocolVersionSource)
const rustProtocolVersionSource = rustModels.match(
  /^pub const VIDEO_PLUGIN_PROTOCOL_VERSION:\s*u32\s*=\s*(\d+);\s*$/m,
)?.[1]
const rustProtocolVersion = rustProtocolVersionSource === undefined
  ? undefined
  : Number(rustProtocolVersionSource)

if (protocolVersion === undefined) {
  errors.push('TAURI_VIDEO_PROTOCOL_VERSION must be an integer literal')
}
if (rustProtocolVersion === undefined) {
  errors.push('VIDEO_PLUGIN_PROTOCOL_VERSION must be a u32 integer literal')
} else if (protocolVersion !== undefined && rustProtocolVersion !== protocolVersion) {
  errors.push(`Rust protocol ${rustProtocolVersion} does not match JavaScript protocol ${protocolVersion}`)
}

const versions = [
  ['package.json', packageJson.version],
  ['package-lock.json top level', packageLock.version],
  ['package-lock.json root package', packageLock.packages?.['']?.version],
  ['Cargo.toml package', cargoVersion],
  ['Cargo.lock root package', rootCargoPackages[0]?.version],
  ['guest-js/protocol.ts package diagnostic', protocolPackageVersion],
]

if (typeof packageJson.version !== 'string' || !semver.test(packageJson.version)) {
  errors.push(`package.json version is not valid SemVer: ${packageJson.version}`)
}

for (const [label, version] of versions) {
  if (typeof version !== 'string') {
    errors.push(`${label} version is missing`)
  } else if (version !== packageJson.version) {
    errors.push(`${label} version ${version} does not match package.json version ${packageJson.version}`)
  }
}

if (typeof packageJson.version === 'string') {
  const changelogHeading = `## ${packageJson.version}`
  const matchingHeadings = changelog
    .split(/\r?\n/)
    .filter((line) => line.replace(/[ \t]+$/, '') === changelogHeading)

  if (matchingHeadings.length !== 1) {
    errors.push(`CHANGELOG.md must contain exactly one "${changelogHeading}" heading, found ${matchingHeadings.length}`)
  }

  if (expectedTag !== undefined && expectedTag !== `v${packageJson.version}`) {
    errors.push(`release tag ${expectedTag} does not match v${packageJson.version}`)
  }

  const parsedPackageVersion = parseSemver(packageJson.version)
  if (parsedPackageVersion !== undefined) {
    const compatibilityLine = `${parsedPackageVersion.major}.${parsedPackageVersion.minor}.x`
    const compatibilityRows = versioning
      .split(/\r?\n/)
      .filter((line) => line.trimStart().startsWith('|'))
      .map((line) => line.split('|').slice(1, -1).map(markdownValue))
      .filter((cells) => cells[0] === compatibilityLine)

    if (compatibilityRows.length !== 1) {
      errors.push(`VERSIONING.md must contain exactly one compatibility row for ${compatibilityLine}, found ${compatibilityRows.length}`)
    } else {
      const [releaseLine, documentedPeerRange, documentedProtocol] = compatibilityRows[0]
      if (documentedPeerRange !== packagePeerRange) {
        errors.push(`VERSIONING.md ${releaseLine} core range ${documentedPeerRange} does not match peer range ${packagePeerRange}`)
      }
      if (protocolVersion !== undefined && documentedProtocol !== String(protocolVersion)) {
        errors.push(`VERSIONING.md ${releaseLine} protocol ${documentedProtocol} does not match TAURI_VIDEO_PROTOCOL_VERSION ${protocolVersion}`)
      }
    }
  }
}

if (errors.length > 0) {
  console.error('Release metadata is inconsistent:')
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(`Release metadata is consistent for @get-air/video-tauri and tauri-plugin-video ${packageJson.version}.`)
if (expectedTag !== undefined) console.log(`Release tag ${expectedTag} is valid.`)
