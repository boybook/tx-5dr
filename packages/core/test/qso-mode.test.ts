import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getDisplayMode,
  normalizeQsoModeForStorage,
  toAdifMode,
  toLotwContactMode,
} from '../src/log/qsoMode.js';

test('normalizes legacy USB and LSB modes for storage', () => {
  assert.deepEqual(normalizeQsoModeForStorage({ mode: 'USB' }), { mode: 'SSB', submode: 'USB' });
  assert.deepEqual(normalizeQsoModeForStorage({ mode: 'lsb' }), { mode: 'SSB', submode: 'LSB' });
});

test('keeps standard SSB submode records stable', () => {
  assert.deepEqual(normalizeQsoModeForStorage({ mode: 'SSB', submode: 'LSB' }), { mode: 'SSB', submode: 'LSB' });
});

test('does not rewrite non-sideband modes', () => {
  assert.deepEqual(normalizeQsoModeForStorage({ mode: 'AM' }), { mode: 'AM', submode: undefined });
  assert.deepEqual(normalizeQsoModeForStorage({ mode: 'FM' }), { mode: 'FM', submode: undefined });
  assert.deepEqual(normalizeQsoModeForStorage({ mode: 'FT8' }), { mode: 'FT8', submode: undefined });
  assert.deepEqual(normalizeQsoModeForStorage({ mode: 'FT4' }), { mode: 'FT4', submode: undefined });
});

test('clears stale SSB sideband submodes from non-SSB modes', () => {
  assert.deepEqual(normalizeQsoModeForStorage({ mode: 'FM', submode: 'USB' }), { mode: 'FM', submode: undefined });
});

test('formats sideband records for display without changing storage shape', () => {
  assert.equal(getDisplayMode({ mode: 'SSB', submode: 'USB' }), 'USB');
  assert.equal(getDisplayMode({ mode: 'SSB', submode: 'LSB' }), 'LSB');
  assert.equal(getDisplayMode({ mode: 'FM' }), 'FM');
});

test('projects stored modes to ADIF and LoTW modes', () => {
  assert.deepEqual(toAdifMode({ mode: 'SSB', submode: 'USB' }), { mode: 'SSB', submode: 'USB' });
  assert.equal(toLotwContactMode({ mode: 'SSB', submode: 'USB' }), 'SSB');
  assert.deepEqual(toAdifMode({ mode: 'FT4' }), { mode: 'MFSK', submode: 'FT4' });
  assert.equal(toLotwContactMode({ mode: 'MFSK', submode: 'FT4' }), 'FT4');
});
