import type { DecodeRequest, DecodeResult } from '@tx5dr/core';
import type { DecodeWorkerCurrentJob, ProcessCpu, ProcessMemory } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';
import { WSJTXDecodeWorkerCore } from './WSJTXDecodeWorkerCore.js';

const logger = createLogger('DecodeWorker');
const workerId = process.env.TX5DR_DECODE_WORKER_ID || String(process.pid ?? 'unknown');
const numericWorkerId = Number.parseInt(workerId, 10);
const configuredNativeThreads = Number.parseInt(process.env.TX5DR_DECODE_NATIVE_THREADS || '1', 10);
const nativeThreads = Number.isFinite(configuredNativeThreads) && configuredNativeThreads > 0 ? configuredNativeThreads : 1;
const configuredTelemetryIntervalMs = Number.parseInt(process.env.TX5DR_DECODE_WORKER_TELEMETRY_INTERVAL_MS || '2000', 10);
const telemetryIntervalMs = Number.isFinite(configuredTelemetryIntervalMs) && configuredTelemetryIntervalMs > 0
  ? configuredTelemetryIntervalMs
  : 2000;
const MIN_CPU_SAMPLE_INTERVAL_MS = 250;
const decoder = new WSJTXDecodeWorkerCore();
let busy = false;
let shuttingDown = false;
let currentJob: DecodeWorkerCurrentJob | undefined;
let lastCpuUsage = process.cpuUsage();
let lastCpuTime = Date.now();

interface DecodeCommand {
  type: 'decode';
  id: number;
  request: DecodeRequest;
}

interface ShutdownCommand {
  type: 'shutdown';
}

type ParentCommand = DecodeCommand | ShutdownCommand;

function send(message: unknown): void {
  if (process.send) {
    process.send(message);
  }
}

function calculateCpuSinceLastSample(now: number): ProcessCpu {
  const currentCpu = process.cpuUsage();
  const elapsedMs = now - lastCpuTime;
  if (elapsedMs < MIN_CPU_SAMPLE_INTERVAL_MS) {
    return {
      user: 0,
      system: 0,
      total: 0,
    };
  }

  const elapsedUs = Math.max(elapsedMs * 1000, 1);
  const userUs = currentCpu.user - lastCpuUsage.user;
  const sysUs = currentCpu.system - lastCpuUsage.system;
  lastCpuUsage = currentCpu;
  lastCpuTime = now;

  const user = (userUs / elapsedUs) * 100;
  const system = (sysUs / elapsedUs) * 100;
  return {
    user,
    system,
    total: user + system,
  };
}

function getMemorySnapshot(): ProcessMemory {
  const mem = process.memoryUsage();
  return {
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    rss: mem.rss,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
  };
}

function sendTelemetry(): void {
  const now = Date.now();
  if (currentJob) {
    currentJob = {
      ...currentJob,
      elapsedMs: now - currentJob.startedAt,
    };
  }

  send({
    type: 'telemetry',
    workerId,
    metrics: {
      workerId: Number.isFinite(numericWorkerId) ? numericWorkerId : 0,
      pid: process.pid,
      ready: true,
      busy,
      nativeThreads,
      uptimeSeconds: process.uptime(),
      memory: getMemorySnapshot(),
      cpu: calculateCpuSinceLastSample(now),
      currentJob,
      lastSeenAt: now,
    },
  });
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    name: 'Error',
    message: String(error),
  };
}

async function handleDecode(command: DecodeCommand): Promise<void> {
  if (busy) {
    send({
      type: 'error',
      id: command.id,
      error: { name: 'Error', message: 'decode worker received concurrent decode command' },
    });
    return;
  }

  busy = true;
  currentJob = {
    jobId: command.id,
    slotId: command.request.slotId,
    windowIdx: command.request.windowIdx,
    mode: command.request.mode,
    startedAt: Date.now(),
    elapsedMs: 0,
    requestAudioDurationMs: command.request.sampleRate > 0
      ? (command.request.pcm.byteLength / Float32Array.BYTES_PER_ELEMENT / command.request.sampleRate) * 1000
      : undefined,
  };
  sendTelemetry();

  try {
    const result: DecodeResult = await decoder.decode(command.request);
    send({ type: 'result', id: command.id, result });
  } catch (error) {
    logger.error('decode failed', { workerId, error: serializeError(error) });
    send({ type: 'error', id: command.id, error: serializeError(error) });
  } finally {
    busy = false;
    currentJob = undefined;
    sendTelemetry();
    if (shuttingDown) {
      process.exit(0);
    }
  }
}

const telemetryTimer = setInterval(sendTelemetry, telemetryIntervalMs);
telemetryTimer.unref();

process.on('message', (message: ParentCommand) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'shutdown') {
    shuttingDown = true;
    if (!busy) {
      process.exit(0);
    }
    return;
  }

  if (message.type === 'decode') {
    void handleDecode(message);
  }
});

process.on('uncaughtException', (error) => {
  logger.error('uncaught exception', serializeError(error));
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', serializeError(reason));
  process.exit(1);
});

send({
  type: 'ready',
  workerId,
  nativeThreads: String(nativeThreads),
});
sendTelemetry();
