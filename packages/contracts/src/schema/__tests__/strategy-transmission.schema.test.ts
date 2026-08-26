import { describe, expect, it } from 'vitest';
import {
  OperatorStatusSchema,
  StrategyStreamSnapshotSchema,
  StrategyTransmissionSchema,
  WSMessageSchema,
} from '../../index.js';

describe('strategy transmission contracts', () => {
  it('carries the current multi-stream transmission set in operator status', () => {
    const currentTransmissions = [
      { streamId: 'stream-1', text: 'JA1AAA BG5DRB OL32', audioFrequencyHz: 1200 },
      { streamId: 'stream-2', text: 'JA2BBB BG5DRB R PM95', audioFrequencyHz: 1320 },
      { streamId: 'stream-3', text: 'JA3CCC BG5DRB RR73', audioFrequencyHz: 1440 },
    ];

    expect(StrategyTransmissionSchema.parse(currentTransmissions[0])).toEqual(currentTransmissions[0]);
    expect(OperatorStatusSchema.parse({
      id: 'operator-1',
      isActive: true,
      isTransmitting: true,
      hasTransmitIntent: true,
      currentTransmissions,
      currentSlot: 'parallel',
      context: {
        myCall: 'BG5DRB',
        myGrid: 'OL32',
        targetCall: 'JA1AAA',
      },
      strategy: {
        name: 'ww-digi',
        state: 'parallel',
        availableSlots: ['TX6'],
      },
    }).currentTransmissions).toEqual(currentTransmissions);
  });

  it('rejects empty text and invalid audio frequencies', () => {
    expect(StrategyTransmissionSchema.safeParse({
      streamId: 'stream-1',
      text: '',
      audioFrequencyHz: 1200,
    }).success).toBe(false);
    expect(StrategyTransmissionSchema.safeParse({
      streamId: 'stream-1',
      text: 'CQ WW BG5DRB OL32',
      audioFrequencyHz: 5001,
    }).success).toBe(false);
  });

  it('accepts strategy-defined stream states and a lifecycle-scoped switch command', () => {
    expect(StrategyStreamSnapshotSchema.parse({
      streamId: 'stream-7',
      currentState: 'awaiting-confirmation',
      audioFrequencyHz: 1320,
      qsoLifecycleEpoch: 4,
      stateOptions: [{
        id: 'send-final',
        label: 'stateSendFinal',
        transmitText: 'JA1AAA BG5DRB RR73',
      }],
    }).stateOptions?.[0]?.id).toBe('send-final');

    expect(WSMessageSchema.parse({
      type: 'setOperatorStreamState',
      timestamp: new Date().toISOString(),
      data: {
        operatorId: 'operator-1',
        streamId: 'stream-7',
        stateId: 'send-final',
        expectedLifecycleEpoch: 4,
      },
    }).type).toBe('setOperatorStreamState');
  });

  it('accepts plugin-declared actions and lifecycle-scoped action invocations', () => {
    const stream = StrategyStreamSnapshotSchema.parse({
      streamId: 'stream-1',
      currentState: 'recovering',
      audioFrequencyHz: 1500,
      qsoLifecycleEpoch: 7,
      completion: { state: 'committed', recordId: 'qso-1' },
      attentions: [{ id: 'needs-action', tone: 'warning', title: 'attentionTitle', actionIds: ['reply'] }],
      actions: [{
        id: 'reply', label: 'replyLabel', icon: 'paper-plane', tone: 'primary', presentation: 'primary',
        input: { kind: 'audio-frequency', value: 1500, min: 100, max: 5000, step: 10, spectrumPick: true },
      }],
    });
    expect(stream.actions?.[0]?.id).toBe('reply');

    expect(WSMessageSchema.parse({
      type: 'invokeOperatorStrategyAction',
      timestamp: new Date().toISOString(),
      data: {
        operatorId: 'operator-1',
        target: { kind: 'stream', streamId: 'stream-1', lifecycleEpoch: 7 },
        actionId: 'reply',
        payload: { value: 1600 },
      },
    }).type).toBe('invokeOperatorStrategyAction');
  });
});
