import { describe, expect, it } from 'vitest';
import {
  AssistedQueueSnapshotSchema,
  PluginManifestSchema,
  WSMessageSchema,
  WSMessageType,
} from '../../index.js';

describe('assisted queue contracts', () => {
  it('accepts the compact UI projection and rejects internal queue details', () => {
    const snapshot = {
      version: 4,
      activeEntryId: 'queue-1',
      rows: [{
        entryId: 'queue-1',
        callsign: 'JA1AAA',
        order: 0,
        draggable: false,
        displayState: 'engaged',
        tone: 'success',
        icon: 'check-circle',
      }, {
        entryId: 'queue-2',
        callsign: 'JA2BBB',
        order: 1,
        draggable: true,
        displayState: 'paused',
        tone: 'neutral',
        icon: 'pause',
        pauseReason: 'stale',
        targetGrid: 'PM95',
        lastSnr: -12,
        lastHeardCyclesAgo: 6,
      }],
    };
    expect(AssistedQueueSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(AssistedQueueSnapshotSchema.strict().safeParse({
      ...snapshot,
      evidence: { raw: 'BG5DRB JA1AAA -08' },
    }).success).toBe(false);
  });

  it('carries the optional targetQueue strategy capability through manifests', () => {
    expect(PluginManifestSchema.parse({
      apiVersion: 2,
      name: 'assisted-qso-queue',
      version: '1.0.0',
      type: 'strategy',
      strategyFeatures: { targetQueue: 1 },
    }).strategyFeatures).toEqual({ targetQueue: 1 });
  });

  it('validates enqueue, reorder, retry, remove, and clear WebSocket commands', () => {
    const commands = [
      {
        type: WSMessageType.OPERATOR_QUEUE_ENQUEUE,
        timestamp: new Date(0).toISOString(),
        data: {
          operatorId: 'operator-1',
          callsign: 'JA1AAA',
          startIfIdle: true,
          selectedFrame: {
            message: 'CQ JA1AAA PM95',
            snr: -10,
            dt: 0.1,
            freq: 1500,
            slotStartMs: 15_000,
          },
        },
      },
      {
        type: WSMessageType.OPERATOR_QUEUE_REORDER,
        timestamp: new Date(0).toISOString(),
        data: {
          operatorId: 'operator-1',
          entryId: 'queue-2',
          beforeEntryId: 'queue-1',
          expectedVersion: 3,
        },
      },
      {
        type: WSMessageType.OPERATOR_QUEUE_RETRY,
        timestamp: new Date(0).toISOString(),
        data: {
          operatorId: 'operator-1',
          entryId: 'queue-2',
          expectedVersion: 4,
        },
      },
      {
        type: WSMessageType.OPERATOR_QUEUE_REMOVE,
        timestamp: new Date(0).toISOString(),
        data: {
          operatorId: 'operator-1',
          entryId: 'queue-2',
          expectedVersion: 5,
        },
      },
      {
        type: WSMessageType.OPERATOR_QUEUE_CLEAR,
        timestamp: new Date(0).toISOString(),
        data: {
          operatorId: 'operator-1',
          expectedVersion: 6,
        },
      },
    ];

    for (const command of commands) {
      expect(WSMessageSchema.safeParse(command).success).toBe(true);
    }
    expect(WSMessageSchema.safeParse({
      ...commands[1],
      data: { ...commands[1]!.data, expectedVersion: -1 },
    }).success).toBe(false);
    expect(WSMessageSchema.safeParse({
      ...commands[0],
      data: { ...commands[0]!.data, startIfIdle: 'yes' },
    }).success).toBe(false);
  });
});
