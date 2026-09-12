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

## Web control ownership

Capability cards, user-pinned quick controls and the capability portion of existing
popovers use one HeroUI renderer per value type. Cards own full labels, descriptions
and pin affordances; the renderer owns the compact control, display conversion and
current edit. Capability-specific prerequisites, such as the tuner switch before a
tune action, wrap these same controls. Physical power and tune-tone transmission
keep their dedicated workflows.

On narrow screens the full panel uses the available visual viewport and safe-area
insets, with a fixed header, category tabs and optional search across categories.
Cards own the full title, scope badge, pin and a click-to-expand description. Their
shared controls omit redundant inline captions and expose current access/confirmation
feedback as visible text. Desktop cards retain their full explanations and columns.
Card presentation is selected explicitly through frontend props; it does not change
backend descriptors or introduce another parameter writer.

Mobile number inputs have a 28px surface and 6px corners within a 44px padded focus
target. Button surfaces are 32px within a 44px tap box. These styles are scoped to
the full mobile panel, leaving quick controls and other HeroUI consumers independent.
Numeric input strings omit a leading plus, which HTML number inputs reject; display
formatting and negative values retain their original sign and unit semantics.

Changing category, search results, responsive layout or connection scope unmounts
the departing editors and discards drafts and unsent debounces. Pointer navigation
in the mobile header invalidates editors before focus moves. Header/pin targets
marked `data-capability-navigation` also cancel numeric blur commits during keyboard
navigation. Ordinary Enter/blur commits keep their existing semantics. Browsing,
help disclosure and pin management perform no radio queries or parameter writes.

Quick controls occupy a separate HeroUI card with larger gaps between capabilities
than within a capability. Shared sliders reserve space for their thumbs at both
endpoints. Quick sliders show their value on hover, drag or keyboard focus; their
labels show capability details in a separate tooltip. The same renderer keeps the
companion numeric input in the full panel. Numbers without sliders and atomic-group
drafts retain their inputs in either container.
The quick card reserves a trailing action column for opening the existing full
panel, aligned with the first row while controls wrap independently. `RadioControl`
owns the shared modal state and permission gate for all its panel entries.

The Web radio provider supplies one capability edit environment. It binds writes to
the selected Profile, connection lifetime and descriptor target, and checks current
permission/idle requirements at dispatch. Changing that context, disabling a view
or unmounting invalidates unsent edits. Initial Profile hydration may follow the
WebSocket capability snapshot and must accept that snapshot without awaiting a
replacement. Switching away from a known Profile still invalidates its descriptors
until a new snapshot arrives, including switches that pass through a null Profile.
Opening the capability modal disables quick
control editing and cancels its pending debounce; closing destroys modal drafts.
The shared capability renderer keeps a local pending proposal after a slider is
released or a text input is committed. It does not publish that proposal to the
radio store. The latest operation owns this presentation until its matching write
receipt returns; older completions cannot overwrite it. A receipt can bridge the
short interval before the corresponding normal state broadcast reaches the view.
Failures restore the last authoritative state, and context changes discard the
pending presentation. Normal host broadcasts remain the radio store's authority.

Scalar WebSocket writes use the existing optional envelope `id` as a request ID;
`data.id` remains the capability ID. After the existing guarded write completes,
the server returns one `radioCapabilityChanged` snapshot to that client with the
same envelope ID, or an `error` with that ID. The snapshot reads only the capability
cache and adds no radio query. Requests without an envelope ID retain their original
broadcast-only behavior. No new message types or TCI commands are introduced.

Correlated capability snapshots are receipts, not new live broadcasts: the core
message handler delivers them on the raw request channel without replaying them
into the radio state stream. This prevents a late receipt from replacing a newer
normal broadcast. The Web connection owns a single listener while writes are
pending, validates receipts with the existing schemas, and cancels waits when its
scope ends. Each wait is bounded to five seconds without polling or resending.

Numeric text commits once on Enter or blur and can be cancelled with Escape. Slider
updates share a 150 ms debounce and flush the final pending value on release. Atomic
groups own all field drafts and submit only complete validated values. A visual
`compoundGroup` does not force pinning its other members; a `writeGroup` does.

Pins are client layout preferences, persisted by Profile ID in versioned local
storage. They contain only capability/group identities and order, never parameter
values, targets or sessions. Pinning and sorting do no radio I/O. Missing pinned
capabilities retain a removable placeholder. An on-demand menu in the modal header
owns ordering/removal, including missing entries; pin icons use a neutral visual
state distinct from radio on/off controls. Other tabs can synchronize this layout
through one shared storage listener.

Controls subscribe to the existing separate capability contexts. Stable descriptor,
state and callback identities let unchanged controls skip rendering. Adding pins
adds no protocol queries, capability pollers or audio/spectrum subscriptions.

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
