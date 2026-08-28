import { describe, expect, it } from 'vitest';
import type { OperatorStatus } from '@tx5dr/contracts';
import { resolveOperatorTargetCallsigns } from './operatorTargets';

function operator(context: Partial<OperatorStatus['context']>): OperatorStatus {
  return {
    id: 'operator-1',
    isActive: true,
    isTransmitting: false,
    context: { myCall: 'BG5DRB', myGrid: 'OL32', targetCall: '', ...context },
    strategy: { name: 'test', state: 'idle', availableSlots: [] },
  };
}

describe('operator target projection', () => {
  it('uses the canonical array for single and multi-slot operators', () => {
    expect(resolveOperatorTargetCallsigns(operator({ targetCalls: ['ja1aaa'] }))).toEqual(['JA1AAA']);
    expect(resolveOperatorTargetCallsigns(operator({
      targetCall: 'JA1AAA',
      targetCalls: ['ja1aaa', 'JA2BBB', 'JA2BBB'],
    }))).toEqual(['JA1AAA', 'JA2BBB']);
  });

  it('falls back to the primary compatibility target for an older server', () => {
    expect(resolveOperatorTargetCallsigns(operator({ targetCall: 'ja1aaa' }))).toEqual(['JA1AAA']);
  });
});
