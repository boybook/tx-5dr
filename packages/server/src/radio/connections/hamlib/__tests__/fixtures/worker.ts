import { HamlibCommandSchema, type HamlibSnapshot } from '../../hamlib-protocol.js';

const generation = process.env.TX5DR_HAMLIB_GENERATION!;
const snapshot: HamlibSnapshot = {
  state: 'disconnected', healthy: false, lastSuccessfulOperation: Date.now(), levels: [], functions: [], parms: [], vfoOps: [], activities: [],
  meterCapabilities: { strength: false, swr: false, alc: false, power: false, powerWatts: false },
  queue: { busy: false, backpressure: false, criticalActive: false, activeCount: 0, activeTask: null, activeRunMs: null, pendingCount: 0, criticalPendingCount: 0, normalPendingCount: 0, oldestPendingTask: null, oldestPendingWaitMs: null, dedupedTaskCount: 0 },
};
let mode = '';
let frames: ReturnType<typeof setInterval> | undefined;
const send = (message: Record<string, unknown>) => { if (process.connected) process.send!({ ...message, generation }); };
setInterval(() => send({ type: 'snapshot', snapshot }), 20).unref();
send({ type: 'snapshot', snapshot });
send({ type: 'ready', version: 1 });

process.on('message', input => {
  const { operation, args, id } = HamlibCommandSchema.parse(input);
  if (operation === 'connect') {
    mode = (args[0] as { network?: { host: string } }).network?.host ?? '';
    snapshot.state = 'connected'; snapshot.healthy = true;
    send({ type: 'snapshot', snapshot });
  }
  if (operation === 'getFrequency') {
    if (mode === 'crash') process.exit(42);
    if (mode === 'block') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    if (mode === 'hang') {
      snapshot.activities = [{ id, operation, startedAt: Date.now(), timeoutMs: 100 }];
      send({ type: 'snapshot', snapshot });
      return;
    }
    process.send!({ type: 'result', generation: 'old-session', id, operation, result: 1 });
    send({ type: 'result', id, operation, result: 7100000 });
    return;
  }
  if (operation === 'startManagedSpectrum') {
    const data = Buffer.alloc(2048, 128);
    frames = setInterval(() => send({ type: 'event', payload: { event: 'spectrumLine', args: [{ scopeId: 0, dataLevelMin: 0, dataLevelMax: 255, signalStrengthMin: -120, signalStrengthMax: 0, mode: 0, centerFreq: 7100000, spanHz: 100000, lowEdgeFreq: 7050000, highEdgeFreq: 7150000, dataLength: data.length, data, timestamp: Date.now() }] } }), 16);
  }
  if (operation === 'stopManagedSpectrum') clearInterval(frames);
  send({ type: 'result', id, operation, result: undefined });
});
process.on('SIGTERM', () => { if (mode !== 'hang') process.exit(0); });
process.on('disconnect', () => process.exit(0));
