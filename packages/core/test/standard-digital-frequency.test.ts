import assert from 'node:assert';
import test from 'node:test';
import {
  getStandardDigitalFrequencyMatch,
  STANDARD_DIGITAL_FREQUENCY_TOLERANCE_HZ,
} from '../src/utils/standardDigitalFrequency.js';

test('standard digital frequency matching', async (t) => {
  await t.test('matches the active mode frequency table', () => {
    assert.deepStrictEqual(getStandardDigitalFrequencyMatch('FT8', 14_074_000), {
      modeName: 'FT8',
      standardFrequency: 14_074_000,
    });
    assert.deepStrictEqual(getStandardDigitalFrequencyMatch('FT4', 7_047_500), {
      modeName: 'FT4',
      standardFrequency: 7_047_500,
    });
    assert.strictEqual(getStandardDigitalFrequencyMatch('FT8', 7_047_500), null);
  });

  await t.test('includes the tolerance boundary but not the next hertz', () => {
    assert.ok(getStandardDigitalFrequencyMatch(
      'FT8',
      14_074_000 + STANDARD_DIGITAL_FREQUENCY_TOLERANCE_HZ,
    ));
    assert.ok(getStandardDigitalFrequencyMatch(
      'FT8',
      14_074_000 - STANDARD_DIGITAL_FREQUENCY_TOLERANCE_HZ,
    ));
    assert.strictEqual(getStandardDigitalFrequencyMatch(
      'FT8',
      14_074_000 + STANDARD_DIGITAL_FREQUENCY_TOLERANCE_HZ + 1,
    ), null);
  });

  await t.test('rejects unsupported modes and invalid frequencies', () => {
    assert.strictEqual(getStandardDigitalFrequencyMatch('VOICE', 14_074_000), null);
    assert.strictEqual(getStandardDigitalFrequencyMatch('FT8', null), null);
    assert.strictEqual(getStandardDigitalFrequencyMatch('FT8', Number.NaN), null);
  });
});
