# Spectrum amplitude semantics

TX-5DR keeps spectrum transport and rendering shared while preserving each
source's amplitude reference. `SpectrumFrame.binaryData.format.scale` and
`offset` describe wire decoding only; `SpectrumFrame.meta.level` describes the
resulting level domain and display unit.

Supported radio SDR level domains are:

- `dbfs` / `dBFS`: TCI IQ FFT values referenced to digital full scale.
- `calibrated-db` / `dB`: Hamlib values mapped from the device-reported data
  level range to its signal-strength range.
- `raw` / `Level`: unsigned 8-bit display values without an absolute
  calibration, used by ICOM WLAN and Hamlib fallback frames.

The Web UI uses one shared spectrum component and interaction model, but range
defaults and persisted manual ranges are selected by the level domain. Missing
level metadata on legacy `radio-sdr` frames is interpreted as `raw` / `Level`.

## SDR interaction modes

Radio SDR session state declares a source-owned `viewMode`: `wide` for TCI IQ
and `radio-center` for ICOM WLAN/Hamlib Scope views. The renderer consumes the
declared viewport and overlay capabilities; it does not branch on protocol or
application mode. Frequency overlay targets are explicit: `operator-tx` for
digital baseband offsets, `radio-frequency` for the main carrier, and
`split-frequency` for an independent TX VFO.

In `wide` mode, background gestures manipulate only the client viewport until
its negotiated IQ bounds are reached. Overlay gestures stop propagation and
write their declared target without moving the viewport. In `radio-center`
mode, Scope/center-follow behavior remains authoritative; carrier TX overlays
are non-draggable unless they target a writable Split VFO. Digital operator TX
offsets remain draggable because they do not retune the radio center.

## TCI IQ bandwidth and client view

TCI IQ sample rate is a site-wide radio capability, not a per-client zoom
setting. Capability negotiation exposes the radio's supported IQ sample rates,
and administrators may change the shared applied rate through the radio-control
capability surface. When no value is persisted, the TCI source starts at the
largest rate reported by the negotiated dialect.

TCI analysis settings (FFT size up to 65,536 points, display-bin count, and
analysis interval down to 20 ms) are also global station settings, but are
independent of Profile and exposed as direct sliders only in the TCI SDR view.
Reading requires a viewer session and writing requires `execute:RadioControl`;
the settings are applied to the one shared TCI source so all operators observe
the same analysis quality and frame rate. The effective rate remains bounded by
the TCI source's actual frame arrival rate and the server's CPU/memory budget.

The TCI source keeps one shared high-resolution FFT/display-bin pipeline per
radio connection and publishes absolute frequency ranges with each frame.
Each TCI frame also carries a 512-bin wide-view supplement derived from that
same FFT result. The primary payload is cropped to the negotiated IF/detail
window; the supplement covers the complete negotiated IQ span at intentionally
low resolution. Primary detail bins retain the native max-pool behavior, while
supplement bins use dBFS-to-linear-power averaging with a capped 90th-percentile
boost. This keeps the wide-view noise floor on the same color scale without
losing all contrast from strong signals. Server-side viewport projection
prefers primary bins and falls
back to supplement bins outside the detail window, while the browser retains
both representations for immediate local zoom/pan redraws. The default view
still opens on the high-resolution detail range; the wide range is the allowed
zoom/pan envelope, not an instruction to render the coarse supplement by
default. No second FFT is performed and the supplement is shared across all
client projections.
When the operating VFO frequency changes across a band, the browser waits for
the first frame carrying the new native envelope, then replaces the old
absolute viewport with the new detail/native range and sends that range to the
server. A DDS edge tune does not change the operating VFO frequency and keeps
the existing absolute viewport instead.
Each browser negotiates its viewport (range and requested display-bin count)
over the spectrum subscription channel. The server projects the shared frame to
that viewport and caches identical projections for the lifetime of the frame,
so multiple operators do not trigger additional FFT work or duplicate crop/
resample work. The committed browser `radioSdrViewport` is the single
negotiation source: initialization, automatic digital zoom, band-switch reset,
button zoom, and gesture commit all synchronize through the same debounced
effect. GPU gesture previews never enter that state and therefore never send
per-frame viewport requests. Browser-side viewport state remains replayable
across reconnects.

History capacity and display geometry are separate concerns. The browser keeps
a bounded per-source history, while the waterfall chooses its active texture
row count from the actual canvas height and device-pixel ratio. Resizing a
standalone spectrum window therefore changes the number of rows rendered at
1:1 pixel density and replays retained rows immediately; it does not alter the
radio sampling rate or FFT configuration.

