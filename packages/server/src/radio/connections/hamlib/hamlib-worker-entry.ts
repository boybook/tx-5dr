import { HamlibEndpoint } from './HamlibEndpoint.js';
import { HamlibCommandSchema, serializeHamlibError, type HamlibEvent } from './hamlib-protocol.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('HamlibWorker');
const generation = process.env.TX5DR_HAMLIB_GENERATION;
if (!generation || !process.send) throw new Error('Hamlib worker requires its parent IPC channel');
const endpoint = new HamlibEndpoint();
let stopping = false;
let frameInFlight = false;
let latestFrame: HamlibEvent | null = null;

function send(message: Record<string, unknown>, callback?: () => void): void {
  if (!process.connected) return;
  process.send!({ ...message, generation }, (error: Error | null) => {
    if (error && !stopping) logger.warn('Hamlib IPC send failed', { error: error.message });
    callback?.();
  });
}

function sendFrame(payload: HamlibEvent): void {
  if (frameInFlight) { latestFrame = payload; return; }
  frameInFlight = true;
  send({ type: 'event', payload }, () => {
    frameInFlight = false;
    const next = latestFrame;
    latestFrame = null;
    if (next && !stopping) sendFrame(next);
  });
}

endpoint.on('snapshot', snapshot => send({ type: 'snapshot', snapshot }));
endpoint.on('event', payload => payload.event === 'spectrumLine' ? sendFrame(payload) : send({ type: 'event', payload }));
endpoint.on('fault', error => send({ type: 'fault', error: serializeHamlibError(error) }));
const heartbeat = setInterval(() => endpoint.publishSnapshot(), 1000);
heartbeat.unref();
endpoint.publishSnapshot();
send({ type: 'ready', version: 1 });

process.on('message', input => {
  const parsed = HamlibCommandSchema.safeParse(input);
  if (!parsed.success || parsed.data.generation !== generation || stopping) return;
  const { id, operation, args } = parsed.data;
  void endpoint.call(operation, args).then(result => {
    send({ type: 'result', id, operation, result });
  }, error => send({ type: 'error', id, error: serializeHamlibError(error) }));
});

function shutdown(): void {
  if (stopping) return;
  stopping = true;
  latestFrame = null;
  clearInterval(heartbeat);
  void endpoint.call('disconnect', ['worker shutdown']).finally(() => process.exit(0));
}
process.on('disconnect', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
