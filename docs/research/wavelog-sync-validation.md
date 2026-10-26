# Wavelog synchronization validation

Evidence date: 2026-10-09. Scope: parameterized sync pages, quiet status
presentation, opt-in iframe controls, launch idempotency and provider concurrency.
These results describe local validation, not a remote service performance promise.

## Protocol evidence retained from the v1/v2 implementation

The earlier isolated Wavelog 2.5.1 and 3.2.3 validation used the real remote APIs
with plugin-context fixtures for local logbook access. This interaction change
preserves those protocol adapters and request payloads. The following retained
results come from the local integration run's `results.json`; no credentials or
remote records are included here.

| Scenario | API | Local records after run | Imported | Uploaded | Upload requests | All requests | Elapsed |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| First initialization, client A | v2 | 50,003 | 50,003 | 0 | 0 | 54 | 47.690 s |
| Repeat, client A | v2 | 50,003 | 0 | 0 | 0 | 4 | 3.469 s |
| First initialization, client B | v1 | 50,003 | 50,003 | 0 | 0 | 54 | 22.050 s |
| Historical addition, client A | v2 | 50,004 | 0 | 1 | 1 | 5 | 1.718 s |
| Receive that addition, client B | v1 | 50,004 | 1 | 0 | 0 | 4 | 0.571 s |

These timings include remote I/O and fixture reconciliation. They do not measure
production ADIF disk throughput, peak memory or event-loop latency. The real
instances were disposable and have been removed; mock regression tests do not
replace this evidence of remote compatibility.

## Interaction and ownership evidence

Provider tests cover separate upload/download/full-sync actions, repeated and
historical launch receipts across restart, competing page leases, paused
operation type protection, independent manual and automatic results, and the
existing large-log pagination/batch scenarios.

Client tests cover quiet unused/historical/unavailable states, direct starts
after bridge readiness, inspection without execution, explicit checkpoint repair,
automatic failure details, once-only local result notices, quiet reconnect
baselines, stale progress, callsign isolation and revision ordering. Host fixtures
cover optional status compatibility, authorization, detached action parameters,
reserved bindings, declared modal sizes, and opt-in stylesheet injection. An old
page continues to receive only the existing theme and bridge resources.

Concurrent-provider tests force QRZ, LoTW and Wavelog to plan from the same local
revision. Losing writers replan minimal patches, preserve user edits and both
confirmation services, and import a shared exact QSO only once. Same-provider
tests overlap manual/automatic calls and configuration/certificate mutation.
Remote acceptance survives exhausted local conflicts; the next invocation repairs
sent state before selecting another upload. Moved queued records are refreshed by
ID, and deleted records are not reconstructed from stale automatic queue data.

The packed SDK smoke verifies the actual `ui.css` export and tarball contents.
`yarn workspace create-tx5dr-plugin smoke:ui` generates React, Vue and vanilla
consumers, installs the packed SDK outside the monorepo, then builds and tests all
three. Plugin content was also checked in the browser using the built assets and
a fixture bridge: light/dark themes, 375 px layout, long errors, associated form
labels and keyboard focus. The narrow settings page had no horizontal overflow.
The browser fixture is not evidence of a complete live station end-to-end run.

## Validation environment

Repository build, lint, i18n validation, packed SDK smoke, scaffold smoke and
focused changed-area tests passed. The repository-wide test run also exercises
the server logbook, invocation and virtual-radio checks.

This machine uses Node 26.9.0. Default `yarn test` initially encountered four
existing Web initialization failures because experimental WebStorage supplied a
`localStorage` object without the expected methods. The complete Web suite passed
with `NODE_OPTIONS=--no-experimental-webstorage`; this is a test-runner environment
override, not an application behavior change. The final repository test run with this override passed all 17 tasks, including
server unit tests, virtual-radio integration and logbook performance checks.

An earlier full server run passed 2,205 tests and timed out in one ADIF reload
test under concurrent build/test load. The affected file passed all 58 tests in
isolation; the subsequent full server unit run passed all 2,206 tests. Independent
Web `tsc --noEmit` still reports existing radio/image/QSO-column type errors;
production Web builds and the changed-area tests pass. No unrelated typing or
test-environment code was changed to hide these failures.
