import { describe, expect, it } from 'vitest';
import {
  StrategyRuntimeSnapshotSchema,
  WSMessageSchema,
  WSMessageType,
} from '../../index.js';

describe('operator context report contracts', () => {
  it('accepts null only as an explicit WebSocket clear command', () => {
    expect(WSMessageSchema.safeParse({
      type: WSMessageType.SET_OPERATOR_CONTEXT,
      timestamp: new Date(0).toISOString(),
      data: {
        operatorId: 'operator-1',
        context: {
          reportSent: null,
          reportReceived: null,
        },
      },
    }).success).toBe(true);
  });

  it('keeps normalized strategy snapshots free of nullable reports', () => {
    expect(StrategyRuntimeSnapshotSchema.safeParse({
      currentState: 'TX6',
      context: {
        reportSent: null,
      },
    }).success).toBe(false);

    expect(StrategyRuntimeSnapshotSchema.safeParse({
      currentState: 'TX6',
      context: {
        reportSent: 0,
        reportReceived: 0,
      },
    }).success).toBe(true);
  });
});
