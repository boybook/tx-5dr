import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import { ClockSourceSystem } from '../src/clock/ClockSourceSystem.js';

// Characterization of ft8-lessons RX-26: the calibrated wall clock is read
// live from the system clock plus the calibration offset. It used to be a
// startup snapshot plus a high-resolution delta, which drifted from UTC after
// a system clock step or sleep. Describes current behavior; does not change it.

const realDateNow = Date.now;
let systemNowMs = 0;

function stubSystemClock(startMs: number): void {
  systemNowMs = startMs;
  Date.now = () => systemNowMs;
}

afterEach(() => {
  Date.now = realDateNow;
});

test('RX-26: follows a system clock step immediately instead of a startup snapshot', () => {
  stubSystemClock(1_700_000_000_000);
  const clock = new ClockSourceSystem();
  assert.strictEqual(clock.now(), 1_700_000_000_000);

  // Resume after sleep: wall time jumped an hour while no process time passed.
  systemNowMs += 3_600_000;
  assert.strictEqual(clock.now(), 1_700_003_600_000);

  // NTP steps the system clock back by 1.5 s.
  systemNowMs -= 1_500;
  assert.strictEqual(clock.now(), 1_700_003_598_500);
});

test('RX-26: applies the calibration offset on every read and replaces it rather than accumulating', () => {
  stubSystemClock(1_700_000_000_000);
  const clock = new ClockSourceSystem();

  clock.setCalibrationOffsetMs(120);
  assert.strictEqual(clock.now(), 1_700_000_000_120);
  systemNowMs += 15_000;
  assert.strictEqual(clock.now(), 1_700_000_015_120);

  clock.setCalibrationOffsetMs(-30);
  assert.strictEqual(clock.getCalibrationOffsetMs(), -30);
  assert.strictEqual(clock.now(), 1_700_000_014_970);
});

test('RX-26: a new clock source starts uncalibrated', () => {
  stubSystemClock(1_700_000_000_000);
  const calibrated = new ClockSourceSystem();
  calibrated.setCalibrationOffsetMs(250);

  // The offset lives in the instance; restoring it on restart is the caller's job.
  const fresh = new ClockSourceSystem();
  assert.strictEqual(fresh.getCalibrationOffsetMs(), 0);
  assert.strictEqual(fresh.now(), 1_700_000_000_000);
});

test('RX-26: the monotonic clock ignores wall-clock steps and the calibration offset', () => {
  stubSystemClock(1_700_000_000_000);
  const clock = new ClockSourceSystem();
  const before = clock.hrtime();

  systemNowMs -= 3_600_000;
  clock.setCalibrationOffsetMs(-5_000);
  const after = clock.hrtime();

  assert.strictEqual(typeof before, 'bigint');
  assert.ok(after >= before, 'hrtime must not go backwards when the wall clock steps back');
});
