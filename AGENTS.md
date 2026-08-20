# Air video Tauri repository guidance

These instructions apply to the entire `get-air/tauri-video-plugin`
repository. The product name is **Air**; `@get-air` is the npm scope, not part
of the product name.

## Skills

- Before designing, changing, reviewing, or debugging Effect code, read
  `.agents/skills/effect-best-practices/SKILL.md` completely and follow it.
- Before preparing, changing, publishing, or repairing a release, read
  `.agents/skills/air-package-publishing/SKILL.md` completely and follow it.
- Tools that support repository skills can discover these directories. Other
  contributors can open the same files and use them as checklists.

## Repository and package boundary

- This is an independent repository, not part of a monorepo. It publishes the
  npm adapter `@get-air/video-tauri` and Rust crate `tauri-plugin-video`.
- Those two artifacts are one release unit and always use exactly the same
  version. `@get-air/video` versions independently.
- Consume Air packages from the public registry. Never add `workspace:` or a
  cross-repository `file:` dependency or depend on an organizational root.
- Core must remain a required, bounded, non-optional peer plus an exact tested
  devDependency. It must not return to normal npm dependencies.
- This repository owns Tauri IPC, native surfaces, and native playback engines.
  Do not copy browser players, framework UI, or core controller
  business logic into it.
- Android dependency graphs must exclude desktop media stacks. Keep Linux and
  Windows dependencies target-scoped and capability claims truthful.

## API, Effect, and protocol rules

- The npm root is plain JavaScript/Promise API; `/effect` is Effect-native.
  Both delegate to the same adapter implementation.
- Extend core's public typed-error seam; never make core import Tauri types.
- Model public errors with `Schema.TaggedError` and preserve them across both
  Promise and Effect entrypoints.
- Validate `native_diagnostics` before opening playback. Keep the JS and Rust
  protocol constants equal; bump them only for incompatible IPC changes.
- Additive diagnostics/capabilities do not bump the protocol. Update
  `VERSIONING.md` whenever a compatibility line or protocol changes.
- Use `@get-air/http` contracts for injected networking. Tauri applications
  should adapt infrastructure through the published Tauri entrypoints.

## Verification and releases

- Run the focused JavaScript and Rust checks in `CONTRIBUTING.md`; use `act` for
  affected GitHub Actions jobs before pushing.
- Regenerate command permissions/schemas through the repository tooling when
  commands change; do not hand-edit only one generated view.
- Run `npm run check:release`. It enforces npm/Cargo lockstep, core peer/dev
  compatibility, changelog/tag consistency, and JS↔Rust protocol agreement.
- Follow `VERSIONING.md`. Keep external example dependencies registry-backed;
  examples may link this repository's adapter and crate roots.
- Stable npm and crates.io publication happens through GitHub OIDC. Never add
  npm or Cargo credentials to repository files, `.env`, or GitHub secrets.
- Do not hand-edit `dist-js`, Cargo build output, or Android build output.
