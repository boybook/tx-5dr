# Development station validation and bug reproduction

Use this reference for behavior that crosses CAT, physical TX leases, audio,
real FT8/FT4 slots, actual decoding, plugin decisions or QSO persistence.
The architecture invariant is maintained in
[Station testing](../../../../docs/architecture/station-testing.md).

## Keep the unit suite fast

- Real-slot station runs and native/codec integration are explicit development
  validation and bug reproduction tools. Never invoke them from a unit test,
  `test:unit`, aggregate `test` command, a unit setup hook or default CI.
- Unit regressions use controllable clocks and local boundaries. Keep actual
  native/codec integration files under `*.performance.test.ts`, excluded by the
  server unit command. The full-process harness belongs to `test:station`.
- Cleanup-result propagation, unknown TX leases and hardware-permission binding
  have fast tests using the real lifecycle/lease owners with failing device ports.
  For these regressions, use fake clocks and CAT readback fixtures; a software
  FT8/FT4 mode alone cannot establish the physical radio mode.
- Do not automatically run the full station matrix for unrelated UI, wording,
  contract-only or local logic changes. Select it when the task's behavior needs
  that evidence. A relevant development task authorizes reversible no-hardware
  validation; it does not authorize operating a physical transmitter.

## Choose the smallest relevant check

| Question | Explicit development command |
| --- | --- |
| CAT/capability behavior, external protocol errors, native codec or peer audio | `yarn workspace @tx5dr/server test:station-integration` |
| Station calls CQ and completes a QSO | `yarn test:station --case ft8-caller` |
| Station automatically answers a remote CQ | `yarn test:station --case ft8-responder` |
| FT4 timing and exchange | `yarn test:station --case ft4-caller` |
| No false completion when the peer stays silent | `yarn test:station --case ft8-silence` |
| Deliberately validate the complete supported station matrix | `yarn test:station` |

FT8 slots take 15 real seconds; FT4 slots take 7.5. A QSO spans several receive
and transmit slots, plus build/start/restart time. Explain that cost when giving
progress, and do not shorten or fake time to make a process check finish sooner.
Local state-machine tests may advance a fake clock. Do not transplant fake
clock advancement into the complete running station.

The runner builds prerequisites and creates an isolated config/data/log/cache
and plugin environment. It never copies the primary instance's settings or
credentials. It drives normal login, WebSocket handshake and application
commands. `--artifacts /absolute/path/new-directory` retains evidence at a
chosen location. `--skip-build` is for iteration only after the necessary build
has been refreshed; do not mistake stale compiled output for validation.

For an external plugin exchange, select compatible `--provider`, `--strategy`
and `--scenario`; supply `--plugins /absolute/path/built-plugins` when needed.
Only selected directories are copied; repeat `--plugin NAME` for additional
utility/UI plugins. Do not reuse the primary plugin-data directory. The runner
checks the actual loaded strategy and records selected versions; a Host fallback
is a failure to test the target. The case's real audio, final-exchange and
persistence assertions continue to apply.

## Validate a plugin with an Agent

Build a self-contained target plugin first. When SDK-provided UI assets change,
refresh the plugin's bundled assets too; rebuilding the Host does not rewrite
an already built external plugin. Select only the plugins and scenario needed
for the task, without enabling reporters or copying primary-instance data.

- Use `--prepare` to serve the normal UI before an automatic case. Follow the
  printed `session.json`, log in through the normal token form/API using its
  temporary `tokenFile`, configure the plugin, then start `station-operator`
  normally. The runner then verifies the case and restart recovery. Do not write
  private KV files to bypass a setup confirmation or a transmission gate.
- For a strategy with `logbook:session`, supply `--logbook-page PAGE_ID` for its
  public ContestWorkbench `get-state` view. Assertions query its `health` and
  QSO identities and reopen a normal page session after restart. A different
  plugin page contract requires explicit task-specific assertions; an empty
  ordinary logbook is not evidence of a failed plugin write.
- Use `--serve --plugin NAME` for utility pages or broader UI inspection. This
  holds the isolated station without starting the operator. There is no
  automatic success verdict: `summary.json` says `unverified`. Record the
  particular interactions, expected results and evidence separately.
- Drive real controls for the behavior under review. Check invoke results,
  persistence and live push updates across independently opened pages; HTTP
  200 or a value visible only after refresh does not prove push delivery.
  Reload invalidates page sessions. Current Host reload/rescan rebuilds all
  plugins and therefore ends the frozen station peer session; start a fresh
  isolated run afterward. A browser refresh alone establishes a fresh page
  session without reloading the plugin.
- Stop via authenticated `POST /api/station-test/stop` and wait for CLI cleanup.
  Credentials are removed, processes are drained and the manifest becomes
  stopped/failed. These UI modes are Dummy-only and expire within ten minutes.

Commands and manifest details are maintained in
[development station testing](../../../../docs/development/station-testing.md).
Keep this workflow explicit and development-only. The CLI assertion helpers
can be checked quickly with `node --test scripts/tests/station-test-support.test.mjs`;
they do not launch a station or wait for slots.

## Reproduce and evaluate

1. Identify the production owner and the external condition that triggers the
   bug. Add a case, declarative peer scenario or device/protocol fault there;
   do not add a test connection, inject decoded text or force application state.
2. Reuse the normal adapter and application flow. Apply a transport failure,
   delayed/rejected CAT response, audio write failure, stopped device consumption
   or channel impairment at the external boundary.
3. Check the result and retained evidence, not just HTTP readiness or an early
   logbook entry. A positive case requires the peer's real decode of the final
   station message, PTT release, saved QSO and the same record after restart.
4. On failure inspect summary, server/restart logs, capabilities, peer JSONL,
   WS events and Float32 PCM to identify the failed boundary. Do not rerun whole
   cases until one happens to pass. Repeat after a relevant fix or a concrete
   environment correction, and retain the distinction in the report.

Native Dummy is permissive and cannot prove individual model/firmware behavior.
Protocol endpoint tests complement it with real wire errors and timing. An
observation marked `submitted` is not device consumption; software PCM is not
RF modulation evidence. Describe exactly which boundary the run exercised.

## Physical-radio validation

Only perform this when the user explicitly authorizes that hardware operation.
Use the same runner with an explicit normal Profile and station identity:

```sh
yarn test:station --hardware /absolute/path/profile.json --callsign YOURCALL --grid YOURGRID
```

The operator must install a dummy load, manually select minimum power and enter
`ARM` in an interactive terminal for the displayed device, frequency and mode.
Do not grant approval yourself, use unattended input, infer a dummy load from
CAT connectivity, or change RF power automatically. The current hardware scope
is digital TX; CW/tuner and unrelated operations remain denied by that session.
Permission expires on owner loss, connection/configuration change or deadline.

Use readback when the adapter supports it; otherwise report manual confirmation.
A hardware run proves the observed software output and real control path. RF
capture requires a separate external observation source and matching evidence.

## Maintain the capability

Keep commands and cases synchronized with `scripts/station-test.mjs` and server
package scripts. New protocol exchange policy belongs in plugin scenarios;
Host owns audio, timing, validation, cleanup and permission. Preserve the same
public contract for built-in and external providers. Update this reference for
changed operational behavior, and the architecture document for changed owners
or interfaces. Never restore the removed virtual Profile/backend shortcuts.
