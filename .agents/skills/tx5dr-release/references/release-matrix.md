# Release Matrix

Read the selected product section only.

## Desktop

- Workflow: `.github/workflows/electron-release.yml`
- Outputs: Windows installer/archive, macOS DMG/archive, Linux DEB/RPM/AppImage/archive.
- Critical gates: clean selected source ref, native ABI loading, packaged startup,
  macOS/Windows signing where configured, update metadata, checksums, and asset names.
- Electron success does not prove the headless server packages or Docker image.

## Linux Server

- Workflow: `.github/workflows/server-release.yml`
- Outputs: amd64/arm64 DEB and RPM, online installer, channel `latest.json`.
- Critical gates: system service layout, portable Node/native runtime, data/log
  ownership, headless startup, reverse proxy, update/rollback metadata.

## Docker

- Workflow: `.github/workflows/docker-release.yml`
- Output: multi-architecture image plus digest and OSS metadata.
- Critical gates: device/USB/audio mappings, persistent volumes, health endpoint,
  architecture manifests, immutable digest, and startup without desktop assets.

## Android Runtime

- Workflow: `.github/workflows/android-runtime-release.yml`
- Output: Linux arm64 runtime consumed by `tx5dr-android-bridge`.
- Critical gates: PRoot-compatible paths and native libraries, Android audio and
  serial socket backends, size/hash manifest, and separation from APK publication.
- The APK is released from the separate Android bridge repository.

## npm Packages

- Workflow: `.github/workflows/npm-publish.yml`
- Public chain includes contracts, core, plugin API, and scaffold according to
  their current dependency graph and workflow configuration.
- Critical gates: exact versions, export maps, `npm pack --dry-run`, packed
  consumer smoke, provenance/Trusted Publishing, and registry propagation.
- Do not publish `@tx5dr/rigctld-server` unless it is explicitly added to the
  current public workflow and registry policy.

## Distribution Verification

For binary products, verify each authorized layer independently:

1. source ref and commit;
2. build/test job;
3. artifact name, size, checksum/signature or container digest;
4. GitHub Release or registry entry;
5. OSS asset and channel metadata;
6. CDN/live download response;
7. startup or consumer smoke on the intended platform.

A successful build is not publication evidence. GitHub publication is not OSS
or CDN evidence. A visible download is not runtime startup evidence.
