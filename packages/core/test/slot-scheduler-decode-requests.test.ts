import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MODES, type DecodeRequest, type ModeDescriptor, type SlotInfo } from '@tx5dr/contracts';
import { SlotClock } from '../src/clock/SlotClock.js';
import { SlotScheduler, type AudioBufferProvider } from '../src/clock/SlotScheduler.js';
import { DecodeSessionCancelledError } from '../src/clock/DecodeSessionCancellation.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function slotInfo(slot: number, mode: ModeDescriptor = MODES.FT8): SlotInfo {
  return {
    id: `slot-${slot}`, startMs: slot * mode.slotMs, cycleNumber: slot,
    utcSeconds: Math.floor(slot * mode.slotMs / 1000), phaseMs: 0, driftMs: 0, mode: mode.name,
  };
}

interface HarnessOptions {
  audio?: AudioBufferProvider;
  push?: (request: DecodeRequest) => Promise<void> | void;
  transmitting?: (slotInfo: SlotInfo) => boolean;
  now?: () => number;
}

function harness(options: HarnessOptions = {}) {
  const clock = new SlotClock({ name: 'test', now: () => Date.now() }, MODES.FT8);
  const requests: DecodeRequest[] = [];
  const cancelled: Array<{ id: string; reason: string }> = [];
  const audio = options.audio ?? { getBuffer: async () => new ArrayBuffer(64), getSampleRate: () => 12000 };
  const scheduler = new SlotScheduler(clock, {
    push: request => { requests.push(request); return options.push?.(request); },
    size: () => 0,
    cancelSession: (id, reason) => cancelled.push({ id, reason }),
  }, audio, {
    hasActiveTransmissionsInCurrentCycle: info => options.transmitting?.(info) ?? false,
  }, () => false, undefined, undefined, options.now);
  scheduler.start();
  return { clock, scheduler, requests, cancelled };
}

// RX-28: decode requests are stamped with the injected calibrated clock.
test('decode request timestamp comes from the injected calibrated clock', async () => {
  const calibratedNow = Date.now() + 5000;
  const h = harness({ now: () => calibratedNow });
  try {
    h.clock.emit('subWindow', slotInfo(1), 0); await flush();
    assert.equal(h.requests[0].timestamp, calibratedNow);
  } finally { h.scheduler.stop(); }
});

// RX-29 / DEC-23: the provider's sample rate labels the PCM; a silent provider
// is assumed to be 48 kHz.
test('decode requests are labelled 48000 Hz when the audio provider reports no sample rate', async () => {
  const h = harness({ audio: { getBuffer: async () => new ArrayBuffer(64) } });
  try {
    h.clock.emit('subWindow', slotInfo(1), 0); await flush();
    assert.equal(h.requests[0].sampleRate, 48000);
  } finally { h.scheduler.stop(); }
});

test('decode requests carry the 12000 Hz rate reported by the audio provider', async () => {
  const h = harness({ audio: { getBuffer: async () => new ArrayBuffer(64), getSampleRate: () => 12000 } });
  try {
    h.clock.emit('subWindow', slotInfo(1), 0); await flush();
    assert.equal(h.requests[0].sampleRate, 12000);
  } finally { h.scheduler.stop(); }
});

// DEC-02: every window is captured from the slot start for slotMs + offset.
test('every FT8 window captures audio from the slot start for slotMs plus its offset', async () => {
  const captures: Array<[number, number]> = [];
  const h = harness({
    audio: {
      getBuffer: async (startMs, durationMs) => { captures.push([startMs, durationMs]); return new ArrayBuffer(64); },
      getSampleRate: () => 12000,
    },
  });
  try {
    const info = slotInfo(3);
    for (let index = 0; index < MODES.FT8.windowTiming.length; index++) {
      h.clock.emit('subWindow', info, index); await flush();
    }
    assert.deepEqual(MODES.FT8.windowTiming, [-3200, -1500, -300]);
    assert.deepEqual(captures, [
      [info.startMs, 11_800],
      [info.startMs, 13_500],
      [info.startMs, 14_700],
    ]);
    assert.deepEqual(h.requests.map(r => r.windowOffsetMs), [-3200, -1500, -300]);
  } finally { h.scheduler.stop(); }
});

// DEC-09: a submitted request that fails (not a cancellation) cancels the slot
// once as worker-failed; later windows of that slot are not submitted.
test('a failed submitted request cancels the slot once as worker-failed', async () => {
  let fail = true;
  const h = harness({
    push: () => { if (fail) throw new Error('worker crashed'); },
  });
  try {
    h.clock.emit('subWindow', slotInfo(1), 0); await flush();
    fail = false;
    h.clock.emit('subWindow', slotInfo(1), 1); await flush();
    h.clock.emit('subWindow', slotInfo(1), 2); await flush();
    h.clock.emit('subWindow', slotInfo(2), 0); await flush();
    assert.deepEqual(h.requests.map(r => [r.slotId, r.windowIdx]), [['slot-1', 0], ['slot-2', 0]]);
    assert.deepEqual(h.cancelled, [{ id: 'slot-1', reason: 'worker-failed' }]);
  } finally { h.scheduler.stop(); }
});

