---
name: tx5dr-release
description: Prepare, validate, or execute a TX-5DR desktop, Linux server, Docker, Android runtime, or npm package release. Use for release artifacts and publication workflows; not for ordinary local builds or user installation help.
---

# TX-5DR Release

Each product and publication layer is an independent release boundary.

## Workflow

1. Resolve the exact product, channel, version/ref, target platforms, and whether
   the user authorized preparation only or external publication.
2. Inspect the current workflow and package metadata. Historical release notes
   and successful runs are not current configuration evidence.
3. Read [references/release-matrix.md](references/release-matrix.md) only for the
   selected product.
4. Preserve unrelated dirty work. Stage exact files and do not combine source,
   npm, binary, website, or deployment publication without explicit scope.
5. Run source checks plus the selected artifact's native-loading, packaging,
   checksum, signing, metadata, or consumer smoke gates.
6. After authorized publication, verify the remote ref and every required job.
   Verify OSS/CDN metadata and live download surfaces separately from GitHub
   Release creation.

Do not expose secret values in commands, logs, summaries, or generated metadata.
Do not infer permission to publish, deploy, restart, or transmit from permission
to build locally.

End with a gate-by-gate report: source commit, artifact identity, checksums or
digest, workflow results, distribution metadata, live verification, and any
layer that was not authorized or not tested.
