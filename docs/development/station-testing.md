# Station regression tests

The invariant and evidence levels are defined in
[Station testing and audio peers](../architecture/station-testing.md).

These are explicit development validation and bug reproduction commands. They
are not unit tests and are not invoked by aggregate tests or default CI. FT8
uses real 15-second slots and FT4 uses real 7.5-second slots; prefer one case
matching the problem instead of running the full matrix after every edit.

Use the repository's pinned Yarn and CI Node version. Run:

```sh
yarn test:station
```

This builds server prerequisites and runs isolated FT8 caller, FT8 responder,
FT4 caller and silent-peer cases. Config, data, cache, logs, plugins and plugin
data live in a new temporary directory, whose absolute path is printed. Normal
admin login and WebSocket handshake are exercised. External reporting and sync
are disabled. Each QSO must survive a process restart.

Choose one case or retain artifacts at a chosen location:

```sh
yarn test:station --case ft8-caller --artifacts /tmp/station-result
```

RTTY cases (`rtty-caller`, `rtty-responder`, `rtty-noise`, `rtty-disconnect`)
run on 14.080 MHz in RTTY mode. RTTY is operated by hand, so the runner acts as
the operator over the normal WebSocket API: it sends macros ending in `{RX}`,
waits for the virtual peer's decoded reply, logs the QSO and checks it survives
a restart. `rtty-noise` adds channel noise to the peer; `rtty-disconnect` closes
the sending client mid-transmission and requires PTT release within 3 s.

A compatible external provider/strategy can be selected with `--provider`,
`--strategy` and `--scenario`. `--plugins /absolute/path/built-plugins` copies
only those named, self-contained plugin directories into the isolated run.
Repeat `--plugin NAME` to also load utility/UI plugins. Requested plugins must
be loaded; the selected strategy and utility instances must be enabled, and the
strategy must actually own `station-operator`. A scenario-only provider does
not need to replace the station strategy.
The Host's normal strategy fallback is preserved, but never counts as a test of
the requested plugin. Plugin names and versions are retained in the evidence.
The standard calling/answering case still verifies decoded final messages and
persistence; the peer and local strategy must implement the same exchange.

For a strategy that writes plugin session logbooks, select
`--logbook-page PAGE_ID`. The page must implement the public ContestWorkbench
`get-state` contract (`schemaVersion: 1`, `health`, `qsos` with `id`/`callsign`).
The runner opens an authenticated, resource-bound page session and queries that
view again through a fresh session after restart. It does not expose private
session logbooks through the ordinary logbook API or infer a plugin's storage
layout. Other page contracts need their own explicit assertions; do not report
a successful plugin QSO from an ordinary logbook fallback.

## Agent and UI sessions

Use `--prepare` for configuration through normal UI/API actions before a verified
case. The runner builds Web as well as server prerequisites, serves the existing
Web application on loopback, and waits for the ordinary operator start action:

```sh
yarn test:station --case ft8-caller --strategy contest-arrl-digital \
  --plugins /absolute/path/built-plugins --logbook-page contest-log --prepare
```

Use `--serve` for an open-ended plugin/UI inspection without automatic QSO
assertions, for example:

```sh
yarn test:station --serve --plugin iframe-panel-demo --plugins /absolute/path/built-plugins
```

Both modes default to one `ft8-caller` case and support Dummy only. They leave
the operator stopped initially and retain the existing ten-minute session limit.
`--serve` records `unverified`, never an automatic pass. `--prepare` runs the
normal audio/final-exchange/PTT/persistence/restart assertions after operator
start. A setup gate must be satisfied through the plugin's normal controls;
neither mode writes private plugin state or bypasses its transmission policy.

The printed `<case>/session.json` follows `StationTestAgentSessionSchema` and
contains the UI/backend URLs, operator, selected plugin versions, deadline and
phase. During the session, `tokenFile` points to the isolated administrator token
for normal UI login or `/api/auth/login`; credentials are never included in the
manifest. Do not log or publish that token. The manifest is replaced atomically;
cleanup removes credentials and marks it stopped/failed. A page session expires
when its plugin reloads. The current Host reload/rescan rebuilds the entire
plugin inventory, which also ends the frozen peer session: start a fresh
isolated run afterward. Ordinary browser refreshes simply establish a fresh
page binding; they do not reload plugins.

Stop through authenticated `POST /api/station-test/stop`, or interrupt the CLI.
The runner stops Web and uses normal server shutdown and persistence draining.
An expired, interrupted or failed verified case is not a pass. Do not make these
sessions part of unit tests, aggregate `test` scripts or default CI.

`--skip-build` is for local iteration after building the server prerequisites.
Use the normal entry when validating a new build. Results and recordings stay outside tracked
source. A failed case is not rerun automatically. Summary JSON, server/restart
logs, WebSocket events, capabilities, peer trace and 12 kHz Float32 PCM identify
the failed boundary. The PCM files represent observations, not RF captures.

For a physical radio, provide an explicit normal RadioProfile JSON and station
identity in an interactive terminal:

```sh
yarn test:station --hardware /absolute/path/radio-profile.json --callsign YOURCALL --grid YOURGRID
```

Install the dummy load and manually set minimum power before entering `ARM`.
The CLI displays the device, frequency, software mode, the radio's own CAT mode
and RF power readback, and the time limit (counted from server start). Check
the mode on the radio display as well: some links (ICOM WLAN) do not report the
DATA flag, so LSB-D and LSB read back the same. There is no
unattended hardware option or persisted permission. Hardware tests use a separate
application process and never load the primary instance's configuration. The
first case defaults to FT8 on 14.074 MHz; choose the case deliberately and inspect
the displayed target before authorizing. RTTY hardware runs (`--case rtty-caller`,
`--case rtty-disconnect`) select PKTLSB/LSB-D before arming; the mode and the
manually set power are then read back every second and any change fails the run. The first release proves CAT/PTT and
actual software audio output with virtual replies; RF verification requires an
external capture source and separate hardware evidence.

New application regressions should use the existing owners and add cases or
external faults. New peer exchanges belong to a plugin's public scenario
contract. Protocol-specific tests should exercise real adapters against external
endpoints rather than replace the application connection class.
