# Release products and acceptance

Read only the products in scope. The Host coordinator in `release.yml` calls
the four reusable product workflows below; they build candidates, while the
coordinator publishes channels. A single successful product is not a successful
Host release. See [Host procedure](host-release.md) for triggering and recovery.

## Electron

- Workflow: `.github/workflows/electron-release.yml`.
- Outputs: Windows x64 NSIS/ZIP/7z; macOS arm64/x64 DMG/ZIP; Linux arm64/x64
  DEB/RPM/AppImage/ZIP, with updater blockmaps where generated.
- Check canonical build identity in main, preload, Web and embedded Server;
  packaged paths, native ABI loading and actual packaged startup. Preserve the
  audify WASAPI enumeration/GC regression and clean production dependencies.
- Published macOS app, DMG and ZIP payload require signature and notarization
  validation. Inspect current Windows signing configuration and report unsigned
  artifacts honestly; a checksum is not a publisher signature.
- Windows NSIS, macOS auto-update ZIP and Linux AppImage use the application
  updater. Windows archives and Linux DEB/RPM/ZIP use manual installation;
  do not offer headless `tx5dr update` to a Linux desktop installation.
- Test old nightly → new nightly → stable → nightly with real installation
  packages. Check saved target channel, lower-version confirmation, immutable
  target, cancellation, downloaded-target invalidation, orderly shutdown,
  backup and post-restart installed identity. Keep failure records when the
  installer did not actually change the running version.
- Electron main is the sole update-preference/install owner. The embedded Server
  must not save a second preference or bypass the shutdown/persistence owner.

## Linux Server

- Workflow: `.github/workflows/server-release.yml`; amd64/arm64 DEB and RPM,
  generated online installer and product manifest.
- Check bundled Node/native dependencies, package contents, service layout,
  permissions, persistent directories and headless readiness. Use the runtime
  library requirements in `docs/development/runtime-dependencies.md` and the
  actual artifact's loader evidence; do not assume audify ships a prebuild for
  every distribution or alter library sources just to make a test appear clean.
- A webpage saves the administrator's selected channel and presents a command.
  The CLI owns installation: `tx5dr update --channel release|nightly`. Both use
  the same preference owner. `--yes` does not authorize a downgrade;
  `--allow-downgrade` is separate. Inspect `--help` before automating.
- Download and verify the selected product, architecture, version, SHA and
  checksum before backup/service stop/install/startup validation. Verify the
  resulting running identity and data preservation, including failure recovery.
- A local Docker container can test package/CLI installation, but record its
  service-manager limitations and architecture. Installing a headless package
  in a container is distinct from replacing the official Docker image.

## Docker

- Workflow: `.github/workflows/docker-release.yml`; amd64/arm64 image manifest,
  immutable candidate image reference and digest.
- Verify both architectures, native loading, health endpoint, internal Host
  version/channel/SHA, runtime dependency contents and persistent volume paths.
- The coordinator promotes `stable`, `latest` and the version tag for stable;
  nightly publication promotes `nightly`. Check the public multi-arch digest
  after promotion and test recreation with the existing data volume.
- Web settings only select/show the update target. Actual replacement belongs
  to Compose/operator commands; never mount Docker socket to implement it.

## Android Runtime and independent APK

- Host workflow: `.github/workflows/android-runtime-release.yml`; Linux arm64
  runtime archive, manifest, SHA and size. Check PRoot paths, bundled native
  libraries, Android audio/serial bridges and minimum compatible shell version.
- Native Android owns the Runtime preference and staged installation; Server
  reads its projection. WebView may open the native updater only through the
  trusted local bridge; LAN browsers cannot install a Runtime.
- Test Runtime channel switching, lower versions, backup, activity recreation,
  background progress, return to WebView, health checks and program rollback.
  Program rollback must not silently restore an old data snapshot.
- APK publication belongs to `boybook/tx5dr-android-bridge`, normally the sibling
  checkout. Read its instructions, `android-version.json`, Gradle configuration
  and [APK workflow](https://github.com/boybook/tx5dr-android-bridge/blob/main/.github/workflows/android-apk.yml).
  Its version is independent of Host.
- Preserve application ID, signing certificate and data paths. Published APK
  `versionCode` must exceed both existing channels; the workflow's clock-based
  sequence is checked against both live manifests. Never use the local Gradle
  fallback value for a public APK. Verify signature and overwrite installation
  on an existing installation; Runtime channel selection never requires APK
  uninstall or downgrade.

## Plugin SDK/npm

- Workflow: `.github/workflows/npm-publish.yml`, manual `version` and `dry_run`.
  Its Node/npm requirements are independent of Host binary builds.
- Public train: `@tx5dr/contracts`, `@tx5dr/core`, `@tx5dr/plugin-api`, then
  `create-tx5dr-plugin`; source versions must match the requested SDK version.
  `@tx5dr/rigctld-server` is outside this publication surface.
- Use [Plugin API change](../../tx5dr-plugin-api-change/SKILL.md) for public
  compatibility checks. Inspect exports/JSDoc, test packed consumers and scaffold
  output, registry dependency versions, and Trusted Publishing/provenance.
- A Host release that raises the bundled `@tx5dr/plugin-api` major, or tightens
  plugin compatibility, changes which installed plugins load. Publish the
  migrated marketplace plugins first, confirm they appear in
  `https://dl.tx5dr.com/plugins/market/index.json`, and state the change in the
  Host release notes. `scripts/publish-release.mjs` refuses to publish while
  that schema v3 index is unavailable.
- Preserve publication order and wait for dependent versions to be visible.
  Verify registry tarballs, dist-tags and consumers; Host binaries and a Git tag
  do not prove npm publication. A dry run does not authorize a later real publish.

## Website

`boybook/tx-5dr-site` owns installation guides and generated Plugin API reference.
Use its current sibling instructions and package manager. Check its CI and
`deploy.yml`: GitHub Pages and OSS/CDN deployments are distinct results.

Verify the selected-channel download links, architecture/package choices,
release notes, Server install command, Docker examples and Android APK/Runtime
instructions. An unpublished stable channel must remain explicitly empty.
The stable catalog is the cross-product recommendation boundary; do not silently
substitute nightly assets. Existing deep links and legacy installers are part of
the compatibility surface.

## Evidence

Record source SHA and identity, relevant tests, workflow/job results, artifact
hash/signature or image digest, online manifest/catalog identity and actual
installation result. Keep screenshots and run-specific logs outside maintained
architecture documents. Distinguish automated/package checks from physical
Windows/macOS/Linux/Android journeys not performed in the current environment.
