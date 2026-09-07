# WSJT-X staged decode lifecycle

Status: accepted. Scope: FT8/FT4 receive decoding backed by wsjtx-lib 2.1.x
with the WSJT-X 3.0.2 decoder sources.

The decode-window preset remains the owner of receive timing and window count.
It is not duplicated by the native library. FT8 windows derive the native stage
from the available duration in 288 ms half-symbol units and use the standard
41, 47, 49, and 50 stages. Repeated final stages are idempotent. FT4 keeps its
existing partial/final windows and passes the selected depth to the FT4 decoder.

Decode depth is a user setting shared by FT8 and FT4. Values are 1 (Fast), 2
(Normal), and 3 (Deep); missing configuration defaults to 3. The selected
depth is captured at slot start and is passed unchanged to every stage. The
runtime does not silently change depth based on CPU load, elapsed time, or
signal quality.

The native library exposes an explicit per-slot session. A session owns the
41/47/49/50 state, UTC, subtraction/OSD/AP state, and stage results. The
legacy one-shot decode remains available and runs an isolated final decode. A
worker process serializes native calls and the process pool keeps all stages of
one slot on the same worker. Session state is reset or ended on slot change,
final window, worker failure, or explicit cancellation.

Stage results are incremental; SlotPackManager remains responsible for
cross-window message de-duplication and final slot persistence. Decode history
records the configured depth, native stage, native processing time, and late
completion state. Performance telemetry is observational and does not select a
different depth.

The process pool keeps a bounded native-duration sample and exposes p50/p95
timing in worker telemetry. Queue wait, native duration, stage counters, and
the decision-deadline result are retained for performance review without
changing the selected depth.

Within a worker, staged windows reuse the already converted prefix when the
new PCM is an unchanged extension of the same slot. A corrected prefix
invalidates that cache and is converted in full. Repeated native stages are
rejected before resampling or conversion, so duplicate windows do not spend
work merely to reconstruct session context.

Post-cycle retry is an explicit, optional operation. It does not add a normal
decode-window preset. When enabled it uses the selected depth and the WSJT-X
`newdat=false`/`nagain=true` targeted re-decode semantics, subject to the slot
decision deadline.
