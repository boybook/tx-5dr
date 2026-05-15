import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getLoTWSubdivisionOptions,
  normalizeLoTWStationLocation,
  suggestStationLocation,
  validateStationLocation,
} from '../src/lotwStationLocation.js';

test('normalizes China province names to ADIF codes', () => {
  const result = normalizeLoTWStationLocation({
    callsign: 'BG5DRB',
    dxccId: 318,
    gridSquare: 'PL09RX',
    cqZone: '24',
    ituZone: '44',
    state: 'ZHEJIANG',
  });

  assert.equal(result.location?.state, 'ZJ');
  assert.equal(result.issues.find((issue) => issue.code === 'lotw_location_state_suggested')?.suggested, 'ZJ');
});

test('rejects invalid China province values before LoTW upload', () => {
  const issues = validateStationLocation({
    callsign: 'BG5DRB',
    dxccId: 318,
    gridSquare: 'PL09RX',
    cqZone: '24',
    ituZone: '44',
    state: 'ZHEJIANGG',
  });

  assert.equal(issues.some((issue) => issue.code === 'lotw_location_state_invalid' && issue.severity === 'error'), true);
});

test('suggests station zones and China province from callsign and grid', () => {
  const result = suggestStationLocation({
    callsign: 'BG5DRB',
    dxccId: 318,
    gridSquare: 'PL09RX',
    current: { callsign: 'BG5DRB', dxccId: 318, gridSquare: 'PL09RX' },
  });

  assert.deepEqual(
    result.suggestions.map((suggestion) => [suggestion.field, suggestion.value]),
    [['cqZone', '24'], ['ituZone', '44'], ['state', 'ZJ']],
  );
});

test('exposes China province options for settings UI', () => {
  const options = getLoTWSubdivisionOptions(318);
  assert.equal(options.some((option) => option.code === 'ZJ' && option.name === 'Zhejiang'), true);
});
