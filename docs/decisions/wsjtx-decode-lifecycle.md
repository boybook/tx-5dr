# WSJT-X staged decode lifecycle

Status: accepted. Scope: FT8/FT4 receive decoding backed by wsjtx-lib 2.2.x
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

`SlotScheduler` owns whether a slot continues to produce receive work. If
transmit policy changes between windows, capture fails, or the clock's mode or
window schedule is reset, it cancels the remaining session through
`IDecodeQueue.cancelSession`. Cancellation is terminal for that slot, including
audio captures already awaiting completion. A scheduler generation invalidates
captures across stop/restart and clock resets. The scheduler retains at most
eight slot records and a retirement watermark, so skipped final windows cannot
grow its depth/cancellation cache. Positive-offset final windows from the prior
slot remain valid.

The process pool owns native exclusivity and cleanup. Cancelled queued requests
settle immediately; an active native call retains its original execution
timeout and drains before an `end-session` IPC command is sent. That command
and its `session-ended` acknowledgement are runtime-validated and carry a
command ID and session ID. The worker cannot be assigned a different session
until cleanup is acknowledged. A late response from a removed worker or an old
cleanup command cannot release a newer session. Final-window results already
confirm native cleanup. The work queue suppresses cancelled results even when
cancellation occurs between promise resolution and downstream delivery.

A pool-owned one-second maintenance timer, using monotonic elapsed time, ends
idle reservations after 20 seconds without further work. This exceeds the
supported FT8/FT4 window spacing. Queued work expires after 20 seconds of waiting;
this bound is separate from the active-job timeout and from the decision
deadline. Recent closed session IDs are retained in a bounded 256-entry set;
the scheduler's generation and retirement watermark additionally prevent its
older captures from recreating sessions. Cleanup acknowledgement uses the
worker startup timeout (10 seconds by default); failure retires and replaces
only that worker. All worker removal paths settle affected jobs and discard
session references and timers. Ordinary cancellation does not emit decode
errors or alter radio/PTT state.

After attempting reclamation and dispatch, maintenance detects queued demand
with no dispatch or successful completion for 20 seconds. A cleanup currently
within its acknowledgement timeout gets time to finish first. A sustained
stall uses the existing `unavailable` health status with `queue-stalled` as its
reason; successful decode completion clears it. Queue expiry alone does not
clear an incident. The existing administrator WebSocket warning and handshake
hint cover both worker failures and stalls, retaining the client's 60-second
toast cooldown. Normal cancellation and timely reclamation are quiet.

Production diagnostics are owned by the server pool, whose logger is enabled
at INFO by default. Every 30 seconds it emits progress and cancellation counts,
oldest queue wait, last progress age, and each worker's reservation, active job
and cleanup state. Per-job completion and IPC backpressure details are DEBUG;
PCM and decoded message contents are not part of these summaries. Maintenance
and summaries run even without new requests, and are disposed with the pool.

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
