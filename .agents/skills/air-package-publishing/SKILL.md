---
name: air-package-publishing
description: >-
  Prepares, publishes, and verifies lockstep @get-air/video-tauri and
  tauri-plugin-video releases.
version: 1.1.0
---

# Publishing the Air Tauri video pair

Use this skill for version preparation, release workflow changes, GitHub
Releases, npm/crates.io publication, provenance verification, or credential
cleanup.

## Release boundary

- `@get-air/video-tauri` and `tauri-plugin-video` are one lockstep release unit.
- `@get-air/video` is independent. Its declared peer range, exact tested dev
  version, and `VERSIONING.md` table are authoritative.
- Publish and verify a newly required core version before refreshing this
  repository's root and example lockfiles.
- Never release from an unexplained dirty tree or stale npm/crate archive.

## Required gates

1. Update npm and Cargo manifests/root locks, the JS diagnostic package
   version, changelog entry, and compatibility table together.
2. Run `npm run check:release -- --tag vX.Y.Z`. It must prove lockstep,
   required-peer bounds, exact core test version, and JS↔Rust protocol parity.
3. Run TypeScript/Effect diagnostics, tests, build, packed entrypoint checks,
   bundle-boundary scans, audits, and both registry-backed example builds.
4. Run Rust formatting, no-default/all-feature tests, strict clippy, package
   verification, and target dependency-graph checks.
5. Exercise affected workflows with `act`, push the exact clean commit, and
   wait for hosted Linux and Windows CI.
6. Create one stable `vX.Y.Z` GitHub Release only after those gates pass.

The npm and crates.io workflows independently validate the same release and
publish immutable artifacts. Never retry an ambiguous upload before querying
the registry.

## Authentication and verification

- Steady-state npm and crates.io releases use GitHub OIDC. Do not add
  `NPM_TOKEN`, `NODE_AUTH_TOKEN`, local `.env` tokens, or long-lived GitHub
  secrets. The crates.io job may expose only the OIDC action's short-lived
  output as `CARGO_REGISTRY_TOKEN` for its `cargo publish` step.
- Verify npm `latest`, `gitHead`, integrity, attestations, and signatures.
- Verify crates.io metadata and the downloaded crate checksum.
- Confirm the GitHub tag, hosted runs, npm artifact, and crate all identify the
  same source/version before declaring the release complete.

## Maintenance

This is the clone-safe, repository-specific projection of the organizational
`air-package-publishing` skill, upstream version 1.1.0. Review it whenever the
upstream npm, crates.io, verification, or Air-video compatibility policy
changes.
