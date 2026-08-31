# Radio Boundaries and Tests

Read only the sections that match the requested radio change.

## Ownership

| Concern | Owner |
| --- | --- |
| Protocol connection, parsing, low-level reads/writes | `radio/connections` adapter or its public dependency |
| Session creation, bootstrap, activation, reconnect | `PhysicalRadioManager` |
| Resource ordering, engine start/stop, rollback | `EngineLifecycle` |
| Physical `on/off/standby/operate` transaction | `RadioPowerController` |
| Projection to engine/WebSocket events | `RadioBridge` |
| Physical frame, PTT, audio lease, hard stop | transmission pipeline/coordinators |
| Capability metadata, detection, read/write dispatch | `radio/capabilities` |
| Realtime monitoring transport | `realtime` source/router/publisher boundary |

The software engine, connection session, and physical power state are separate.
Only an explicit policy controller may coordinate them.

## Connection Rules

- `connect()` establishes the protocol session and minimal initialization.
- One-time post-connect reads and writes belong to bootstrap.
- Meter/frequency polling and other long-lived observers start after bootstrap.
- Every old timer, subscription, and pending callback must be invalidated when
  its session ends.
- Control operations are serialized. Low-priority observation yields to PTT,
  frequency, mode, power, and compound operating-state changes.
- An observation failure is not by itself proof that the connection is dead.

## Capability Changes

Check all affected layers:

1. shared capability ID/value schema;
2. adapter support detection and read/write implementation;
3. capability metadata and range/step semantics;
4. permission enforcement and WebSocket projection;
5. dynamic Web control rendering and i18n;
6. unsupported, read-only, stale-value, and device-rejection tests.

Do not advertise continuous values when the radio exposes discrete steps. Do
not show a capability merely because another model or backend supports it.

## Audio and Spectrum

- Preserve the authoritative RX source; publishers do not choose it.
- Keep digital decode resampling separate from native realtime monitoring.
- Drop stale realtime frames instead of building unbounded latency.
- Treat ICOM WLAN UDP, TCI WebSocket/binary streams, soundcard PCM, Android
  sockets, and OpenWebRX as distinct source contracts.
- Record source rate, transport rate, codec, sequence, and timing evidence when
  diagnosing audio behavior.

## Guard Tests

Start with the nearest tests, then run the owning workspace:

- `PhysicalRadioManager.test.ts`: bootstrap ordering, stale sessions, I/O priority.
- `RadioPowerController.test.ts`: physical power versus engine state.
- `EngineLifecycle.test.ts`: resource ordering and rollback.
- `RadioBridge.test.ts`: projection without hidden bootstrap writes.
- `HamlibConnection.test.ts`, `IcomWlanConnection.test.ts`, `TciConnection.test.ts`:
  adapter-specific protocol and serialization.
- capability manager/definition tests: dynamic support and values.
- realtime and transmission tests: audio source, queue, PTT, and hard-stop behavior.

Use `docs/architecture/server-startup.md` for lifecycle invariants and
`docs/architecture/realtime-audio.md` for realtime audio ownership.
