# Assisted QSO queue ownership

The built-in `assisted-qso-queue` strategy owns target selection and pending
protocol context. It uses the public `ParallelQSOCoordinator` toolkit and one
`StandardQSOProtocolLane` per active stream. Each lane delegates TX1–TX5 protocol
progression to the standard QSO runtime. The Host still owns authorization,
target/carrier reservations, encoding, audio, PTT and durable QSO completion.

## Queue and protocol lanes

The strategy declares `targetQueue: 1`, `parallelTargetQueue: 1`,
`queueActivation: 'immediate'` and a maximum of three concurrent streams.
`parallelStreams` defaults to one; the effective count is limited by both the
requested setting and `ctx.operator.maxConcurrentStreams`. The queue is bounded
to 64 targets. A single-active-entry assumption is valid only when the effective
stream count is one, not as a general Host or queue invariant.

The coordinator owns entry order, target uniqueness, stream bindings and queue
revision. Protocol lanes own their active exchange and completion state. Idle
entries retain short-lived evidence rather than independent protocol engines.
Reconfiguration, checkpoint/restore and reset must keep bindings and lane state
consistent. Checkpoints support speculative invocation rollback; they are not
persistent restart recovery.

## Input and execution

Manual target selection enters through the queue capability. Reliable CALL or
SIGNAL_REPORT frames explicitly addressed to the operator may create an inbound
entry. Ordinary CQ and partial decodes cannot automatically create targets.
Observations continue with main TX off, refreshing existing entries without
starting the operator or producing transmit text.

Fresh direct opportunities may be promoted ahead of ordinary waiting targets;
active bindings are not draggable. Pending evidence expires after six mode
slots; after twelve slots without evidence, a paused entry becomes inactive.
Fresh reliable evidence can make waiting entries eligible again. Manual retry
is limited to the strategy's retryable no-response state, not every inactive or
ambiguous target.

`PluginManager` and `DecisionOrchestrator` serialize mutations/observations in
the operator intent lane and fence superseded invocations. Manual enqueue may
use `startIfIdle` only after its authoritative pre-mutation empty-queue check
and accepted mutation. Automatic observations never imply a start command.

Main TX permission, strategy transmit intent and physical PTT are different
facts. The strategy emits declarative per-stream transmissions and completion
requests; the Host validates and reserves them before encoding. When permitted
and safe, the wrapper may emit one idle CQ if no queued/active exchange needs
work. Review or unresolved closing state must not be hidden by idle CQ.

Normal autocall and direct request-call routes cannot bypass the active queue
strategy. The standard delegate's automatic CQ reply, stopped wake and
post-QSO resume policies are disabled through effective runtime configuration;
the user's saved settings are not rewritten. Shared settings and quick controls
follow plugin definitions rather than Host branches keyed to this plugin name.

## Projection and commands

The source of truth for public fields is `packages/plugin-api/src/runtime.ts`;
wire validation lives in `packages/contracts/src/schema/websocket.schema.ts`.
Do not copy full TypeScript interfaces into this document.

`StrategyRuntimeSnapshot.queue` projects a versioned ordered row list,
`activeEntryIds`, effective `maxActiveStreams` and requested stream count.
`activeEntryId` projects the first active entry for older consumers. Rows can
include their stream identity and reserved audio frequency. Browser components
consume this projection and plugin-declared actions; they do not schedule QSO
lanes or infer physical transmission from a display phase.

The five queue commands are `operatorQueueEnqueue`, `operatorQueueReorder`,
`operatorQueueRetry`, `operatorQueueRemove` and `operatorQueueClear`.
Versioned mutations reject stale `expectedVersion` rather than silently applying
a second client's ordering. Enqueue deduplicates target callsigns. Remove/clear
must release affected lane state through the Host's existing interruption and
physical-participation path; other operators/streams must remain intact.

The Web queue's visual entry feedback is derived from snapshots. Reconnect
snapshots establish a baseline instead of replaying historical effects. UI
presentation memory is not a second authoritative queue.

## Completion and lifetime

A protocol completion effect, final reply, physical completion and durable
logbook result are separate facts. Results are correlated to the original
runtime generation, stream and QSO lifecycle. Closing entries cannot be declared
complete merely because a write was requested; failed/ambiguous outcomes remain
visible for review. Accepted writes remain owned by the Host across runtime
transactions; see [persistence durability](persistence-durability.md).

Main TX off and client disconnect preserve the in-memory queue. Strategy
switches, plugin/runtime reset, operator removal and server restart clear it;
reconnecting a browser does not recreate old transmit intent. Snapshot revisions
belong to that runtime lifetime and may restart with a new runtime.

## Source and regression anchors

- `packages/builtin-plugins/src/assisted-qso-queue/index.ts`: feature declaration,
  settings and Host stream limit.
- `packages/builtin-plugins/src/assisted-qso-queue/AssistedQSOQueueRuntime.ts`:
  observations, mutations, projection and lane coordination; adjacent tests.
- `packages/builtin-plugins/src/assisted-qso-queue/StandardQSOProtocolLane.ts`:
  standard protocol delegation and per-stream results.
- `packages/plugin-api/src/toolkit/parallel-qso/ParallelQSOCoordinator.ts`:
  neutral queue/binding mechanism and adjacent tests.
- `packages/server/src/plugin/PluginManager.ts` and `DecisionOrchestrator.ts`:
  invocation, feature gates and decision delivery.
- `packages/server/src/operator/RadioOperatorManager.ts`: execution and physical
  participation boundary.
- `packages/web/src/components/radio/operators/OperatorQueueTable.tsx`: projection
  and interaction; its adjacent tests cover reconnect and queue controls.