test('a cancellation rejection closes the slot without requesting another cancellation', async () => {
  const h = harness({
    push: request => {
      if (request.slotId === 'slot-1') throw new DecodeSessionCancelledError('queue-expired');
    },
  });
  try {
    h.clock.emit('subWindow', slotInfo(1), 0); await flush();
    h.clock.emit('subWindow', slotInfo(1), 1); await flush();
    h.clock.emit('subWindow', slotInfo(2), 0); await flush();
    assert.deepEqual(h.requests.map(r => [r.slotId, r.windowIdx]), [['slot-1', 0], ['slot-2', 0]]);
    assert.deepEqual(h.cancelled, []);
  } finally { h.scheduler.stop(); }
});

// DEC-01: the transmit check receives the slot being decoded. A positive-offset
// final window fires after the next slot began, yet the check still sees the
// decoded slot, not the clock's current slot.
test('transmit skip is judged against the decoded slot for a positive-offset final window', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const mode: ModeDescriptor = { ...MODES.FT8, windowTiming: [-3200, -1500, 1000] };
  let virtualNow = 2 * mode.slotMs - 10;
  const clock = new SlotClock({ name: 'virtual', now: () => virtualNow }, mode);
  const checked: Array<{ slotStartMs: number; currentSlotStartMs: number | undefined }> = [];
  const requests: DecodeRequest[] = [];
  const scheduler = new SlotScheduler(clock, {
    push: request => { requests.push(request); }, size: () => 0, cancelSession: () => {},
  }, { getBuffer: async () => new ArrayBuffer(64), getSampleRate: () => 12000 }, {
    hasActiveTransmissionsInCurrentCycle: info => {
      checked.push({ slotStartMs: info.startMs, currentSlotStartMs: clock.getCurrentSlotInfo()?.startMs });
      return false;
    },
  }, () => false);
  const advance = (ms: number) => {
    for (let step = 0; step < ms; step += 10) { virtualNow += 10; mock.timers.tick(10); }
  };
  try {
    scheduler.start();
    clock.start();
    advance(10); // slot 2 starts
    advance(mode.slotMs + 1000); // through slot 2's +1000 ms final window, inside slot 3
    await flush();
    const finalWindow = requests.find(r => r.slotId.endsWith(`-${2 * mode.slotMs}`) && r.windowIdx === 2);
    assert.ok(finalWindow, 'final window of slot 2 was submitted');
    const finalChecks = checked.filter(c => c.currentSlotStartMs === 3 * mode.slotMs);
    assert.ok(finalChecks.length > 0, 'the final window was checked during slot 3');
    assert.ok(finalChecks.every(c => c.slotStartMs === 2 * mode.slotMs));
  } finally {
    clock.stop();
    scheduler.stop();
    mock.timers.reset();
  }
});

// RX-22: when the slot timer fires late, encode/transmit delays subtract the
// observed phase so they still land on their theoretical absolute times, and
// sub-windows are scheduled from absolute trigger times.
test('late slot trigger compensates encode, transmit and sub-window delays by phaseMs', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const mode: ModeDescriptor = {
    name: 'FT8', slotMs: 15_000, toleranceMs: 0,
    windowTiming: [-3200], transmitTiming: 1000, encodeAdvance: 400,
  };
  let virtualNow = 15_000 - 10;
  const clock = new SlotClock({ name: 'virtual', now: () => virtualNow }, mode);
  const fired: string[] = [];
  let phaseMs: number | undefined;
  clock.on('slotStart', info => { phaseMs = info.phaseMs; fired.push('slotStart'); });
  clock.on('encodeStart', () => fired.push('encodeStart'));
  clock.on('transmitStart', () => fired.push('transmitStart'));
  clock.on('subWindow', () => fired.push('subWindow'));
  try {
    clock.start();
    virtualNow = 15_000 + 300; // the 10 ms timer fires 300 ms late
    mock.timers.tick(10);
    assert.equal(phaseMs, 300);
    assert.deepEqual(fired, ['slotStart']);

    // encode: theoretical 600 ms after slot start -> 300 ms after the late trigger
    mock.timers.tick(299);
    assert.deepEqual(fired, ['slotStart']);
    mock.timers.tick(1);
    assert.deepEqual(fired, ['slotStart', 'encodeStart']);

    // transmit: theoretical 1000 ms -> 700 ms after the late trigger
    mock.timers.tick(399);
    assert.deepEqual(fired, ['slotStart', 'encodeStart']);
    mock.timers.tick(1);
    assert.deepEqual(fired, ['slotStart', 'encodeStart', 'transmitStart']);

    // sub-window: absolute 30000 - 3200 = 26800 -> 11500 ms after the late trigger
    mock.timers.tick(11_500 - 700 - 1);
    assert.equal(fired.includes('subWindow'), false);
    mock.timers.tick(1);
    assert.equal(fired.at(-1), 'subWindow');
  } finally {
    clock.stop();
    mock.timers.reset();
  }
});
