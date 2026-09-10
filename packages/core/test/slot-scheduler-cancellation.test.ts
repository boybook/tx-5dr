import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlotClock } from '../src/clock/SlotClock.js';
import { SlotScheduler } from '../src/clock/SlotScheduler.js';
import type { DecodeRequest, SlotInfo } from '@tx5dr/contracts';

const mode = { name: 'FT8', slotMs: 15_000, windowTiming: [-3200, -1500, 1000], transmitTiming: 500, encodeAdvance: 0, toleranceMs: 0 };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function setup(getBuffer = async () => new ArrayBuffer(64)) {
  const clock = new SlotClock({ name: 'test', now: () => Date.now() }, mode);
  const requests: DecodeRequest[] = [];
  const cancelled: Array<{ id: string; reason: string }> = [];
  const state = { transmitting: false };
  const scheduler = new SlotScheduler(clock, {
    push: request => { requests.push(request); }, size: () => 0,
    cancelSession: (id, reason) => cancelled.push({ id, reason }),
  }, { getBuffer, getSampleRate: () => 12000 }, {
    hasActiveTransmissionsInCurrentCycle: () => state.transmitting,
  }, () => false);
  scheduler.start();
  function window(slot: number, index: number) {
    const info: SlotInfo = { id: `slot-${slot}`, startMs: slot * mode.slotMs,
      cycleNumber: slot, utcSeconds: slot * 15, phaseMs: 0, driftMs: 0, mode: clock.getMode().name };
    clock.emit('subWindow', info, index);
  }
  return { clock, scheduler, state, requests, cancelled, window };
}

test('mid-slot transmit activation cancels remaining windows and does not reopen that slot', async () => {
  const h = setup();
  try {
    h.window(1, 0); await flush();
    h.state.transmitting = true;
    h.window(1, 1); await flush();
    h.state.transmitting = false;
    h.window(1, 2); await flush();
    h.window(2, 0); await flush();
    assert.deepEqual(h.requests.map(r => [r.slotId, r.windowIdx]), [['slot-1', 0], ['slot-2', 0]]);
    assert.deepEqual(h.cancelled, [{ id: 'slot-1', reason: 'transmit-skipped' }]);
  } finally { h.scheduler.stop(); }
});

test('transmit activation during asynchronous audio capture prevents a late submission', async () => {
  let finish!: (pcm: ArrayBuffer) => void;
  const h = setup(() => new Promise(resolve => { finish = resolve; }));
  try {
    h.window(1, 0);
    h.state.transmitting = true;
    finish(new ArrayBuffer(64)); await flush();
    assert.equal(h.requests.length, 0);
    assert.equal(h.cancelled[0].reason, 'transmit-skipped');
  } finally { h.scheduler.stop(); }
});

test('stop/start invalidates audio capture from an earlier scheduler generation', async () => {
  let finish!: (pcm: ArrayBuffer) => void;
  const h = setup(() => new Promise(resolve => { finish = resolve; }));
  try {
    h.window(1, 0);
    h.scheduler.stop(); h.scheduler.start();
    finish(new ArrayBuffer(64)); await flush();
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.cancelled, [{ id: 'slot-1', reason: 'stopped' }]);
    h.window(2, 0); finish(new ArrayBuffer(64)); await flush();
    assert.equal(h.requests.length, 1);
  } finally { h.scheduler.stop(); }
});

test('clock mode/window reset cancels sessions before old capture can reach the queue', async () => {
  let finish!: (pcm: ArrayBuffer) => void;
  const h = setup(() => new Promise(resolve => { finish = resolve; }));
  try {
    h.clock.start();
    h.window(1, 0);
    h.clock.setMode({ ...mode, name: 'FT4', slotMs: 7500, windowTiming: [0] });
    finish(new ArrayBuffer(64)); await flush();
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.cancelled, [{ id: 'slot-1', reason: 'scheduler-reset' }]);
    h.window(2, 0); finish(new ArrayBuffer(64)); await flush();
    assert.equal(h.requests[0].mode, 'FT4');
    assert.equal(h.requests[0].decodeFinalWindow, true);
  } finally { h.scheduler.stop(); h.clock.stop(); }
});

test('capture failure cancels the entire slot once', async () => {
  const h = setup(async () => { throw new Error('capture unavailable'); });
  try {
    h.window(1, 0); await flush();
    h.window(1, 1); h.window(1, 2); await flush();
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.cancelled, [{ id: 'slot-1', reason: 'capture-failed' }]);
  } finally { h.scheduler.stop(); }
});

test('positive-offset final windows are retained across the next slot boundary', async () => {
  const h = setup();
  try {
    h.window(1, 0); await flush();
    h.window(2, 0); await flush();
    h.window(1, 2); await flush();
    assert.equal(h.requests.at(-1)!.decodeFinalWindow, true);
    assert.equal(h.requests.at(-1)!.slotId, 'slot-1');
    assert.equal(h.cancelled.length, 0);
  } finally { h.scheduler.stop(); }
});

test('retained slot state is bounded and an evicted slot cannot be reopened', async () => {
  const h = setup();
  try {
    for (let slot = 0; slot < 20; slot++) { h.window(slot, 0); await flush(); }
    assert.equal(h.cancelled.length, 12);
    h.window(0, 2); await flush();
    assert.equal(h.requests.length, 20);
  } finally { h.scheduler.stop(); }
});
