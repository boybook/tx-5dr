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

  it('accepts protocol-neutral history presentation, navigation and transmit gates', () => {
    expect(StrategyRuntimeSnapshotSchema.safeParse({
      currentState: 'idle',
      actions: [{
        id: 'open-settings',
        label: 'openSettings',
        navigation: { kind: 'plugin-page', pageId: 'settings' },
      }],
      messagePresentation: {
        revision: 2,
        mode: 'replace-logbook',
        subject: 'sender-callsign',
        partitionBy: 'band',
        eligiblePartitions: ['20M'],
        defaultClass: 'new',
        classes: {
          new: {
            badges: [{ label: 'newCall', tone: 'secondary' }],
            row: { tone: 'secondary', background: 'soft', accent: true },
            emphasisWhen: [
              { firstTokenIn: ['CQ'] },
              { anyTokenIn: ['RR73', 'RRR', '73'] },
            ],
          },
          worked: { textDecoration: 'line-through', opacity: 'muted' },
        },
        assignments: [{ subject: 'JA1AAA', partition: '20M', classId: 'worked' }],
        noveltyRules: [{
          fact: 'grid-field-2', knownValuesByPartition: { '20M': ['PM'] }, classId: 'new',
        }],
        tagRules: [{
          id: 'cq', match: { firstTokenIn: ['CQ'] }, badge: { label: 'CQ', tone: 'primary' },
        }],
      },
      transmitGate: { allowed: false, reason: 'confirmSettings', actionId: 'open-settings' },
    }).success).toBe(true);
  });
});