Viewport gestures are coalesced at the browser animation-frame boundary. A
continuous pan/zoom gesture runs in two phases. During the gesture the
waterfall reports `preview` changes: the visible range is applied entirely
GPU-side through the `u_viewAxis` shader uniform (view axis), while the
uploaded detail texture keeps the last committed frequency axis (texture
axis), so no CPU history resampling or texture rebuild happens per gesture
step. Two guards keep the texture axis stable for the whole gesture: the
stream controller freezes its radio SDR view range (`setGestureViewFreeze`)
so server-projected frames, which echo the client's debounced viewport
uploads with one round-trip of lag, cannot re-resolve the view range and
trigger a mid-gesture rebuild; and viewport uploads to the server are
deferred to the gesture end, so the server keeps projecting frames at the
committed viewport and the frozen texture's edges are not eroded by fill
values. DDS edge tuning still runs during the gesture. Where the view axis
extends beyond the detail texture's coverage, the shader falls back to a
second ring texture fed by the wide-envelope supplement rows: the browser
keeps a 512-bin dBFS wide view in a stable secondary axis and cheaply
reprojects incoming supplement rows into that axis. A large DDS center shift
rebases the secondary axis once instead of rebuilding it for every frame, so
gesture pan/zoom stays live at supplement resolution instead of showing
uncovered areas, and areas beyond the supplement envelope still render at the
colormap minimum.
Percent-positioned DOM overlays follow the gesture without a React
re-render: frequency markers (RX/TX lines, band overlays, presets) are
repositioned per element — only `left`/`width` are remapped into the
gesture view axis and restored from per-element snapshots afterwards, so
lines and labels are never scaled — while the ruler ticks are recomputed
from the gesture view range into a pooled imperative DOM layer. Cycle
boundaries use the same pooled render-only path, so incoming rows do not
schedule a component reconciliation. The waterfall ring uploads pack a
catch-up batch into at most two contiguous `texSubImage2D` calls per texture,
and committed rebuilds reuse texture storage and typed-array buffers. When the
gesture ends (pointer release, or the wheel stream going idle), the freeze
is released and a single `commit` change updates the viewport state and
uploads the final viewport, which triggers the existing replace path: one
history re-projection (preferring detail bins and falling back to
supplement bins) and one full texture rebuild at the final range, after
which the view axis returns to identity. Until that replace batch arrives, a
short-lived committed-axis hold prevents newly appended rows from resetting
the optimistic GPU view to the old texture axis. Rebuilds reuse per-frame
projection buffers across viewport changes and one persistent upload
buffer per texture, so the commit does not produce allocation churn.
Legacy callbacks supplied through the old `onLocalViewportChange` prop bypass
the preview path and keep their immediate-commit behavior, preserving the
previous contract.

The spectrum plus/minus controls change only this client viewport; they must not
issue a TCI `IQ_SAMPLERATE` command. Only an explicit horizontal pan that
reaches the native IQ edge may request a radio center frequency change.

For TCI wide-band edge tuning, the radio center change uses the protocol's
`DDS:<receiver>,<frequency>` command rather than the generic VFO frequency
write. The browser keeps one latest-wins request per active gesture (one
physical DDS write in flight, with a single pending replacement), so pointer
move frequency samples cannot build a serialized hardware queue. DDS tuning is
not routed through the normal VFO optimistic-marker path. When the next IQ frame
advertises the shifted native range, the browser rebases the existing absolute
viewport by the native-center delta, preserving its span and sending the
rebased viewport back to the server. Structured browser and server logs record
gesture ranges, DDS targets, viewport updates, and frame ranges for diagnosing
transport or alignment issues.

