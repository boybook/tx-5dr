// External fault injection for isolated station-test runs. The runner loads this
// module with NODE_OPTIONS=--import into the station server and its decode
// workers; product code has no test-only path. Faults act at process boundaries:
//   decodeDelayMs   delays each station decode result on its way back from the
//                   decode worker (order preserved). The virtual peer runs its
//                   own pool with `peer-` slot ids and is not delayed.
//   boundaryStallMs blocks the server main thread across every slot boundary,
//                   like a busy host, so slot timers fire late together.
// Every applied fault is appended to TX5DR_STATION_FAULT_LOG as evidence; the
// runner fails a case whose requested fault never took effect.
import { appendFileSync } from 'node:fs';

const spec = JSON.parse(process.env.TX5DR_STATION_FAULTS || '{}');
const logPath = process.env.TX5DR_STATION_FAULT_LOG;
const between = ([min, max]) => min + Math.random() * (max - min);
const record = entry => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
};

if (process.env.TX5DR_DECODE_WORKER_ID && spec.decodeDelayMs && typeof process.send === 'function') {
  const send = process.send.bind(process);
  let lastDeliveryAt = 0;
  process.send = (message, ...rest) => {
    const slotId = String(message?.result?.slotId ?? '');
    if (message?.type !== 'result' || !slotId || slotId.startsWith('peer-')) return send(message, ...rest);
    const now = Date.now();
    // A later window never overtakes an earlier one, as with a slow decoder.
    const deliveryAt = Math.max(now + between(spec.decodeDelayMs), lastDeliveryAt);
    lastDeliveryAt = deliveryAt;
    setTimeout(() => send(message, ...rest), deliveryAt - now);
    record({ fault: 'decode-delay', slotId, windowIdx: message.result.windowIdx, delayMs: Math.round(deliveryAt - now) });
    return true;
  };
}

const isStationServer = !process.env.TX5DR_DECODE_WORKER_ID
  && /packages[\\/]server[\\/]dist[\\/]index\.js$/.test(process.argv[1] ?? '');
if (isStationServer && spec.boundaryStallMs && spec.slotMs > 0) {
  const arm = () => {
    const untilBoundary = spec.slotMs - (Date.now() % spec.slotMs);
    setTimeout(() => {
      const started = Date.now();
      const end = started + between(spec.boundaryStallMs);
      while (Date.now() < end) { /* busy host across the slot boundary */ }
      record({ fault: 'boundary-stall', stalledMs: Date.now() - started });
      setTimeout(arm, 100).unref();
    }, Math.max(0, untilBoundary - 20)).unref();
  };
  arm();
}
