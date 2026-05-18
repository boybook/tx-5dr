import { describe, expect, it, vi } from 'vitest';
import { createMockContext, createMockSlotInfo } from '@tx5dr/plugin-api/testing';
import type { QSORecord } from '@tx5dr/contracts';
import { autocallOperatorRotationPlugin } from './index.js';

function buildRequest(candidates: Array<{ operatorId: string; operatorCallsign: string }>) {
  return {
    slotInfo: createMockSlotInfo({ id: 'slot-1', startMs: 15_000, cycleNumber: 1 }),
    callsign: 'JA1AAA',
    candidates: candidates.map((candidate) => ({
      operatorId: candidate.operatorId,
      operatorCallsign: candidate.operatorCallsign,
      callsign: 'JA1AAA',
      sourcePluginName: 'watched-callsign-autocall',
    })),
  };
}

describe('autocall-operator-rotation', () => {
  it('rotates by manual operator order and advances after fail threshold or success', () => {
    const ctx = createMockContext({
      config: {
        mode: 'manual',
        manualOrder: ['BG4IBX', 'BG4IAJ'],
        failAdvanceThreshold: 2,
        avoidImmediateRepeatInRandom: true,
      },
    });

    const hook = autocallOperatorRotationPlugin.hooks?.onResolveAutoCallOperator;
    const onQSOFail = autocallOperatorRotationPlugin.hooks?.onQSOFail;
    const onQSOComplete = autocallOperatorRotationPlugin.hooks?.onQSOComplete;
    expect(hook).toBeTypeOf('function');
    expect(onQSOFail).toBeTypeOf('function');
    expect(onQSOComplete).toBeTypeOf('function');

    const request = buildRequest([
      { operatorId: 'operator-1', operatorCallsign: 'BG4IAJ' },
      { operatorId: 'operator-2', operatorCallsign: 'BG4IBX' },
    ]);

    const first = hook!(request, ctx);
    expect(first).toEqual({ selectedOperatorId: 'operator-2' });

    onQSOFail!({ targetCallsign: 'JA1AAA', reason: 'timeout' }, ctx);
    const second = hook!(request, ctx);
    expect(second).toEqual({ selectedOperatorId: 'operator-2' });

    onQSOFail!({ targetCallsign: 'JA1AAA', reason: 'timeout' }, ctx);
    const third = hook!(request, ctx);
    expect(third).toEqual({ selectedOperatorId: 'operator-1' });

    onQSOComplete!({ callsign: 'JA1AAA' } as unknown as QSORecord, ctx);
    const fourth = hook!(request, ctx);
    expect(fourth).toEqual({ selectedOperatorId: 'operator-2' });
  });

  it('falls through to available manual-order candidates when the next operator is unavailable', () => {
    const ctx = createMockContext({
      config: {
        mode: 'manual',
        manualOrder: ['BG4IBX', 'BG4IAJ'],
        failAdvanceThreshold: 1,
      },
    });

    const hook = autocallOperatorRotationPlugin.hooks?.onResolveAutoCallOperator;
    const onQSOComplete = autocallOperatorRotationPlugin.hooks?.onQSOComplete;

    const both = buildRequest([
      { operatorId: 'operator-1', operatorCallsign: 'BG4IAJ' },
      { operatorId: 'operator-2', operatorCallsign: 'BG4IBX' },
    ]);
    expect(hook!(both, ctx)).toEqual({ selectedOperatorId: 'operator-2' });

    onQSOComplete!({ callsign: 'JA1AAA' } as unknown as QSORecord, ctx);

    const onlyOne = buildRequest([
      { operatorId: 'operator-1', operatorCallsign: 'BG4IAJ' },
    ]);
    expect(hook!(onlyOne, ctx)).toEqual({ selectedOperatorId: 'operator-1' });
  });

  it('avoids immediate repeat in random mode when multiple candidates are available', () => {
    const ctx = createMockContext({
      config: {
        mode: 'random',
        failAdvanceThreshold: 1,
        avoidImmediateRepeatInRandom: true,
      },
    });

    const hook = autocallOperatorRotationPlugin.hooks?.onResolveAutoCallOperator;
    const onQSOComplete = autocallOperatorRotationPlugin.hooks?.onQSOComplete;
    const request = buildRequest([
      { operatorId: 'operator-1', operatorCallsign: 'BG4IAJ' },
      { operatorId: 'operator-2', operatorCallsign: 'BG4IBX' },
    ]);

    const randomSpy = vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0);

    expect(hook!(request, ctx)).toEqual({ selectedOperatorId: 'operator-1' });
    onQSOComplete!({ callsign: 'JA1AAA' } as unknown as QSORecord, ctx);
    expect(hook!(request, ctx)).toEqual({ selectedOperatorId: 'operator-2' });

    randomSpy.mockRestore();
  });
});
