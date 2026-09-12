# Frontend state and rendering

## Ownership

`RadioProvider` owns the browser projection of the server's radio state. Its
reducers, WebSocket bootstrap, authentication lifetime and spectrum negotiator
remain the source of truth. Presentation contexts project that state; they do
not keep independent copies or change the server's control decisions.

Components subscribe to the domain they display. Actions have a stable context
separate from state. Meter readings belong to `RadioMetersPanel` and explicit
meter consumers, rather than the surrounding digital, voice, CW or image
workspace. Operator selection is independent of operator runtime snapshots.
Spectrum selection and split state have their own projections. The full-state
hook remains available for consumers which actually need the complete snapshot.

The existing meter coalescing interval in the WebSocket event map is independent
of these render boundaries. PTT, tune tone, connection state and transmit
permissions are never delayed to reduce render frequency. Meter samples retain
their identity across the TX epoch guard: an equal numeric value can still be a
new sample after rekeying. A missing reading holds its own last sample and
deadline; another meter updating cannot clear or extend that deadline.

The CW decoder owns its transcript and control state. Its spectrum tuning
projection contains only the target, width, visibility and tuning actions.
Transcript updates do not invalidate the spectrum. Image paper rows continue to
use `ImagePaperRowStore`; frequency-domain frames continue to use the spectrum
controller's bounded render batches, outside React state.

## Plugin projection

Each authenticated `RadioProvider` contains one `PluginSnapshotProvider`.
Consumers share one REST hydration and one subscription per plugin event. No
consumer starts its own copy of the plugin snapshot lifecycle.

Hydration begins only after the business WebSocket handshake is ready. Updates
received during hydration are replayed over the REST snapshot, preserving
generation ordering and panel contribution changes. Disposed requests and
subscriptions cannot update a later identity. An identity or permission change
hides the previous snapshot immediately. A transient disconnect retains the
displayed snapshot, while the next ready connection hydrates a fresh Host epoch,
whose generation may have restarted.

This is a browser projection of the existing public plugin contract. It adds no
Host capability or plugin-specific event semantics.

## Derived views and background work

Secondary mode layouts and settings/profile dialogs load on demand. Radio,
notification and image-paper providers remain outside the loading boundaries.
`ModePane` keys its suspense boundary by engine mode so outgoing view effects
are cleaned up even while the incoming module is still loading. Local view
state retains the same lifetime as the corresponding mode or open dialog.

Decoded frame groups are derived during rendering, rather than copied into
state by an effect. `createSlotPackFrameProjector` owns a `WeakMap` for one
slot-duration/filter configuration. Unchanged immutable `SlotPack` objects reuse
their groups and message objects; replacing a pack reprojects it. Changing the
mode's slot duration or filters creates a new projector. Grouping, history
retention, TX sentinel exclusion and message selection remain unchanged.
The related-message view depends on its frozen/live groups, not on internal
sequence bookkeeping; tracking an unrelated slot does not invalidate an empty
view. Live RX entries remain available for later target selection.

Row memoization requires stable message objects, highlight helpers and event
callbacks. Callback closures which bind a message belong inside the row, after
the memoization boundary. Local hover and scroll updates must still reach the
current row and spectrum.

Virtualization retains whole groups and always includes the visible range.
Overscan stops after roughly 32 message rows on each side, with the existing
five-group maximum. Dense slots therefore do not multiply the offscreen DOM by
five; sparse histories retain their previous buffer. Group measurement and
follow-to-bottom behavior continue to belong to the same virtualizer.

Digital slot masks and voice/CW progress fills animate `transform: scaleX`,
using a fixed width and the original time/phase calculations. They must not
animate width: continuously changing geometry forces layout at the display's
refresh rate. The digital mask anchors to the right; playback/wait fills anchor
to the left.
Slot progress remains entirely CSS-driven. The animation key follows the global
slot ID, and the starting mask and remaining duration use the supplied phase
sample. TX/RX changes inside that slot must preserve the existing animation
element and clock. `forwards` fill holds a completed bar at its endpoint; only a
new slot (or a deliberate view mount with the current phase) starts an animation.

The UTC clock keeps its existing offset and polling cadence, but updates React
state only when the displayed second changes. The logbook globe pauses drawing
when its element is offscreen or the document is hidden, and resumes when both
are visible. Pausing drawing does not stop data synchronization or discard
camera state.

## Guard checks

- `store/__tests__/radioStore.rendering.test.tsx`: subscription isolation,
  immediate PTT projection, operator identity and mode timing changes.
- `hooks/__tests__/usePluginSnapshot.test.tsx`: shared subscriptions, hydration
  races, identity changes, reconnect generations and cleanup.
- `hooks/__tests__/useBufferedMeterData.hook.test.tsx`: independent hold
  deadlines, fresh TX samples and timer cleanup.
- `hooks/__tests__/useCWDecoder.rendering.test.tsx`: transcript versus tuning
  subscriptions.
- `components/radio/digital/slotPackFrameProjection.test.ts`: incremental
  projection, FT4 alignment, filtering and grouping.
- `components/logbook/RecentQSOGlobeCard.rendering.test.tsx`: visibility-driven
  drawing and stable scene data across presentation updates.
- `layout/ModePane.test.tsx`: outgoing mode cleanup during asynchronous loading.
- `components/radio/digital/frameVirtualRange.test.ts`: visible-range retention
  and bounded overscan for dense, sparse and edge ranges.

All paths above are relative to `packages/web/src`. Browser performance records
must identify the workload, source revision, viewport and development/production
build. Synthetic receive/display measurements do not prove hardware timing or
on-air behavior.
