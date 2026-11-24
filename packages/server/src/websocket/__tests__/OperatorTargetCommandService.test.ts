import { describe, expect, it, vi } from 'vitest';
import { OperatorTargetCommandService } from '../OperatorTargetCommandService.js';

const frame = { message: 'CQ JA1ABC PM95', snr: -8, dt: 0.1, freq: 1200, slotStartMs: 1_700_000_010_000 };

function engine(options: {
  queue?: boolean;
  activation?: 'immediate' | 'operator-toggle';
  call?: unknown;
  enqueue?: unknown;
  operator?: boolean;
} = {}) {
  const pluginManager = {
    hasTargetQueue: vi.fn(() => options.queue === true),
    getTargetQueueActivation: vi.fn(() => options.activation ?? 'immediate'),
    requestCall: vi.fn(async () => options.call ?? { outcome: 'accepted' }),
    enqueueQueueTarget: vi.fn(async () => options.enqueue ?? { outcome: 'accepted' }),
  };
  return {
    pluginManager,
    operatorManager: {
      getOperator: vi.fn(() => (options.operator === false ? undefined : {})),
      emitOperatorStatusUpdate: vi.fn(),
    },
    getStatus: () => ({ currentMode: { name: 'FT8', slotMs: 15_000 } }),
    getSlotPackManager: () => ({ getLastMessageFromCallsign: () => undefined }),
  };
}

describe('OperatorTargetCommandService.selectTarget', () => {
  it('calls directly and answers the picked frame', async () => {
    const fake = engine();
    const result = await new OperatorTargetCommandService(fake as never).selectTarget('op', 'JA1ABC', frame);

    expect(result).toEqual({ status: 'called' });
    expect(fake.pluginManager.requestCall).toHaveBeenCalledWith('op', 'JA1ABC', expect.objectContaining({
      message: expect.objectContaining({ message: 'CQ JA1ABC PM95', snr: -8 }),
      slotInfo: expect.objectContaining({ startMs: frame.slotStartMs, mode: 'FT8' }),
    }), expect.objectContaining({ submitCurrentFrame: true }));
    expect(fake.operatorManager.emitOperatorStatusUpdate).toHaveBeenCalledWith('op');
  });

  it('queues for a target-queue strategy, starting at once unless the operator toggles it', async () => {
    const immediate = engine({ queue: true });
    expect(await new OperatorTargetCommandService(immediate as never).selectTarget('op', 'JA1ABC', frame)).toEqual({ status: 'queued' });
    expect(immediate.pluginManager.enqueueQueueTarget).toHaveBeenCalledWith('op', expect.objectContaining({ callsign: 'JA1ABC' }), { startIfIdle: true });
    expect(immediate.pluginManager.requestCall).not.toHaveBeenCalled();

    const toggled = engine({ queue: true, activation: 'operator-toggle' });
    await new OperatorTargetCommandService(toggled as never).selectTarget('op', 'JA1ABC', frame);
    expect(toggled.pluginManager.enqueueQueueTarget).toHaveBeenCalledWith('op', expect.anything(), { startIfIdle: false });
  });

  it('explains rejections with the same messages as the decode table', async () => {
    const saving = engine({ call: { outcome: 'rejected', reason: 'saving' } });
    expect(await new OperatorTargetCommandService(saving as never).selectTarget('op', 'JA1ABC', frame)).toEqual({
      status: 'rejected', reason: 'saving', userMessageKey: 'radio:operator.callRejection.saving',
    });
    const full = engine({ queue: true, enqueue: { outcome: 'rejected', reason: 'queue_full' } });
    expect(await new OperatorTargetCommandService(full as never).selectTarget('op', 'JA1ABC', frame)).toEqual({
      status: 'rejected', reason: 'queue_full', userMessageKey: 'radio:operator.queueErrors.queueFull',
    });
    const missing = engine({ operator: false });
    expect(await new OperatorTargetCommandService(missing as never).selectTarget('op', 'JA1ABC', frame)).toMatchObject({
      status: 'rejected', reason: 'unavailable',
    });
  });
});
