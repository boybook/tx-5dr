import {
  AdifFileStore,
  type AdifFileStoreFaultPoint,
} from '../../AdifFileStore.js';

type CrashOperation = 'append' | 'rewrite';

interface CrashChildMessage {
  type: 'reached' | 'failed';
  point?: AdifFileStoreFaultPoint;
  message?: string;
}

async function send(message: CrashChildMessage): Promise<void> {
  if (!process.send) throw new Error('Crash harness requires an IPC channel');
  await new Promise<void>((resolve, reject) => {
    process.send!(message, (error: Error | null) => error ? reject(error) : resolve());
  });
}

async function pauseForeverAt(point: AdifFileStoreFaultPoint): Promise<void> {
  await send({ type: 'reached', point });
  await new Promise<void>(() => undefined);
}

async function main(): Promise<void> {
  const [filePath, operationValue, faultPointValue, payloadBase64] = process.argv.slice(2);
  if (!filePath || !payloadBase64) throw new Error('Missing crash harness arguments');
  if (operationValue !== 'append' && operationValue !== 'rewrite') {
    throw new Error(`Unsupported crash operation: ${operationValue}`);
  }
  const operation: CrashOperation = operationValue;
  const faultPoint = faultPointValue as AdifFileStoreFaultPoint;
  const payload = Buffer.from(payloadBase64, 'base64');
  const store = new AdifFileStore(filePath, {
    faultHook: ({ point }) => point === faultPoint ? pauseForeverAt(point) : undefined,
  });

  const opened = await store.open();
  if (!opened.generation) throw new Error(`Logbook did not open with a generation: ${opened.status}`);
  if (operation === 'append') {
    await store.commitAppend([payload], opened.generation);
  } else {
    await store.commitRewrite([payload], opened.generation, { recordCount: 1 });
  }
  await send({ type: 'failed', message: `Fault point was not reached: ${faultPoint}` });
}

void main().catch(async (error) => {
  await send({
    type: 'failed',
    message: error instanceof Error ? error.stack ?? error.message : String(error),
  }).catch(() => undefined);
  process.exitCode = 1;
});
