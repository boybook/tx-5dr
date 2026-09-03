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
Each browser negotiates its viewport (range and requested display-bin count)
over the spectrum subscription channel. The server projects the shared frame to
that viewport and caches identical projections for the lifetime of the frame,
so multiple operators do not trigger additional FFT work or duplicate crop/
resample work. Browser-side viewport state remains replayable across reconnects.

History capacity and display geometry are separate concerns. The browser keeps
a bounded per-source history, while the waterfall chooses its active texture
row count from the actual canvas height and device-pixel ratio. Resizing a
standalone spectrum window therefore changes the number of rows rendered at
1:1 pixel density and replays retained rows immediately; it does not alter the
radio sampling rate or FFT configuration.

Viewport gestures are coalesced at the browser animation-frame boundary. A
gesture rebuilds only the rows currently visible in the waterfall, and its axis
changes are applied immediately instead of repeatedly restarting a smooth axis
transition. WebSocket viewport writes remain debounced and identical viewport
values are not sent again.

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
a small visual margin. This is a local viewport presentation change and does
not renegotiate the shared TCI sample rate.
