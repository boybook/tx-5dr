import { test } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'eventemitter3';
import type { ModeDescriptor, SlotInfo } from '@tx5dr/contracts';
import { SlotClock } from '../src/clock/SlotClock.js';
import { SlotScheduler } from '../src/clock/SlotScheduler.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSystemClockSource() {
  return {
    name: 'system-test',
    now: () => Date.now(),
  };
}

test('SlotScheduler removes the old subWindow listener on stop/start', async () => {
  class FakeSlotClock extends EventEmitter<{ subWindow: (slotInfo: SlotInfo, windowIdx: number) => void }> {
    getMode(): ModeDescriptor {
      return {
        name: 'TEST',
        slotMs: 1000,
        toleranceMs: 0,
        windowTiming: [0],
        transmitTiming: 0,
        encodeAdvance: 0,
      };
    }
  }

  const slotClock = new FakeSlotClock();
  const decodeRequests: Array<{ slotId: string; windowIdx: number }> = [];
  const scheduler = new SlotScheduler(
    slotClock as unknown as any,
    {
      push: async (request) => {
        decodeRequests.push({ slotId: request.slotId, windowIdx: request.windowIdx });
      },
      size: () => 0,
    },
    {
      getBuffer: async () => new ArrayBuffer(32),
      getSampleRate: () => 12000,
    }
  );

  scheduler.start();
  scheduler.stop();
  scheduler.start();

  const slotInfo: SlotInfo = {
    id: 'TEST-1-1000',
    startMs: 1000,
    phaseMs: 0,
    driftMs: 0,
    cycleNumber: 1,
    utcSeconds: 1,
    mode: 'TEST',
  };

  slotClock.emit('subWindow', slotInfo, 0);
  await wait(10);

  assert.deepStrictEqual(decodeRequests, [{ slotId: 'TEST-1-1000', windowIdx: 0 }]);
});

test('SlotClock stop clears pending sub-events for the active slot', async () => {
  const mode: ModeDescriptor = {
    name: 'TEST_STOP',
    slotMs: 60,
    toleranceMs: 0,
    windowTiming: [50],
    transmitTiming: 100,
    encodeAdvance: 20,
  };
  const clock = new SlotClock(createSystemClockSource(), mode);
  const fired = {
    encodeStart: 0,
    transmitStart: 0,
    subWindow: 0,
  };

  const slotStarted = new Promise<void>((resolve) => {
    clock.on('slotStart', () => {
      clock.stop();
      resolve();
    });
  });
  clock.on('encodeStart', () => {
    fired.encodeStart++;
  });
  clock.on('transmitStart', () => {
    fired.transmitStart++;
  });
  clock.on('subWindow', () => {
    fired.subWindow++;
  });

  clock.start();
  await slotStarted;
  await wait(180);

  assert.deepStrictEqual(fired, {
    encodeStart: 0,
    transmitStart: 0,
    subWindow: 0,
  });
});

test('SlotClock drops old mode timers after setMode restart', async () => {
  const modeA: ModeDescriptor = {
    name: 'MODE_A',
    slotMs: 60,
    toleranceMs: 0,
    windowTiming: [50],
    transmitTiming: 100,
    encodeAdvance: 20,
  };
  const modeB: ModeDescriptor = {
    name: 'MODE_B',
    slotMs: 70,
    toleranceMs: 0,
    windowTiming: [40],
    transmitTiming: 90,
    encodeAdvance: 10,
  };
  const clock = new SlotClock(createSystemClockSource(), modeA);
  const seenModes = {
    encodeStart: [] as string[],
    transmitStart: [] as string[],
    subWindow: [] as string[],
  };

  const switched = new Promise<void>((resolve) => {
    clock.on('slotStart', (slotInfo) => {
      if (slotInfo.mode === 'MODE_A') {
        clock.setMode(modeB);
        resolve();
      }
    });
  });
  clock.on('encodeStart', (slotInfo) => {
    seenModes.encodeStart.push(slotInfo.mode);
  });
  clock.on('transmitStart', (slotInfo) => {
    seenModes.transmitStart.push(slotInfo.mode);
  });
  clock.on('subWindow', (slotInfo) => {
    seenModes.subWindow.push(slotInfo.mode);
  });

  clock.start();
  await switched;
  await wait(260);
  clock.stop();

  assert.ok(seenModes.encodeStart.length > 0, 'expected restarted clock to emit encodeStart');
  assert.ok(seenModes.transmitStart.length > 0, 'expected restarted clock to emit transmitStart');
  assert.ok(seenModes.subWindow.length > 0, 'expected restarted clock to emit subWindow');
  assert.ok(seenModes.encodeStart.every((modeName) => modeName === 'MODE_B'));
  assert.ok(seenModes.transmitStart.every((modeName) => modeName === 'MODE_B'));
  assert.ok(seenModes.subWindow.every((modeName) => modeName === 'MODE_B'));
});

test('SlotClock does not re-schedule the same slot when the first trigger is slightly early', async () => {
  const mode: ModeDescriptor = {
    name: 'EARLY_SLOT',
    slotMs: 50,
    toleranceMs: 0,
    windowTiming: [1000],
    transmitTiming: 0,
    encodeAdvance: 0,
  };

  const timestamps = [149.2, 149.7, 149.8, 151.0];
  const clock = new SlotClock(
    {
      name: 'sequenced-test',
      now: () => timestamps.shift() ?? 151.0,
    },
    mode
  );

  const slotStarts: SlotInfo[] = [];
  clock.on('slotStart', (slotInfo) => {
    slotStarts.push(slotInfo);
  });

  clock.start();
  await wait(15);
  clock.stop();

  assert.strictEqual(slotStarts.length, 1);
  assert.strictEqual(slotStarts[0]?.startMs, 150);
  assert.ok(slotStarts[0]?.phaseMs < 0, 'expected first slot trigger to be slightly early');
});
