# Host release procedure

Use this for coordinated Host publication and recovery. Paths below are relative
to the repository root. Inspect their current contents before executing commands.

## Entry points and identity

| Event | Coordinator behavior |
| --- | --- |
| PR targeting main, push to main or develop | Source verification; the Linux Server package is also built when packaging inputs changed; no publication |
| Daily schedule | Build and publish nightly when the current main SHA has no `build-<nightly version>` tag yet; otherwise nothing runs. The tag appears when the GitHub Release leaves draft, so a publication that failed after that point is resumed by manual dispatch, not by the next schedule |
| Push of `vX.Y.Z` | Validate tag/version/source, build all Host products, publish stable |
| Manual `release.yml` | Existing `ref`, builds every product, `publish=false` by default; publication still requires a valid formal tag or the current main SHA |

`.github/workflows/release.yml` calls the four reusable product workflows and
owns publication. All required product jobs must pass. `resolve-release-identity.mjs`
decides what a run verifies, builds and publishes (`planRelease`), lists the
packaging inputs that trigger the package check, and rejects noncanonical formal
tags and mismatched source versions. Workflows use
the full selected SHA, not independently resolved branch heads.

Root `package.json` is the Host base. `scripts/check-version-consistency.mjs`
lists the internal packages that must follow it and independently validates the
SDK train. `scripts/prepare-server-build-info.mjs` generates canonical runtime
identity; `scripts/prepare-electron-release.mjs` derives desktop packaging inputs.
Inspect their CLIs before updating tracked defaults. Do not bump independent SDK,
APK or reusable-package versions merely to match a Host release.

Nightly uses the source commit's UTC timestamp, not the rerun time. Formal
publication reads `release-notes/<version>.md`; nightly notes currently use
`git log -10 --format=%h %s <sha>`, not the delta since the previous publication.
Release bodies also contain the full source link, product downloads and Docker
digest. Do not claim complete interval changelogs from this ten-commit window.

## Prepare and trigger

1. Read the target manifests, changes and matching release notes. Verify that
   the main/tag SHA contains the intended code; do not publish an unrelated
   branch's ancestry. Check whether that tag/version already exists remotely.
2. Use the workflow's Node version and pinned Yarn. Run `yarn check:versions`,
   `yarn check:i18n`, relevant tests, lint/build and the release-policy tests.
   The coordinator is the canonical source gate; do not weaken it to hide an
   environment, native dependency or signing failure.
3. For stable, commit the matching source versions and release notes before
   creating the immutable tag. Push only the authorized branch/tag. For nightly,
   wait for the daily schedule or dispatch `release.yml` with the existing main
   ref and `publish=true`; do not manually fabricate a formal tag for a nightly build.
4. Record the full SHA and workflow run. Use `gh run view <run-id>` to inspect
   failed jobs and artifacts; follow that run rather than the latest unrelated
   run. No required product may be silently excluded from stable publication.
5. After stable publication is verified, advance the main Host base version in
   a separate source change when authorized. The next scheduled or dispatched nightly starts the new
   series; the formal tag and published binaries remain unchanged.

A manual validation run can be dispatched with `publish=false`. Do not dispatch
publish, push tags or change channel pointers during a read-only investigation.

## Distribution sequence

`scripts/publish-release.mjs` owns this sequence:

1. Validate required configuration, checkout SHA and tag/current main. Collect
   accepted artifact bundles from `release-inputs`; reject unexpected files and
   incomplete product/platform/architecture coverage.
2. Generate schema-versioned product manifests and the unified catalog. Record
   version, full SHA, channel, product, hashes/sizes, update metadata and pinned
   download URLs. Validate the Docker multi-architecture digest.
3. Create/reuse a draft GitHub Release. Existing version assets must be byte
   identical; upload missing assets and verify their size/hash.
4. Upload immutable assets and versioned manifests to OSS/CDN under
   `tx-5dr/<product>/builds/<version>/`. Verify contents online before promotion.
5. Recheck the formal tag or main SHA. A newer main supersedes the candidate;
   the script may retain an unpublished draft and skip promotion.
6. Publish the version Release, update product channel pointers, refresh the
   legacy rolling nightly surfaces, promote Docker aliases, then commit the
   channel catalog. Read back product channel identities.

Promotion is serialized by the shared `tx5dr-channel-publish` concurrency group.
It is not a distributed transaction across GitHub, OSS, Docker and the catalog:
failure partway through may leave some visible surfaces advanced. Verify and
complete the missing steps using the accepted bytes; a GitHub page alone is not
completion. Never hand-edit only one product pointer to bypass the coordinator.

Check these public surfaces for the selected channel:

- `https://dl.tx5dr.com/tx-5dr/<product>/<release|nightly>/latest.json`
- `https://dl.tx5dr.com/tx-5dr/<release|nightly>/catalog.json`
- GitHub formal `vX.Y.Z` or immutable `build-<nightly version>` product manifests
  and assets, plus fixed `nightly-<product>` compatibility releases.
- Asset URLs selected from the live manifests: product/platform/architecture,
  size, SHA-256 and updater SHA-512/blockmap where required.
- Docker `stable`/`latest` for stable, `nightly` for nightly, and recorded digest.
  Tag names alone do not establish the image's internal channel or source SHA.

## Recovery

For a formal run with source verification and every required product job already
successful, `.github/workflows/retry-release-publication.yml` accepts the original
`run_id`. `scripts/verify-publication-retry.mjs` verifies repository, workflow,
event, formal tag, SHA, completion and the exact required jobs.

The recovery run takes approved publication tooling from its selected ref, checks
out the original immutable source, downloads that run's accepted artifacts and
resumes publication. It does not rebuild or relocate the formal tag. Inspect
artifact availability before retrying; expired artifacts are not permission to
replace an already published binary with a fresh build. This recovery entry is
for formal runs, not an arbitrary nightly/ref bypass.

If only transport/publication tooling failed, fix that tooling and run recovery
with the same accepted bytes. If source or binary content must change after
publication, use a new version. For superseded nightly work, let the newer main
run publish instead of forcing the stale candidate into the channel.

macOS signing/notarization remains mandatory for published artifacts. Use the
existing bounded transport/stapler retry paths for network faults; certificate,
signature and content errors require diagnosis and must never be waived. The
workflow also has bounded packaging retries; their eventual success still needs
the independent signature/notarization checks.

## Consumer acceptance

Use the product matrix for installation checks. Test release → nightly and
nightly → release, including a lower target version, selected-channel persistence,
shutdown/backup, failure recovery and actual identity after restart. Old-client
compatibility must use an actual published old package, not only the current
source with a changed version constant. Record tests not available on this host.

Website deployment and Android APK publication remain independent. Read their
current sibling-repository instructions when included in the task; verify their
public surfaces after deployment. Host publication does not prove either one.
