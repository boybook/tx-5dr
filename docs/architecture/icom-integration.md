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
