import { test } from 'node:test';
import assert from 'node:assert';
import { CycleUtils } from '../src/utils/cycleUtils';

const FT4_SLOT_MS = 7500;

// 关键回归：FT4 odd 时隙起点是 7500/22500/37500/52500ms（即 X.5 秒）。
// 旧的秒级 API（Math.floor(ms/1000) → calculateCycleNumber）会把 7→cycle 0、22→cycle 2，
// 把奇数周期算成上一个偶数周期 → 前端进度条颜色错乱、自动 QSO 在奇数周期不发射。
// 新的 *FromMs 直接基于 ms 计算，必须在所有亚秒级边界返回正确周期号。
test('FT4 cycle calculations (ms-based, the canonical API)', async (t) => {
  await t.test('calculateCycleNumberFromMs handles sub-second slot boundaries', () => {
    assert.strictEqual(CycleUtils.calculateCycleNumberFromMs(0, FT4_SLOT_MS), 0);
    assert.strictEqual(CycleUtils.calculateCycleNumberFromMs(7500, FT4_SLOT_MS), 1);
    assert.strictEqual(CycleUtils.calculateCycleNumberFromMs(15000, FT4_SLOT_MS), 2);
    assert.strictEqual(CycleUtils.calculateCycleNumberFromMs(22500, FT4_SLOT_MS), 3);
    assert.strictEqual(CycleUtils.calculateCycleNumberFromMs(30000, FT4_SLOT_MS), 4);
    assert.strictEqual(CycleUtils.calculateCycleNumberFromMs(37500, FT4_SLOT_MS), 5);
    assert.strictEqual(CycleUtils.calculateCycleNumberFromMs(52500, FT4_SLOT_MS), 7);
    // 边界内任意点：仍归属当前 cycle
    assert.strictEqual(CycleUtils.calculateCycleNumberFromMs(7499, FT4_SLOT_MS), 0);
    assert.strictEqual(CycleUtils.calculateCycleNumberFromMs(14999, FT4_SLOT_MS), 1);
  });

  await t.test('isEvenCycle alternates correctly at FT4 sub-second boundaries', () => {
    assert.strictEqual(CycleUtils.isEvenCycle(CycleUtils.calculateCycleNumberFromMs(0, FT4_SLOT_MS)), true);
    assert.strictEqual(CycleUtils.isEvenCycle(CycleUtils.calculateCycleNumberFromMs(7500, FT4_SLOT_MS)), false);
    assert.strictEqual(CycleUtils.isEvenCycle(CycleUtils.calculateCycleNumberFromMs(15000, FT4_SLOT_MS)), true);
    assert.strictEqual(CycleUtils.isEvenCycle(CycleUtils.calculateCycleNumberFromMs(22500, FT4_SLOT_MS)), false);
  });

  await t.test('isOperatorTransmitCycleFromMs picks correct FT4 slots for even-only operator', () => {
    const evenOnly = [0];
    assert.strictEqual(CycleUtils.isOperatorTransmitCycleFromMs(evenOnly, 0, FT4_SLOT_MS), true);
    assert.strictEqual(CycleUtils.isOperatorTransmitCycleFromMs(evenOnly, 7500, FT4_SLOT_MS), false);
    assert.strictEqual(CycleUtils.isOperatorTransmitCycleFromMs(evenOnly, 15000, FT4_SLOT_MS), true);
    assert.strictEqual(CycleUtils.isOperatorTransmitCycleFromMs(evenOnly, 22500, FT4_SLOT_MS), false);
  });

  await t.test('isOperatorTransmitCycleFromMs picks correct FT4 slots for odd-only operator', () => {
    const oddOnly = [1];
    assert.strictEqual(CycleUtils.isOperatorTransmitCycleFromMs(oddOnly, 0, FT4_SLOT_MS), false);
    assert.strictEqual(CycleUtils.isOperatorTransmitCycleFromMs(oddOnly, 7500, FT4_SLOT_MS), true);
    assert.strictEqual(CycleUtils.isOperatorTransmitCycleFromMs(oddOnly, 15000, FT4_SLOT_MS), false);
    assert.strictEqual(CycleUtils.isOperatorTransmitCycleFromMs(oddOnly, 22500, FT4_SLOT_MS), true);
  });

  await t.test('empty cycles never transmit', () => {
    assert.strictEqual(CycleUtils.isOperatorTransmitCycleFromMs([], 0, FT4_SLOT_MS), false);
    assert.strictEqual(CycleUtils.isOperatorTransmitCycleFromMs([], 7500, FT4_SLOT_MS), false);
  });

  await t.test('FT4 cycle differs from FT8 at the same UTC instant', () => {
    // At ms=7500: FT8 cycle 0 (still in 0-15s slot), FT4 cycle 1 (entered 7.5-15s slot)
    assert.strictEqual(CycleUtils.calculateCycleNumberFromMs(7500, 15000), 0);
    assert.strictEqual(CycleUtils.calculateCycleNumberFromMs(7500, FT4_SLOT_MS), 1);
  });
});

// 文档化遗留行为：秒级 API 对 FT4 不安全（截断）。新代码不要使用它。
test('legacy seconds-based API is unsafe for FT4 (documented)', async (t) => {
  await t.test('truncated integer seconds map FT4 odd slots to previous even cycle (the bug)', () => {
    // 这是 bug 行为，不是 feature。保留断言为 regression 锚点：一旦哪天我们决定让秒级 API
    // 接受 fractional 秒并修对，这条断言会失败，提醒同步审视所有调用点。
    const slotStartMs = 7500;
    const utcSeconds = Math.floor(slotStartMs / 1000); // = 7
    assert.strictEqual(CycleUtils.calculateCycleNumber(utcSeconds, FT4_SLOT_MS), 0); // 应为 1，但秒级 API 算成 0
  });
});
