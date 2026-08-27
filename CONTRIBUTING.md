# Contributing to Air video for Tauri

This standalone repository contains only Air's native Tauri adapter and
plugin. The DOM player and framework integrations live in
[`get-air/video`](https://github.com/get-air/video).

## Set up

Use Node.js 24, the stable Rust toolchain supported by `Cargo.toml`, and frozen
lockfiles:

```sh
npm ci
rustup toolchain install stable
```

Install platform media development packages before native builds; see
[`docs/linux.md`](docs/linux.md), [`docs/windows.md`](docs/windows.md), and
[`docs/android.md`](docs/android.md). Other Air packages must remain published
registry dependencies—never use a parent workspace or cross-repository path.

## Design expectations

- Keep the shared player API and DOM implementations in `@get-air/video`.
- Keep native playback behind the `tauri` backend and its IPC boundary.
- Preserve native-surface geometry, cleanup, typed unsupported errors, and
  truthful engine capabilities.
- Keep Android free of desktop GIO/GStreamer/GTK/mpv dependencies and keep
  desktop dependencies target-scoped.
- Implement Effect and Promise surfaces through one implementation, following
  `AGENTS.md` and the local Effect skill.
- Treat incompatible command, payload, response, or cross-boundary error
  changes as protocol changes. Additive diagnostics use capabilities instead.

## Validate a change

Run the applicable focused test first, then the portable JavaScript gates:

```sh
npm run check:release
npm run check
npm run build
npm pack --dry-run --ignore-scripts
npm ci --prefix examples/tauri-app
npm run build --prefix examples/tauri-app
```

With the native dependencies for your platform installed, run:

```sh
cargo fmt --all -- --check
cargo test --locked --all-targets --no-default-features
cargo test --locked --all-targets --all-features
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo package --locked
```

Exercise affected workflows locally with `act`; the common entrypoint is:

```sh
npm run ci:act
```

Hosted Linux, Windows, and target-device qualification remain authoritative
where the local machine cannot reproduce a platform.

## Versioning and releases

Read [`VERSIONING.md`](VERSIONING.md) before changing the install or IPC
contract. The npm adapter and Rust crate release in exact lockstep; core is an
independent required peer. The consistency check validates both manifests,
both root locks, the exact core test version, protocol constants, compatibility
table, changelog, and optional `vX.Y.Z` tag.

When a release needs a newer core API, publish and verify core first, then
refresh this repository and both example lockfiles from the registry.
Maintainers create one green stable GitHub Release; npm and crates.io workflows
publish through OIDC. Routine releases require neither `npm login` nor
`cargo login`, and immutable versions are never reused.

## Repository skills

Agent-capable tools should load these when the task matches:

- [Effect best practices](.agents/skills/effect-best-practices/SKILL.md)
- [Air package publishing](.agents/skills/air-package-publishing/SKILL.md)

They are also concise review checklists for human contributors. The local
copies are intentional so a standalone clone retains the rules.
