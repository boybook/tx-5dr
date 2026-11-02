# Logbook and sync performance checks

`scripts/benchmarks/auto-upload.mjs` exercises automatic sync with synthetic
logbooks, plugin storage and fixture network responses. Build the repository
first, then run:

```sh
NODE_ENV=production LOG_LEVEL=error node scripts/benchmarks/auto-upload.mjs --output /tmp/tx5dr-auto-upload.json
NODE_ENV=production LOG_LEVEL=error node scripts/benchmarks/auto-upload.mjs --queue-only --output /tmp/tx5dr-upload-queue.json
```

The tool uses its own temporary data and does not prove live provider
compatibility, RF timing or device audio continuity. Preserve runtime/OS,
source revision, dataset size, concurrency and raw measurements with each run.
Keep dated result tables in run artifacts or the issue/PR, not this reference.

Measure event-loop stalls separately from total operation time and remote I/O.
Count full snapshots, checkpoint bytes and memory as well as latency. A
cooperative rewrite still rewrites the whole ADIF file and holds the transaction
boundary; yielding does not remove that work or prove a fixed latency bound.
Do not relax durability, receipt persistence or transaction fencing to improve
a benchmark. See [persistence durability](../architecture/persistence-durability.md)
and the automatic-sync section of the [plugin guide](../plugin-system.md).

Focused server checks include `test:logbook-performance` and
`test:station-integration`; inspect `packages/server/package.json` for their
current commands. Run latency-sensitive measurements without a competing build
or full test suite. Record timeouts/failures and distinguish an isolated rerun
from a clean full-suite result.