The rendering split follows browser/WebGL guidance to keep hot-path transforms
on the GPU, reuse texture storage with sub-image uploads, avoid synchronous
layout/readback work, and schedule animation through `requestAnimationFrame`:
[MDN WebGL best practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices)
and the [WebGL texture upload specification](https://registry.khronos.org/webgl/specs/latest/1.0/).
The fragment shader selects `highp` when the device supports it so absolute RF
coordinates retain kHz-level deltas; low-end WebGL1 devices retain a
`mediump` fallback.

## Trace and waterfall presentations

`SpectrumFrame` is the single transport contract for both the inline and
standalone presentations. `SpectrumStreamController` retains and projects each
frame once, then exposes the newest projected row through
`getLatestRenderSnapshot()`. A presentation host may consume the history batches
for the waterfall and that same snapshot for a spectrum trace; it must not open
a second subscription or decode the frame again.

The inline radio page keeps the existing waterfall interaction surface. The
standalone spectrum window opts into a trace-plus-waterfall layout: the trace
owns the TX/RX hit targets, while both trace and waterfall accept the same
background viewport gestures. The lower waterfall is read-only for frequency
overlays but remains an interactive viewport surface. Both renderers use the same absolute axis, viewport,
level range, supplement fallback, and declarative frequency overlays. This
presentation choice is client layout state and is deliberately separate from
the server-owned TCI `wide` versus ICOM/Hamlib `radio-center` capability.

The trace renderer uses persistent current/previous vertex buffers for the
latest projected row. A short shader interpolation smooths new FFT frames, and
a translucent triangle strip fills the area below the line. The controller has
already merged detail and supplement coverage into that one projected row, so
the trace never draws a second coarse fallback line. Pan/zoom changes update
the view-axis uniforms and overlay positions without rebuilding data buffers;
only a new frame token uploads row values.

The standalone host gives both the trace and waterfall the same viewport
interaction contract. An imperative `SpectrumViewportRuntime` broadcasts the
active preview range between the two GPU surfaces without putting wheel/pointer
samples into React state or server negotiation. The originating surface freezes
the controller view for the gesture, both surfaces render the same optimistic
axis, and one final commit releases the freeze and updates the server viewport.
The host keeps the existing waterfall renderer as a compatibility path while
the two render passes migrate toward a shared WebGL surface. Any future
single-surface implementation must preserve the same render-snapshot and
interaction-surface boundaries.

Trace smoothing is display-only and runs after the controller's projection, so
the waterfall and all decode paths retain the raw FFT values. The smoother
first applies an adaptive three-bin median when the bin bandwidth is small
enough to preserve narrow signals, then applies a time-constant EMA. dB/dBFS
frames are converted to linear power before the EMA and converted back only for
the trace; raw `Level` frames use a linear EMA directly. A viewport, source, or
level-domain change resets the smoother to avoid carrying an old band's noise
floor into the new view. The trace VBO still performs its separate short shader
interpolation, which hides frame boundaries but is not a substitute for this
statistical smoothing stage.

During a trace or waterfall viewport preview, if the optimistic view extends
outside the committed detail axis, the trace temporarily draws the shared
wide-envelope supplement in a second persistent VBO. The fragment shader
discards supplement samples inside the detail interval, so the fallback only
fills uncovered edges and never appears as a second line during a settled view.
Supplement uploads are keyed by frame token and are skipped for ordinary
render frames and for preview steps that remain inside detail coverage.

Digital FT8/FT4 operating windows are delivered as declarative frequency
overlays in session state. For TCI, their bounds come from the protocol's
`RX_FILTER_BAND` state (not the wider `IF_LIMITS` capture range). The renderer
only knows how to draw and optionally drag an overlay; the server decides when
an overlay exists, its range, and which frequency target it edits. This keeps
protocol/mode policy out of the generic WebGL component while allowing the same
overlay primitive to support future operating windows.

For Hamlib-backed radios, the same overlay is derived from the current mode's
numeric bandwidth (`getMode().bandwidth`) and sideband orientation. If Hamlib
does not provide a numeric bandwidth, the overlay is omitted rather than using
a guessed fixed range.

When a radio SDR frame arrives before capability state has settled, the browser
may promote an automatic lower-priority selection (such as audio) to
`radio-sdr`; explicit Profile preferences and manual source choices are not
overridden. For TCI FT8/FT4 only, the browser initially shows the complete IQ
range for one second, then animates to the authoritative `RX_FILTER_BAND` with
a small visual margin. The same presentation cycle is keyed by the active mode
and absolute radio frequency, so a frequency change from the radio controls
repeats the full-range preview and follows the new RX window rather than
leaving the old band's viewport in place. The target is projected from the
latest logical operating frequency (the requested VFO value, before a
possibly-lagging physical readback) using the overlay's authoritative filter
offsets while a new IQ frame/session state is in flight; scheduling waits until
the new native envelope covers that target. A frequency drag initiated on the digital overlay
is marked as an explicit user gesture and suppresses that one automatic cycle,
so it does not overwrite the user's chosen position. These are local viewport
presentation changes and do not renegotiate the shared TCI sample rate.
