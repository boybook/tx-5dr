# Release identity and update ownership

## Identity and distribution

Root `package.json` is the Host base version source. Internal Host packages
follow it; Plugin SDK and Android APK versions are independent. Runtime build
identity is generated from `packages/server/src/generated/buildInfo.json` and
consumed by Server, Electron and Web. A formal release uses an immutable
`vX.Y.Z` tag matching the committed base version and full source SHA.

The public SDK train publishes contracts, core, plugin-api and the scaffold in
dependency order. Publication waits for each exact dependency version and its
tarball to become available before continuing. The wait is bounded; a registry
failure stops the train and leaves any already published versions immutable.

A main-branch publication derives `X.Y.Z-nightly.<UTC commit timestamp>+g<short SHA>`.
The complete SHA remains in the manifest. The current publisher keeps immutable
`build-<nightly version>` GitHub Releases as well as fixed `nightly-<product>`
Releases for existing consumers. Rolling tags/asset names identify update
endpoints, not immutable source evidence. They must not be removed as test
artifacts while referenced by clients or manifests.

Versioned manifests contain product, channel, version, source SHA, asset size,
hash, installation metadata and release notes. Missing `schema_version` selects
the explicit legacy decoder. Consumers validate the requested product/channel;
CDN failure may use GitHub for the same target, never another channel. Once
selected, a download/install is bound to its exact URL and checksum.

Assets live under `tx-5dr/<product>/builds/<version>/`. The coordinator builds
all Host products from one SHA and checks their required outputs before
promotion. Version assets cannot be replaced with different bytes. Publication
exposes the version Release, updates product pointers and Docker aliases, then
commits the unified channel catalog. This sequence is serialized but is not an
atomic transaction across providers; partial failure requires verified recovery.
The website uses the stable catalog as its complete-release recommendation.

Current triggers, source gates, signing, artifact recovery and cleanup procedures
are maintained in the [release skill](../../.agents/skills/tx5dr-release/SKILL.md),
not copied into this architecture contract.

## Update owners

Installed channel and subscribed target channel are separate. Selecting a
channel saves a preference and refreshes the preview; it does not install.
Cross-channel downgrades require explicit confirmation and a successful backup.
Same-channel checks do not recommend lower versions. SemVer does not establish
compatibility of Host data or third-party plugin data.

| Distribution | Owner | Installation boundary |
| --- | --- | --- |
| Electron | Main process; one local preference/status owner | Supported updater or explicit package download; embedded Server does not keep a second preference |
| Linux Server | Shared server/CLI preference logic | Admin webpage selects; terminal CLI downloads, verifies and installs |
| Android Runtime | Native shell; Server consumes its read-only state projection | Trusted local WebView can open native updates; LAN browsers cannot install |
| Docker | Server preference projects the chosen target | Operator recreates container using image/digest and preserved volume; no Docker socket service |

Packaged identity selects the distribution path. A Linux Server package running
inside a container remains a Linux Server installation; `/.dockerenv` does not
override that identity. Unpackaged execution retains environment/path detection.

Channel changes invalidate earlier checks/downloads, and an installer handoff
cannot be treated as successful installation. Verify the actual version/channel
on restart. Legacy Electron pending-install records may omit channel and carry
short or full SHA; accept a known matching installed identity without discarding
real mismatches. Notification identity includes the selected product/channel/
build so different channel results do not suppress one another.

## Data and recovery

Updates stop RF and drain persistence through the owning lifecycle before
replacing executable files. Backups are outside the installation directory.
Electron backs up station config/data only after the embedded Server exits.
These roots may overlap Chromium's `sessionData` directory. Browser-owned
storage/cache entries at that exact root are excluded: Electron is still alive
and can hold its Cookies/LevelDB files locked, especially on Windows. The same
names inside plugin/station subdirectories remain included. Exclusions are
recorded in the backup manifest; restoration overlays the backed-up files and
does not remove excluded browser state. Browser cookies/preferences are not part
of this station snapshot and remain in place during an ordinary binary update.
Station-file copy failures still abort installation; failed staging is removed
best-effort and never published as a complete backup.
Download or backup failure must not proceed into destructive replacement.
Program rollback and data restoration are separate operations; do not silently
overwrite current user data with an older snapshot. See
[persistence durability](persistence-durability.md).

APK replacement is independent of Runtime channel selection and preserves the
package/signature/data identity with increasing `versionCode`. Docker stable
publication controls `stable` and `latest`; development consumers use `nightly`.
Existing users keep their selected channel until they explicitly change it.
