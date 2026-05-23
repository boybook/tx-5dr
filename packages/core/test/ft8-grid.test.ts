import { test } from 'node:test';
import assert from 'node:assert';
import { FT8MessageType } from '@tx5dr/contracts';
import { calculateGridBearing, calculateGridDistance, calculateGridPath } from '../src/callsign/callsign';
import { FT8MessageParser } from '../src/parser/ft8-message-parser';

test('FT8 grid transmission normalization', async (t) => {
  await t.test('CQ messages only include grids for WSJT-X-compatible callsigns', () => {
    const cases = [
      { senderCallsign: 'BG5DRB', grid: 'PL09AA', expected: 'CQ BG5DRB PL09' },
      { senderCallsign: 'BG7KEO/QRP', grid: 'OL62', expected: 'CQ BG7KEO/QRP' },
      { senderCallsign: 'WB9XYZ/A', grid: 'EN34', expected: 'CQ WB9XYZ/A' },
      { senderCallsign: 'G4ABC/P', grid: 'IO91', expected: 'CQ G4ABC/P IO91' },
      { senderCallsign: 'LZ370TL', grid: 'OL32', expected: 'CQ LZ370TL' },
    ];

    for (const { senderCallsign, grid, expected } of cases) {
      const message = FT8MessageParser.generateMessage({
        type: FT8MessageType.CQ,
        senderCallsign,
        grid,
      });

      assert.strictEqual(message, expected);
    }
  });

  await t.test('CALL messages always use a four-character grid', () => {
    const message = FT8MessageParser.generateMessage({
      type: FT8MessageType.CALL,
      senderCallsign: 'BG5DRB',
      targetCallsign: 'BA1ABC',
      grid: 'PL09AA',
    });

    assert.strictEqual(message, 'BA1ABC BG5DRB PL09');
  });
});

test('grid distance and bearing calculations', async (t) => {
  await t.test('returns a zero-distance path for the same grid', () => {
    const distance = calculateGridDistance('FN31', 'FN31');
    const bearing = calculateGridBearing('FN31', 'FN31');
    const path = calculateGridPath('FN31', 'FN31');

    assert.ok(distance !== null);
    assert.ok(distance < 1);
    assert.strictEqual(bearing, 0);
    assert.ok(path !== null);
    assert.ok(path.distanceKm < 1);
    assert.strictEqual(path.bearingDegrees, 0);
  });

  await t.test('calculates initial true bearing between known grids', () => {
    const eastChinaToJapan = calculateGridBearing('PL09', 'PM95');
    const newYorkToLondon = calculateGridBearing('FN31', 'IO91');

    assert.ok(eastChinaToJapan !== null);
    assert.ok(eastChinaToJapan >= 60 && eastChinaToJapan <= 68);
    assert.ok(newYorkToLondon !== null);
    assert.ok(newYorkToLondon >= 48 && newYorkToLondon <= 56);
  });

  await t.test('returns null for invalid or empty grids', () => {
    assert.strictEqual(calculateGridBearing('', 'PM95'), null);
    assert.strictEqual(calculateGridBearing('ZZ99', 'PM95'), null);
    assert.strictEqual(calculateGridPath('PL09', 'PM9X'), null);
  });

  await t.test('normalizes bearing to 0-359 degrees', () => {
    const bearing = calculateGridBearing('PM95', 'PL09');

    assert.ok(bearing !== null);
    assert.ok(bearing >= 0 && bearing < 360);
  });
});
