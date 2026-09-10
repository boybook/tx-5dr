# Radio parameter capability ownership

The capability runtime owns one descriptor/state registry per radio connection.
Static Hamlib/ICOM definitions and connection-provided bindings use the same
permission, validation, read/write and event-projection path. A binding replaces
the static definition with the same ID; it does not add a second poller or writer.

## Protocol and application boundaries

`tci-client-node` owns the native parameter catalog, vendor addressing, explicit
decoders, units, SET confirmation and readback. `TciConnection` owns serialized
I/O and the connection epoch. Its capability bindings map native parameters to
application descriptors for the Profile's receiver, TRX and VFO.

The runtime and Web controls do not select dialects or assemble TCI commands.
Global settings remain visibly global. A parameter's supported status is distinct
from its current availability: a missing reply does not prove that a command is
unsupported. Known placeholder implementations must not become supported merely
because they echo a value.

RF power, AF gain, monitor gain and other existing normalized capability IDs retain
their 0–1 convention. Optional descriptor display transforms convert presentation
to native units without changing the stored value. A display step is a difference;
the transform's offset is never added to a step. Unknown hardware bounds do not
become invented continuous slider ranges. Native AGC gain is separate from RF gain.

## Scalar state and atomic groups

Capability state values remain boolean, finite number or string. RX/TX filter
edges and NB parameters have separate scalar descriptors, with a declared
`writeGroup` identifying their complete member set. Groups are submitted through
`writeRadioCapabilityGroup` or the corresponding REST endpoint. The runtime rejects
partial groups, extra fields, unsupported/read-only members and stale session IDs.
The connection sends the complete group as one native parameter command.

Group requests cannot choose a receiver or channel. Targets belong to the active
connection's descriptors. New Web scalar writes also carry the descriptor session
ID; old scalar requests without that optional field preserve their original API.
The group form owns text drafts and applies them only on explicit submission.
Changing sessions discards drafts and pending UI writes.

Both transports enforce `execute:RadioControl`. Parameters that require idle
state are rejected during TX or operating-state mutations, and the connection
checks confirmed PTT state again when the queued write starts. These parameter
bindings do not expose PTT, tune transmission, device power or arbitrary CAT.
Plugin capability snapshots remain read-only; no general plugin write port is added.

## Observation and lifetime

TCI startup and broadcast parameters share one library state store. The library
emits only changed parameter values; binary audio/IQ and meter frames do not cause
capability-list publication. Legacy client state fields for power, split and RX
passband are projections of the same control state when a control adapter owns them.

Capability bootstrap consumes cached state first and budgets missing reads to
two seconds, with at most 250 ms for each optional query. Unread parameters remain
unknown and can be explicitly refreshed. Event capabilities have no periodic
queries and are skipped by automatic frequency-change refreshes. Bindings that
lack reliable unsolicited notifications share one ten-second fallback scheduler.
Observation yields during PTT, cooldown, operating-state changes and I/O pressure.

Idempotent TCI parameter SETs retain the active write and replace only a queued
successor for the same session/parameter. Waiting callers receive the latest
applied result. Actions such as VFO swap are never coalesced. The default queue's
existing read deduplication semantics are unchanged.

Writes use the library's confirmed applied value. A sent-only result retains a
null/previous known state instead of manufacturing a successful device readback.
Optional parameter failures do not invalidate the radio connection or weaken the
existing PTT confirmation rules.

Disconnect disposes subscriptions, clears pollers and invalidates asynchronous
initialization, refresh and write continuations. Detached snapshots prevent readers
from mutating the runtime's cached metadata or state.

## Audio and spectrum consequences

Native Line Out selection remains a dialect capability. Its first start in each
connection attempts to enable MON once; later host/user MON changes are respected
through stream stops/restarts until a new connection begins. A MON confirmation
failure is reported as a parameter failure without discarding RX Line Out audio.

Controls do not change the canonical Float32 input format, native sample-rate
metadata or the digital resampling/cropping chain. Line Out remains downmixed to
mono, so host binaural/spatial controls do not promise stereo monitoring in TX-5DR.
Passband changes preserve both signed edges and reach spectrum consumers through
the radio's authoritative broadcast/cache. Display span and IQ sample rate remain
owned by the existing spectrum subsystem.

Guard tests cover command shapes, vendor placeholders, atomic groups, stale
sessions, a single fallback scheduler, native-unit round trips, authorization,
and the MON lifecycle. Real DSP effects still require host/hardware validation.
