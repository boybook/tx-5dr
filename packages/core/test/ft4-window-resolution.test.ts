import { test } from 'node:test';
import assert from 'node:assert';
import {
  FT4_WINDOW_PRESETS,
  MODES,
  resolveWindowTiming,
} from '@tx5dr/contracts';

test('FT4 window resolution', async (t) => {
  await t.test('balanced preset is dual-pass [-1500, 0]', () => {
    assert.deepStrictEqual(FT4_WINDOW_PRESETS.balanced, [-1500, 0]);
  });

  await t.test('maximum preset has three passes', () => {
    assert.strictEqual(FT4_WINDOW_PRESETS.maximum?.length, 3);
  });

  await t.test('lightweight preset is single end-of-slot pass', () => {
    assert.deepStrictEqual(FT4_WINDOW_PRESETS.lightweight, [0]);
  });

  await t.test('resolveWindowTiming returns balanced preset by default', () => {
    const result = resolveWindowTiming('FT4', { ft4: { preset: 'balanced' } });
    assert.deepStrictEqual(result, [-1500, 0]);
  });

  await t.test('resolveWindowTiming sorts custom timing ascending', () => {
    const result = resolveWindowTiming('FT4', {
      ft4: { preset: 'custom', customWindowTiming: [0, -1500, -500] },
    });
    assert.deepStrictEqual(result, [-1500, -500, 0]);
  });

  await t.test('resolveWindowTiming returns null when settings missing → caller falls back to MODES.FT4.windowTiming', () => {
    const result = resolveWindowTiming('FT4', undefined);
    assert.strictEqual(result, null);
    // MODES.FT4 fallback should match the default balanced preset
    assert.deepStrictEqual(MODES.FT4.windowTiming, [-1500, 0]);
  });

  await t.test('FT4 fallback windowTiming includes early pass for auto-QSO viability', () => {
    // Critical invariant: at least one window must fire BEFORE slot end so the next
    // cycle's encodeStart can see decoded messages. A negative offset proves this.
    const hasEarlyPass = MODES.FT4.windowTiming.some((offset) => offset < 0);
    assert.ok(hasEarlyPass, 'FT4 must have at least one early decode pass (negative offset)');
  });
});
