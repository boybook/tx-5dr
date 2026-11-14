# Station testing and audio peers

## Goal and ownership

Routine development must be verifiable without a transceiver. The same audio
peer can accompany a physical radio after a person installs a dummy load,
manually selects minimum RF power and authorizes the bounded test session.
Application connection management, bootstrap, capability discovery, scheduling,
Host decisions, TX leases, audio processing, decoding and persistence are shared
with normal operation. Simulation belongs at the external device boundary.

The composition root may select a device factory and install a restrictive radio
execution policy. Domain services do not select alternate test implementations.
Hamlib Dummy model 1 uses the normal Hamlib connection. The audio device port
is the subset used by normal RtAudio enumeration and streams. Its virtual
implementation has a bounded FIFO and asynchronous sample-clock consumption;
write success is not playback completion.

`AudioStreamManager` owns normal output conversion, buffering and drain. Its
read-only TX observation reports transmission/stream identity, timestamp, sample
position, rate, observed samples and completion/interruption. Evidence is marked
`consumed` for RtAudio and `submitted` for paced network/Android digital output.
Submission does not establish radio consumption or RF modulation. An observer
must not pace physical output or authorize PTT. Missing observations fail a test;
encoder input is never a replacement for observed output.

`PeerSession` consumes observed PCM, uses the real WSJT-X decoder, advances an
independent declarative scenario and encodes replies with the real codec. It
owns bounded peer audio scheduling, not the station's TX/RX lifecycle. Peers
hear mixed channel audio through decoding; messages are not delivered through
known-text side channels. Fixed dial frequency, digital mode, peer phase and
baseband position define channel membership. A changed channel cannot keep
answering the old transmission.

`RttyPeerSession` is the keyboard-mode counterpart for RTTY runs. A received
message is one complete observed station transmission (deterministic playback
now emits the same TX observation as `playAudio`), decoded with the real native
RTTY decoder. The declarative scenario advances once per station transmission
or after eight seconds of channel silence, and replies are rendered with the
real native encoder after a short turnaround. A peer may declare
`channelSnrDb` to add seeded white noise to its replies. RTTY cases are operated
by the runner through the normal WebSocket API (`rttyTxAppend` with `{RX}`),
read the station's own decoder events, and log the QSO through the normal
logbook API; a disconnect case asserts that losing the sending client releases
PTT within three seconds.

The audio owner is the single RX ring writer. Virtual-device audio enters normal
capture, conversion and resampling. With physical capture, a baseband
contribution is mixed after IF demodulation/resampling on the input timeline.
Native monitoring remains physical-source monitoring; a synthetic reply is not
represented as physical RX evidence.

## Scenarios and lifetime

Plugins declare `simulationScenarios` through `@tx5dr/plugin-api`. Host execution
and validation are shared by built-ins and external plugins. Scenarios have no
CAT, PTT or audio-device handle. The standard QSO plugin supplies independent
FT8/FT4 calling, answering and silence scenarios, without calling its station
strategy implementation. Existing contest scenarios use the same contract.

A run freezes the provider definition and seed. Replacement/unload, channel
change, connection loss, expiry or shutdown ends that session. In-flight codec
work and late samples cannot schedule audio into a later session. Buffers,
identities and observations have finite limits. Fast scenario tests may use an
injected clock; complete-process cases use real radio slots and real workers.
Real-slot station runs and native/codec integration are explicit development
validation and bug reproduction tools. They are excluded from unit and aggregate
test commands and default CI; do not lengthen the unit suite with slot waits.

## Physical execution permission

Station-test runs are isolated processes, with explicit config, data, cache,
logs, plugin and plugin-data roots. A hardware run starts without TX permission.
Only an authenticated administrator can acknowledge both physical preparations
and arm the current session. CLI hardware runs require an interactive terminal
and explicit station identity. The permission remains in memory, binds the
Profile, connection lifetime, mode/frequency and deadline, and is not restored
after reconnect or restart. The child process watches its owner's stdin pipe;
owner loss revokes permission. The maximum session duration is ten minutes.

Hardware permission also binds the actual CAT modulation mode read while
arming. Both the lease and PTT owners await a mode readback and recheck the
permission afterward. This optional restriction adds no readback or asynchronous
wait when no execution policy is installed. During a hardware grant, the same
runtime timer checks mode once per second with at most one read in flight;
normal capability polling may pause during TX. Mode capability changes revoke
immediately, as do software mode-write requests. Changed, unknown or failed
mode readback stops the session. Reconnect, stop or expiry while a read is
pending cannot restore permission when its late result arrives.

The hardware scope is the case's mode: digital transmission for FT8/FT4 cases
and RTTY transmission (`rtty` source) for RTTY cases. The normal physical lease
and radio owners enforce restrictions, including temporary tests and self-keyed
sources. CW, tuner and other sources are denied by this session's scope. RF power
and physical power writes are prohibited in hardware runs. Supported RF power
readback is monitored against the manually selected baseline; missing/changing
readback fails closed. Unsupported readback is explicitly manual confirmation.
The software cannot verify installation of the dummy load or that an unreadable
setting is the device's physical minimum.

## Evidence and regression contract

A successful QSO case needs observed TX decoding, real reply audio decoded by
the station, the final station exchange decoded by the peer, released PTT,
durable QSO persistence and matching records after restart. An early logbook
record alone is not sufficient. Negative cases assert absence of false QSOs.
The CLI also checks the requested plugin's loaded/enabled status, actual strategy
assignment and version. A production fallback cannot satisfy that assertion.
Plugin session persistence is checked through an explicitly selected public
ContestWorkbench page and a fresh authenticated page session after restart;
ordinary logbook visibility and authorization remain unchanged.
Failure artifacts contain sanitized configuration, dependency/build identity,
capabilities, protocol/events, PCM, scenario trace and an explicit result.

Optional CLI UI preparation uses the existing Web application and normal
authentication, settings and operator commands. Its local session manifest has
a runtime schema and points to temporary credentials without containing them.
Manual UI sessions make no automatic QSO claim; verified cases retain the same
audio and restart requirements after preparation. These modes are Dummy-only
and share the bounded process lifetime and normal shutdown owner.

Regression cases add scenarios, external fault sequences and assertions. Faults
are applied at device/protocol boundaries: delayed/rejected replies, transport
loss, stopped consumption or device loss. Never add production shortcuts that
set connected/transmitted/decoded/completed state for tests, disable normal
timeouts or retry whole cases until one succeeds. Dummy proves common native
control behavior; protocol-specific and physical-device claims require their
own evidence.

Legacy `radio.type=virtual` Profiles are rejected without rewriting the file or
activating another Profile. There is no legacy runtime, projection or converter.
Only this station-testing capability is being replaced; real WLAN/TCI/OpenWebRX
source distinctions remain owned by their existing adapters.
