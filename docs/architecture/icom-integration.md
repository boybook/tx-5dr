# ICOM integration boundary

TX-5DR uses `icom-wlan-node` for the native ICOM network protocol. Its resolved
version is recorded in `packages/server/package.json` and `yarn.lock`.
`IcomWlanConnection` adapts that public library to the application's connection,
capability, audio and spectrum interfaces. Protocol packet layouts, login/token
handling, retransmission and CI-V scope assembly belong to the library rather
than another parser inside the Host.

## Distinct transports

Native radio Ethernet/Wi-Fi remote operation has control, CI-V and audio UDP
streams. CI-V scope data travels within the CI-V stream; it is not an additional
IQ/audio stream. USB/serial CI-V with a USB soundcard is a different transport
and is normally reached through the Hamlib adapter. A `wfview` server is a
software remote endpoint; compatibility cannot be inferred solely from native
ICOM radio support.

The application does not infer identical capabilities from a shared vendor or
similar model name. The selected library/model profile supplies supported
controls and value mappings. Unsupported optional queries do not turn into
invented defaults or unconditional writes.

## Connection and data ownership

`PhysicalRadioManager` owns connection sessions, bootstrap and background-task
activation. `IcomWlanConnection` serializes control operations, normalizes public
library events and invalidates listeners/state when the session ends. A late
scope/audio/capability result cannot update a replacement connection.
See [server lifecycle](server-startup.md) and [capabilities](radio-capabilities.md).

`scopeFrame` is a display-level spectrum projection, not complex IQ. The library
owns segmentation, frequency decoding and mode-specific frequency bounds.
The Host preserves those bounds and amplitude semantics when projecting spectrum
frames. Do not reinterpret pixels as IQ, assume that every model emits the same
number of bins, or apply a second arbitrary amplitude conversion. See
[spectrum semantics](spectrum.md).

The native audio stream supplies source-rate metadata to `AudioStreamManager`.
Realtime monitoring and digital resampling have separate owners; see
[realtime audio](realtime-audio.md). Soundcard `icom-12k-if` is a separate software
IF demodulation path, not the network capability `audio_if_mode`.

## Investigation and tests

Start with `packages/server/src/radio/connections/IcomWlanConnection.ts` and
`packages/server/src/radio/__tests__/IcomWlanConnection.test.ts`. For wire-level
bugs, inspect the installed `icom-wlan-node` implementation and its fixtures.
Protocol comparisons may consult upstream `wfview` and `nonoo/kappanhang`, but
old upstream snapshots and local clone paths are not current compatibility
specifications.

Capture model/firmware, dependency revision, transport, sequence and expected
frame semantics for a protocol regression. Separate synthetic/replayed packet
checks from real-radio verification. New model commands need authoritative
model-specific evidence; radio access and transmission require their own user
authorization.

## Handshake and teardown contract

The protocol library owns one cancellable handshake generation, including DNS,
socket binding, login, token and both negotiated data streams. `connect()` has a
bounded total deadline and reports the stage that failed. Authentication and
busy failures settle the handshake immediately. A failed or lost connection
must release its token and all sockets, timers and pending CI-V transactions;
`IDLE` alone is not evidence that these resources have been released. Teardown
is idempotent and awaited before a new generation starts. A short receive grace
period allows the peer to request retransmission of token removal.

The Host uses its session mutation gate to await disposal of passively lost
connections. The adapter removes only its own library listeners and fences
late results by its session generation. Library automatic reconnect remains
disabled in TX-5DR, so `PhysicalRadioManager` is the only reconnect policy owner.

## CI-V and transport reliability

CI-V ACK/NAK replies do not carry a transaction ID. The library serializes read
and acknowledged write transactions, deduplicates identical pending requests,
and distinguishes device rejection from timeout. Public setters return
promises; callers must await them. A write acknowledgement timeout cancels
queued commands and retires the uncertain session, preventing a late ACK from
confirming the next write. Raw `sendCiv()` is an advanced escape hatch, not the
Host's normal write path. Power commands use the library's complete CI-V frame.

All Host CI-V traffic, including spectrum configuration and observation, uses
the owning `RadioIoQueue`. Spectrum reads have protocol deadlines and yield to
critical work; there is no independent timeout race that releases the queue
while an old request is still running. Meter polling belongs to the Host, not a
second PTT-triggered library timer. A device NAK does not mark the connection
lost or permanently downgrade a capability.

UDP sessions validate the source endpoint, session IDs and packet lengths
before refreshing liveness. A bounded receive window reorders tracked packets,
requests missing sequences, handles 16-bit rollover and drops duplicates.
Missing packets are eventually skipped rather than blocking a stream forever.
TX history has both age and count bounds. Audio sequence gaps still reach the
Host ring buffer after unrecovered loss, so silence compensation is applied
once. Audio scheduling uses a monotonic deadline and discards stale queued
frames after a long event-loop suspension instead of sending a catch-up burst.

## Model identity and dependency integration

IC-705 and IC-7300MK2 have distinct profiles. Default IDs are A4 and B6;
user-configured CI-V addresses are independent from the model identity.
Names are normalized exact aliases, never substring matches. A successful
`19 00` identity response overrides name/address hints, including an unknown ID
which must not retain a guessed model's extension table. MK2 USB, ACC and LAN
connector commands use their own documented addresses and encodings.

The Host consumes the published `icom-wlan-node@0.8.1` package; the exact
resolution and integrity are recorded in `yarn.lock`. Protocol changes are
maintained and released in the public library repository, not duplicated in the
Host. Version 0.8 changes formerly synchronous setters to acknowledged promises;
all adapter write paths await them. The retained TX-input capability gate is
independent of model support and remains subject to its existing validation
requirements (see [TX input routing](../decisions/tx-audio-input-source.md)).

Model command facts are checked against Icom's
[IC-705 CI-V guide](https://www.icomjapan.com/support/manual/3064/) and
[IC-7300MK2 CI-V guide](https://www.icomjapan.com/support/manual/4486/).
Transport design references include wfview's `icomudpbase` and Hamlib's
`network_session`/`network_seqbuf`; their implementation and model test status
are evidence to inspect, not substitutes for validation on the actual radio.
