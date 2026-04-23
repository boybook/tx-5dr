# Plugin Marketplace Plan

## Summary

TX-5DR will introduce an official plugin marketplace backed by a centralized source repository and OSS/CDN-only asset distribution.

- Source of truth: `boybook/tx-5dr-plugins`
- Distribution: OSS/CDN only
- Channels: `stable` and `nightly`
- Discovery: marketplace catalog JSON fetched from a fixed URL
- Permissions: all logged-in users can browse; only admins can install, update, and uninstall
- Uninstall behavior: remove plugin code, keep plugin data by default

## Packaging And Publishing

- Each plugin in `tx-5dr-plugins` lives as an independent project under the repository root.
- CI builds each plugin into a runtime ZIP that can be extracted directly into `{dataDir}/plugins/<name>`.
- GitHub Actions validates plugin metadata, runs tests, packages ZIP assets, computes `sha256`, then uploads assets and generated catalog files to OSS.
- GitHub Release assets are not used for plugin distribution.
- Catalog URLs are channel-based:
  - `https://dl.tx5dr.com/plugins/market/stable/index.json`
  - `https://dl.tx5dr.com/plugins/market/nightly/index.json`

## Host Implementation

- Add a public marketplace catalog schema to `@tx5dr/contracts`.
- Add server-side marketplace catalog fetch endpoints under `/api/plugins/market/...`.
- Validate catalog payloads before returning them to clients.
- Future install/update flow will:
  1. fetch catalog
  2. download ZIP from OSS
  3. verify `sha256`
  4. extract into a temp directory
  5. atomically replace `{dataDir}/plugins/<name>`
  6. trigger plugin rescan
- Future uninstall flow will delete `{dataDir}/plugins/<name>` only and preserve `{dataDir}/plugin-data/<name>`.

## Inclusion Policy

- The official marketplace only lists plugins merged into `tx-5dr-plugins`.
- Community plugins are submitted by PR and reviewed before inclusion.
- `nightly` can be published automatically from `main`.
- `stable` is promoted manually after review.

## Execution Slices

1. Marketplace foundation
   - shared catalog schema
   - server catalog fetch route
   - core client API
2. Marketplace UI
   - installed vs marketplace views
   - search/filter/detail preview
   - install/update/uninstall actions for admins
3. Installation engine
   - ZIP download
   - integrity verification
   - atomic deploy
   - uninstall cleanup rules
4. Publishing pipeline
   - plugin repo CI
   - OSS upload
   - stable/nightly catalog generation

## Current Status

Started. Slice 1 is now being implemented in the main repository.
