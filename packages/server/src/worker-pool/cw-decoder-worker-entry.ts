import { probeDeepCWRuntime, runDeepCWDecode, type CWDecoderWorkerRequest } from './CWDecoderWorkerCore.js';

const initData = readInitData();
const TELEMETRY_INTERVAL_MS = 2_000;
const CPU_ROLLING_WINDOW_MS = 5_000;
const MIN_CPU_SAMPLE_INTERVAL_MS = 25;
const initialCpuSample = {
  timestamp: Date.now(),
  usage: process.cpuUsage(),
};
let cpuSamples = [initialCpuSample];

void initialize();

const telemetryTimer = setInterval(() => {
  sendMessage({ type: 'telemetry', telemetry: buildTelemetry() });
}, TELEMETRY_INTERVAL_MS);
telemetryTimer.unref();

process.on('message', async (message: unknown) => {
  if (isShutdownMessage(message)) {
    clearInterval(telemetryTimer);
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

function calculateCpuSinceRecentWindow(now: number, currentCpu: NodeJS.CpuUsage) {
  cpuSamples.push({ timestamp: now, usage: currentCpu });

  const cutoff = now - CPU_ROLLING_WINDOW_MS;
  while (cpuSamples.length > 2 && (cpuSamples[1]?.timestamp ?? now) <= cutoff) {
    cpuSamples.shift();
  }

  const baseline = cpuSamples[0] ?? { timestamp: now, usage: currentCpu };
  const elapsedMs = now - baseline.timestamp;
  if (elapsedMs < MIN_CPU_SAMPLE_INTERVAL_MS) {
    return {
      user: 0,
      system: 0,
      total: 0,
    };
  }

  const elapsedUs = Math.max(elapsedMs * 1000, 1);
  const userUs = currentCpu.user - baseline.usage.user;
  const sysUs = currentCpu.system - baseline.usage.system;

  const user = (userUs / elapsedUs) * 100;
  const system = (sysUs / elapsedUs) * 100;
  return {
    user,
    system,
    total: user + system,
  };
}

function buildTelemetry() {
  const now = Date.now();
  const memory = process.memoryUsage();
  const cpuUsage = process.cpuUsage();
  return {
    pid: process.pid,
    uptimeSeconds: process.uptime(),
    memory: {
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      rss: memory.rss,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
    },
    cpu: calculateCpuSinceRecentWindow(now, cpuUsage),
    cpuUsage,
    lastSeenAt: now,
  };
}
