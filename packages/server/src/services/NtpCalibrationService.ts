import * as dgram from 'node:dgram';
import { EventEmitter } from 'eventemitter3';
import type { ClockSourceSystem } from '@tx5dr/core';
import type { ClockIndicatorState, ClockStatusDetail, ClockStatusSummary, ClockSyncState } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';
import { DEFAULT_NTP_SERVERS } from './ntpServers.js';

const logger = createLogger('NtpCalibration');

/** NTP epoch (1900-01-01) to Unix epoch (1970-01-01) offset in seconds */
const NTP_EPOCH_OFFSET = 2208988800;

const NTP_PORT = 123;
const QUERY_TIMEOUT_MS = 5000;
const SAMPLE_COUNT = 4;
const SAMPLE_INTERVAL_MS = 250;
const SYNC_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const WARN_THRESHOLD_MS = 50;
const ALERT_THRESHOLD_MS = 100;

interface NtpCalibrationServiceEvents {
  statusChanged: (status: ClockStatusSummary) => void;
}

/**
 * NTP time calibration service.
 * Periodically measures the offset between system clock and NTP servers,
 * but never auto-applies the measured value to the engine clock.
 */
export class NtpCalibrationService extends EventEmitter<NtpCalibrationServiceEvents> {
  private readonly clockSource: ClockSourceSystem;
  private servers: string[];
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private measurementPromise: Promise<void> | null = null;
  private measuredOffsetMs = 0;
  private appliedOffsetMs = 0;
  private lastSyncTime: number | null = null;
  private syncState: ClockSyncState = 'never';
  private serverUsed: string | null = null;
  private errorMessage: string | null = null;

  constructor(clockSource: ClockSourceSystem, servers: string[] = [...DEFAULT_NTP_SERVERS]) {
    super();
    this.clockSource = clockSource;
    this.servers = [...servers];
    this.appliedOffsetMs = this.clockSource.getCalibrationOffsetMs();
  }

  async start(): Promise<void> {
    logger.info('Starting NTP calibration service');

    // Perform initial measurement in background.
    this.performMeasurement().catch(() => {});

    this.intervalTimer = setInterval(() => {
      this.performMeasurement().catch(() => {});
    }, SYNC_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    logger.info('NTP calibration service stopped');
  }

  getStatus(): ClockStatusDetail {
    return {
      measuredOffsetMs: this.measuredOffsetMs,
      appliedOffsetMs: this.appliedOffsetMs,
      lastSyncTime: this.lastSyncTime,
      syncState: this.syncState,
      serverUsed: this.serverUsed,
      errorMessage: this.errorMessage,
      indicatorState: this.getIndicatorState(),
    };
  }

  getBroadcastStatus(): ClockStatusSummary {
    return {
      appliedOffsetMs: this.appliedOffsetMs,
      indicatorState: this.getIndicatorState(),
    };
  }

  /**
   * Set a manual offset value and apply it to the clock source.
   */
  setAppliedOffset(offsetMs: number): void {
    this.appliedOffsetMs = offsetMs;
    this.clockSource.setCalibrationOffsetMs(offsetMs);
    logger.info(`Manual clock offset applied: ${offsetMs.toFixed(1)}ms`);
    this.emitStatusChanged();
  }

  /**
   * Trigger an immediate NTP measurement without applying the result.
   */
  async triggerMeasurement(): Promise<void> {
    await this.performMeasurement();
  }

  setServers(servers: string[]): void {
    this.servers = [...servers];
    logger.info(`Updated NTP server list: ${this.servers.join(', ')}`);
  }

  private getIndicatorState(): ClockIndicatorState {
    if (this.syncState === 'never') return 'never';
    if (this.syncState === 'failed') return 'failed';
    if (this.syncState === 'stale') return 'stale';

    const effectiveDrift = Math.abs(this.measuredOffsetMs - this.appliedOffsetMs);
    if (effectiveDrift > ALERT_THRESHOLD_MS) return 'alert';
    if (effectiveDrift > WARN_THRESHOLD_MS) return 'warn';
    return 'ok';
  }

  private emitStatusChanged(): void {
    this.emit('statusChanged', this.getBroadcastStatus());
  }

  private async performMeasurement(): Promise<void> {
    if (this.measurementPromise) {
      return this.measurementPromise;
    }

    this.measurementPromise = this.runMeasurement().finally(() => {
      this.measurementPromise = null;
    });
    return this.measurementPromise;
  }

  private async runMeasurement(): Promise<void> {
    let lastError: Error | null = null;

    for (const server of this.servers) {
      try {
        const samples: number[] = [];
        for (let i = 0; i < SAMPLE_COUNT; i += 1) {
          if (i > 0) {
            await sleep(SAMPLE_INTERVAL_MS);
          }
          const offset = await this.queryNtpServer(server);
          samples.push(offset);
        }

        const medianOffset = median(samples);
        this.measuredOffsetMs = Math.round(medianOffset * 10) / 10;
        this.lastSyncTime = Date.now();
        this.syncState = 'synced';
        this.serverUsed = server;
        this.errorMessage = null;

        if (Math.abs(this.measuredOffsetMs) > 500) {
          logger.warn(`Large NTP offset detected: ${this.measuredOffsetMs.toFixed(1)}ms`);
        } else {
          logger.info(`NTP measurement completed: offset=${this.measuredOffsetMs.toFixed(1)}ms`, { server });
        }

        this.emitStatusChanged();
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.debug(`NTP query failed: ${lastError.message}`, { server });
      }
    }

    const errorMsg = lastError?.message ?? 'Unknown error';
    logger.warn(`NTP measurement failed on all servers: ${errorMsg}`);
    this.syncState = this.lastSyncTime ? 'stale' : 'failed';
    this.errorMessage = errorMsg;
    this.emitStatusChanged();
  }

  private queryNtpServer(server: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      const packet = Buffer.alloc(48);
      packet[0] = 0x1b;

      const t0 = Date.now();
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.close();
          reject(new Error(`NTP query to ${server} timed out`));
        }
      }, QUERY_TIMEOUT_MS);

      socket.on('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          socket.close();
          reject(error);
        }
      });

      socket.on('message', (msg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.close();

        if (msg.length < 48) {
          reject(new Error(`Invalid NTP response: ${msg.length} bytes`));
          return;
        }

        const t3 = Date.now();
        const t1 = readNtpTimestamp(msg, 32);
        const t2 = readNtpTimestamp(msg, 40);
        const offset = ((t1 - t0) + (t2 - t3)) / 2;
        resolve(offset);
      });

      socket.send(packet, NTP_PORT, server, (error) => {
        if (error && !settled) {
          settled = true;
          clearTimeout(timeout);
          socket.close();
          reject(error);
        }
      });
    });
  }
}

function readNtpTimestamp(buf: Buffer, offset: number): number {
  const seconds = buf.readUInt32BE(offset);
  const fraction = buf.readUInt32BE(offset + 4);
  return (seconds - NTP_EPOCH_OFFSET) * 1000 + (fraction / 0x100000000) * 1000;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
