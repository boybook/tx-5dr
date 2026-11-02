import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FT8MessageParser } from '../src/parser/ft8-message-parser';

test('signal reports stay inside the FT8/FT4 encoded range for strong and weak signals', () => {
  for (const [snr, expected] of [[75, '+49'], [100, '+49'], [49, '+49'], [-90, '-50'], [-50, '-50'], [-12.6, '-13'], [4.7, '+05'], [0, '+00']] as const) {
    assert.equal(FT8MessageParser.generateSignalReport(snr), expected);
  }
  assert.throws(() => FT8MessageParser.generateSignalReport(Number.NaN));
  assert.throws(() => FT8MessageParser.generateSignalReport(Number.POSITIVE_INFINITY));
});
