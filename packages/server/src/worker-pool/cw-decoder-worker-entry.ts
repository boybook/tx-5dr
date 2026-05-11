import { probeDeepCWRuntime, runDeepCWDecode, type CWDecoderWorkerRequest } from './CWDecoderWorkerCore.js';

const initData = readInitData();
void initialize();

process.on('message', async (message: unknown) => {
  if (isShutdownMessage(message)) {
    process.exit(0);
  }
  const request = message as CWDecoderWorkerRequest;
  try {
    sendMessage({ type: 'result', id: request.id, result: await runDeepCWDecode(request), telemetry: buildTelemetry() });
  } catch (error) {
    sendMessage({ type: 'error', error: error instanceof Error ? error.message : String(error), id: request.id, telemetry: buildTelemetry() });
  }
});

async function initialize(): Promise<void> {
  const probe = probeDeepCWRuntime(initData?.modelPath);
  if (!probe.available) {
    sendMessage({ type: 'error', error: probe.error ?? 'DeepCW runtime is unavailable', telemetry: buildTelemetry() });
    return;
  }

  try {
    await runDeepCWDecode({
      id: 0,
      audio: new Float32Array(9_600),
      sampleRate: 9_600,
      modelPath: initData?.modelPath,
      runtimeBackend: initData?.runtimeBackend,
      modelSize: initData?.modelSize,
      language: initData?.language,
      targetFreqHz: initData?.targetFreqHz,
      filterWidthHz: initData?.filterWidthHz,
    });
    sendMessage({ type: 'ready', telemetry: buildTelemetry() });
  } catch (error) {
    sendMessage({ type: 'error', error: error instanceof Error ? error.message : String(error), telemetry: buildTelemetry() });
  }
}

function readInitData(): Partial<CWDecoderWorkerRequest> | undefined {
  const raw = process.env.TX5DR_CW_DECODER_INIT;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Partial<CWDecoderWorkerRequest>;
  } catch {
    return undefined;
  }
}

function isShutdownMessage(message: unknown): boolean {
  return Boolean(message) && typeof message === 'object' && (message as { type?: unknown }).type === 'shutdown';
}

function sendMessage(message: unknown): void {
  process.send?.(message);
}

function buildTelemetry() {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    uptimeSeconds: process.uptime(),
    memory: {
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      rss: memory.rss,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
    },
    cpu: {
      user: cpu.user / 1000,
      system: cpu.system / 1000,
      total: (cpu.user + cpu.system) / 1000,
    },
    lastSeenAt: Date.now(),
  };
}
