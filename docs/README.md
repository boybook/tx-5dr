# Engineering Documentation

This directory describes current project behavior, implementation boundaries,
durable decisions, development tools and required privacy/legal information.
Runtime schemas, code and tests are authoritative. User installation and
operation guides belong in [tx-5dr-site](https://github.com/boybook/tx-5dr-site).

## Architecture

- [Release identity and update ownership](architecture/release-updates.md)
- [Station testing and audio peers](architecture/station-testing.md)
- [Server startup and radio lifecycle](architecture/server-startup.md)
- [Desktop startup readiness](architecture/desktop-startup.md)
- [Radio parameter capabilities](architecture/radio-capabilities.md)
- [ICOM integration and protocol-library boundary](architecture/icom-integration.md)
- [Realtime audio, soundcard IF input and transport](architecture/realtime-audio.md)
- [Spectrum amplitude and rendering](architecture/spectrum.md)
- [Persistence durability and sync checkpoints](architecture/persistence-durability.md)
- [Frontend state and rendering](architecture/frontend-rendering.md)
- [Assisted QSO queue and parallel protocol lanes](architecture/assisted-qso-queue.md)

## Public extension contract

- [Plugin API development guide](plugin-system.md)

Public signatures and supported ABI remain defined by `@tx5dr/plugin-api`.
The guide explains Host/plugin responsibilities; generated reference pages live
in the site repository. Host, SDK, plugin and data-format versions are separate.

## Decisions

- [Client notification ownership](decisions/client-notifications.md)
- [External device panel boundary](decisions/device-panel-boundary.md)
- [Contest logbook UI boundary](decisions/contest-logbook-ui-boundary.md)
- [TX audio input routing and disabled-capability boundary](decisions/tx-audio-input-source.md)
- [FT8/FT4 transmit envelope](decisions/ft8-ft4-tx-envelope.md)
- [DeepCW model integration and distribution obligations](decisions/deepcw-engine-integration.md)
- [WSJT-X staged decode lifecycle](decisions/wsjtx-decode-lifecycle.md)

## Development

- [Runtime dependency sources and clean-install checks](development/runtime-dependencies.md)
- [Station regression tests](development/station-testing.md)
- [Logbook/sync performance tools](development/performance-checks.md)

## Privacy

- [Privacy and diagnostic data](privacy.md)

## Maintenance and workflows

Repository skills hold repeatable working procedures:

- [Application development](../.agents/skills/tx5dr-development/SKILL.md)
- [Public Plugin API changes](../.agents/skills/tx5dr-plugin-api-change/SKILL.md)
- [Release preparation, publication, recovery and cleanup](../.agents/skills/tx5dr-release/SKILL.md)

Keep each fact with its owner: architectural invariants here, operational steps
in skills, user instructions on the website, and release-specific notes in
`release-notes/`. Keep run IDs, test-result counts, dated benchmarks, implementation
plans and abandoned prototypes in issues/PRs or ignored local output. Git history
retains removed research; it does not need a second historical archive here.

When code changes an owner, lifecycle, wire format or supported capability,
update the corresponding document and index. Preserve exact protocol/model/ABI
versions and license provenance when they are part of a live contract; do not
remove them merely because they contain a date or version. Retained disabled
implementations must be described as disabled, not as usable product features.
Check links and source anchors after moves or removals. Do not put credentials,
private account details or developer-specific absolute paths in maintained docs.
