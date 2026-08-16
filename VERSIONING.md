# Versioning and compatibility

This repository publishes two halves of one native backend:

- the npm adapter `@get-air/video-tauri`;
- the Rust crate `tauri-plugin-video`.

Those two artifacts always use the exact same version. The platform-neutral
`@get-air/video` package is versioned independently and is constrained through
the adapter's declared supported range.

## Before 1.0

Pre-1.0 releases use `0.COMPATIBILITY.PATCH`:

- increment `PATCH` for every backward-compatible change, including fixes,
  performance improvements, new optional capabilities, and additive APIs;
- increment `COMPATIBILITY` when existing consumers must change code or when
  the JavaScript/Rust boundary changes incompatibly.

For example, `^0.1.2` accepts compatible `0.1.x` releases but not `0.2.0`.
Consumers should keep the npm adapter and Rust crate on exactly the same
version even when their package managers would accept a wider range.

## After 1.0

Starting at `1.0.0`, both artifacts remain in lockstep and follow standard
Semantic Versioning: `MAJOR` for breaking changes, `MINOR` for compatible
features, and `PATCH` for compatible fixes.

## Compatibility table

| Adapter and crate | Supported `@get-air/video` | Native IPC protocol | Notes |
| --- | --- | --- | --- |
| `0.1.x` | `>=0.1.0 <0.2.0` | Legacy (unversioned) | Initial lockstep release line |
| `0.2.x` | `>=0.1.1 <0.2.0` | `1` | Required core peer and protocol handshake |

Matching version numbers between the core and this repository are
coincidental; only the declared package range and this table express support.
If this adapter needs a new core contract, publish and verify `@get-air/video`
first, then update the peer range and registry-backed development lockfiles.

The IPC protocol number changes only when commands, request/response payloads,
or cross-boundary error shapes become backward-incompatible. Additive native
diagnostics or capability fields do not require a protocol bump. Before 1.0, a
protocol bump also requires a new compatibility epoch (for example, `0.1.x`
to `0.2.0`) and a new row in this table.

## Release consistency gate

Every release updates all of these together:

- `package.json` version;
- the top-level and root-package versions in `package-lock.json`;
- `[package].version` in `Cargo.toml`;
- the root `tauri-plugin-video` package version in `Cargo.lock`;
- `TAURI_VIDEO_PACKAGE_VERSION` in `guest-js/protocol.ts`;
- the matching JavaScript and Rust protocol constants in
  `guest-js/protocol.ts` and `src/models.rs`;
- the required, bounded `@get-air/video` peer range and exact in-range
  development version in both npm manifest views;
- the current compatibility-table row and `TAURI_VIDEO_PROTOCOL_VERSION`;
- an exact `## X.Y.Z` entry in `CHANGELOG.md`.

Run the same check used by CI before committing:

```sh
npm run check:release
```

Stable GitHub Releases use the single tag `vX.Y.Z`; both trusted-publishing
workflows validate that tag through the consistency gate before uploading.
Published versions are immutable and must never be reused.

Prereleases use a SemVer identifier such as `0.2.0-next.0`, publish to npm
under the `next` dist-tag, and must use a dedicated prerelease workflow rather
than either stable workflow. Prereleases never update `latest`.
