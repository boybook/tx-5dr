// Characterization tests for lessons RX-25 / TX-13 (docs/proposals/plugin-kernel/ft8-lessons.md).
//
// Pinned before the plugin-kernel migration: transmitCompensationMs is
// currently subtracted independently in three places (SlotClock events,
// TransmissionPipeline target playback time, and the RadioOperatorManager
// waveform cursor origin). After the migration the kernel is expected to
// subtract it once; these tests describe today's SlotClock half of that
// contract so the three sites can be proven equivalent afterwards.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert';
import type { ModeDescriptor } from '@tx5dr/contracts';
import { SlotClock } from '../src/clock/SlotClock.js';

const SLOT_START_MS = 30_000;

const FT8_LIKE: ModeDescriptor = {
  name: 'FT8_COMP',
  slotMs: 15_000,
  toleranceMs: 100,
  windowTiming: [],
  transmitTiming: 1_000,
  encodeAdvance: 400,
};

// node:test mock timers move Date.now() to the end of a tick before firing the
// expired callbacks, so advance one millisecond at a time to observe the exact
// firing time of each event.
function advance(t: TestContext, ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 1) t.mock.timers.tick(1);
}

interface SlotEventTimes {
  slotStart: number[];
  encodeStart: number[];
  transmitStart: number[];
}

function runOneSlot(
  t: TestContext,
  mode: ModeDescriptor,
  compensationMs: number,
): SlotEventTimes {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: SLOT_START_MS - 10 });
  const clock = new SlotClock({ name: 'mock-clock', now: () => Date.now() }, mode, compensationMs);
  const times: SlotEventTimes = { slotStart: [], encodeStart: [], transmitStart: [] };
  clock.on('slotStart', () => times.slotStart.push(Date.now()));
  clock.on('encodeStart', () => times.encodeStart.push(Date.now()));
  clock.on('transmitStart', () => times.transmitStart.push(Date.now()));
  clock.start();
  advance(t, 10);
  advance(t, mode.slotMs - 100);
  clock.stop();
  return times;
}

test('SlotClock subtracts a positive compensation (+300 ms) from encodeStart and transmitStart independently (pre-migration, RX-25/TX-13)', (t) => {
  const times = runOneSlot(t, FT8_LIKE, 300);

  assert.deepStrictEqual(times.slotStart, [SLOT_START_MS]);
  // encode: transmitTiming - encodeAdvance - compensation = 1000 - 400 - 300
  assert.deepStrictEqual(times.encodeStart, [SLOT_START_MS + 300]);
  // transmit: transmitTiming - compensation = 1000 - 300
  assert.deepStrictEqual(times.transmitStart, [SLOT_START_MS + 700]);
});

test('SlotClock subtracts a negative compensation (-200 ms) from encodeStart and transmitStart independently (pre-migration, RX-25/TX-13)', (t) => {
  const times = runOneSlot(t, FT8_LIKE, -200);

  assert.deepStrictEqual(times.slotStart, [SLOT_START_MS]);
  assert.deepStrictEqual(times.encodeStart, [SLOT_START_MS + 800]);
  assert.deepStrictEqual(times.transmitStart, [SLOT_START_MS + 1_200]);
});

test('SlotClock clamps each compensated delay at zero without cascading the encode clamp into transmitStart', (t) => {
  // 800 ms exceeds the 600 ms encode delay but not the 1000 ms transmit delay.
  // If the clamp cascaded (transmit = clampedEncode + encodeAdvance), transmitStart
  // would land at +400 instead of +200.
  const times = runOneSlot(t, FT8_LIKE, 800);

  assert.deepStrictEqual(times.encodeStart, [SLOT_START_MS]);
  assert.deepStrictEqual(times.transmitStart, [SLOT_START_MS + 200]);
});

test('SlotClock applies the same compensation to an FT8 zero encode advance so encodeStart and transmitStart coincide', (t) => {
  const ft8ZeroAdvance: ModeDescriptor = { ...FT8_LIKE, transmitTiming: 500, encodeAdvance: 0 };

  const positive = runOneSlot(t, ft8ZeroAdvance, 300);
  assert.deepStrictEqual(positive.encodeStart, [SLOT_START_MS + 200]);
  assert.deepStrictEqual(positive.transmitStart, [SLOT_START_MS + 200]);
  t.mock.timers.reset();

  const negative = runOneSlot(t, ft8ZeroAdvance, -200);
  assert.deepStrictEqual(negative.encodeStart, [SLOT_START_MS + 700]);
  assert.deepStrictEqual(negative.transmitStart, [SLOT_START_MS + 700]);
});

test('SlotClock picks up a runtime compensation update at the next slot', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: SLOT_START_MS - 10 });
  const clock = new SlotClock({ name: 'mock-clock', now: () => Date.now() }, FT8_LIKE, 300);
  const transmitStarts: number[] = [];
  clock.on('transmitStart', () => transmitStarts.push(Date.now()));
  clock.start();
  advance(t, 10);
  advance(t, 1_000);
  assert.strictEqual(clock.getCompensation(), 300);

  clock.setCompensation(-200);
  assert.strictEqual(clock.getCompensation(), -200);
  advance(t, FT8_LIKE.slotMs + 500);
  clock.stop();

  assert.deepStrictEqual(transmitStarts, [
    SLOT_START_MS + 700,
    SLOT_START_MS + FT8_LIKE.slotMs + 1_200,
  ]);
});
