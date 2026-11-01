---
name: tx5dr-release
description: Prepare, validate, execute, recover, or clean up TX-5DR releases and update distribution. Covers Host stable/nightly, Electron, Linux Server, Docker, Android Runtime, independent APK/SDK releases and website verification; not ordinary local builds.
---

# TX-5DR Release

The Host coordinator builds Electron, Linux Server, Android Runtime and Docker
from one source identity. APK, Plugin SDK/npm and website publication are separate
operations. Read the checked-in workflows before acting; a past successful run or
a version example is not evidence of the current configuration.

## Workflow

1. Establish the requested products, source ref, channel and publication scope
   from the conversation. Existing authorization remains valid; ask only for an
   unresolved decision or external action outside that scope. Publishing Host
   binaries does not also publish npm, the APK or the website.
2. Inspect `git status`, remote main/tag identity and current version sources.
   Preserve unrelated work and stage an exact allowlist. A source push to `main`
   triggers nightly CI; a tag push triggers formal CI. Account for those effects.
3. For Host releases, read [Host release procedure](references/host-release.md).
   For the requested products, read the matching sections of the
   [release matrix](references/release-matrix.md). Keep implementation invariants
   in [release and update ownership](../../../docs/architecture/release-updates.md).
4. Complete source checks and product-specific artifact gates before promotion.
   Confirm signatures, native loading, update metadata and installation behavior
   at the appropriate layer; compilation alone is insufficient.
5. After an authorized trigger, follow the exact SHA/run and required jobs.
   Verify GitHub and OSS/CDN independently, then the selected channel pointers,
   catalog and affected website surfaces. A skipped superseded nightly or a
   partial publication is not a newly available release.

## Version and update invariants

- Host base version comes from root `package.json`. Run `yarn check:versions`;
  do not hardcode a release number in a skill, check or workflow.
- Formal tags are immutable `vX.Y.Z` and match the committed Host version.
  Nightly is `X.Y.Z-nightly.<UTC commit timestamp>+g<short SHA>`; manifests also
  carry the full SHA. A main push never silently advances the stable channel.
- The current publisher creates `build-<nightly version>` releases and also
  refreshes fixed `nightly-<product>` releases for existing consumers. Do not
  mistake either surface for a disposable test tag.
- Pin the chosen version, asset URL and checksum across download/install. The
  same-channel GitHub fallback must identify the same bytes, never another
  channel. Stable/nightly switches may be downgrades and need the existing
  confirmation, backup, shutdown and post-restart verification paths.
- Test real old clients when claiming upgrade compatibility. Include legacy
  pending-install records without a channel and with short/full SHA; installer
  handoff is not proof of successful installation. Never clear a genuine
  mismatch merely to hide an error.

## Failure and cleanup

Diagnose the failing layer before retrying. Reuse verified formal artifacts via
the recovery workflow; do not move a published tag or rebuild different bytes
under an already released identity. A retry must be bounded; repeated identical
failure needs a tooling/source fix or a new version, not indefinite reruns.

For authorized cleanup, inventory Releases, drafts, Git refs and live manifest/
catalog URLs first. Save release metadata and an exact deletion list. Recheck a
candidate immediately before deletion. Unpublished abandoned drafts can be
removed when unreferenced and not owned by an active run. Published build tags,
SDK tags and rolling update endpoints require their own reference/retention
decision; deleting a Release and deleting its Git tag are separate operations.
Verify retained download surfaces after cleanup. Do not add an automatic history
retention policy merely to satisfy a one-off cleanup request.

Do not expose secret values in commands, logs, summaries, or generated metadata.
Do not infer permission to publish, deploy, restart, or transmit from permission
to build locally.

Report source SHA/version/channel, workflow result, artifact verification,
distribution checks and installation evidence. Name unfinished layers plainly.
Never report a queued build, started installer or created GitHub Release as a
completed end-to-end publication.
