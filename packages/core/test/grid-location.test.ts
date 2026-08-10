import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCallsignInfo, parseFT8LocationInfo, resolveGridLocation } from '../src/index.js';

function resolve(callsign: string, grid: string) {
  const info = getCallsignInfo(callsign);
  assert.ok(info, `expected ${callsign} to resolve`);
  const result = resolveGridLocation(grid, info);
  assert.ok(result, `expected ${grid} to resolve`);
  return result;
}

test('Grid location compares the full Grid area instead of its centre point', () => {
  const matching = resolve('JA1ABC', 'PM95');
  assert.equal(matching.status, 'compatible');
  assert.equal(matching.matchedBy, 'country');
  assert.equal(matching.countries[0]?.code, 'JP');

  const conflict = resolve('JA1ABC', 'CN87');
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.countries[0]?.code, 'US');
  assert.ok(conflict.countries[0]?.subdivisions.some(subdivision => subdivision.code === 'US-WA'));

  const border = resolve('DO1XYZ', 'JO45');
  assert.equal(border.status, 'ambiguous');
  assert.deepEqual(border.countries.map(country => country.code).sort(), ['DE', 'DK']);
});

test('Grid location applies only audited DXCC entity overlays', () => {
  const hawaii = resolve('W1AW/KH6', 'BL11');
  assert.equal(hawaii.status, 'compatible');
  assert.equal(hawaii.matchedBy, 'dxcc-entity');

  const hawaiiElsewhere = resolve('W1AW/KH6', 'EN50');
  assert.equal(hawaiiElsewhere.status, 'conflict');

  const mainlandUs = resolve('W1AW/8', 'EN50');
  assert.equal(mainlandUs.status, 'compatible');
  assert.equal(mainlandUs.matchedBy, 'dxcc-entity');

  const northernIreland = resolve('GI1ABC', 'IO75');
  assert.equal(northernIreland.status, 'compatible');
  assert.equal(northernIreland.matchedBy, 'dxcc-entity');

  const britishEntityBorder = resolve('G4ABC', 'IO75');
  assert.equal(britishEntityBorder.status, 'ambiguous');

  const taiwan = resolve('BV1AA', 'PL03');
  assert.equal(taiwan.status, 'compatible');
  assert.equal(taiwan.countries[0]?.code, 'TW');
});

test('Grid conflict cue keeps mainland China and Taiwan compatible for display only', () => {
  const mainlandOnTaiwanGrid = resolve('BY1AAA', 'PL03');
  assert.equal(mainlandOnTaiwanGrid.status, 'compatible');
  assert.equal(mainlandOnTaiwanGrid.countries[0]?.code, 'TW');

  const taiwanOnMainlandGrid = resolve('BV1AAA', 'OM89');
  assert.equal(taiwanOnMainlandGrid.status, 'compatible');
  assert.equal(taiwanOnMainlandGrid.countries[0]?.code, 'CN');
});

test('Grid location fails closed for mobile, tiny-island, and partial-decode cases', () => {
  assert.equal(resolveGridLocation('CN87', { callsign: 'W1AW/MM', countryCode: 'US', entityCode: 291 })?.status, 'unknown');
  assert.equal(resolveGridLocation('CN87', { callsign: 'W1AW/AM', countryCode: 'US', entityCode: 291 })?.status, 'unknown');
  assert.equal(resolve('JA1ABC', 'BL11').status, 'unknown');
  // Natural Earth has no neutral, complete coverage for these South China Sea
  // DXCC entities. Keep their Grid display fail-closed and countryless.
  const spratly = resolve('9M0S', 'OJ85');
  assert.equal(spratly.status, 'unknown');
  assert.deepEqual(spratly.countries, []);
  const scarborough = resolve('BS7H', 'OJ85');
  assert.equal(scarborough.status, 'unknown');
  assert.deepEqual(scarborough.countries, []);
  assert.equal(resolveGridLocation(undefined, getCallsignInfo('JA1ABC')), undefined);

  assert.equal(parseFT8LocationInfo('CQ JA1ABC PM95').grid, 'PM95');
  assert.equal(parseFT8LocationInfo('<...> BG5DRB PM95').grid, undefined);
});

test('Grid location presents the Zangnan-related Grid area as China Tibet without a conflict', () => {
  const location = resolve('BY1AAA', 'NL68');
  assert.equal(location.status, 'unknown');
  assert.deepEqual(location.countries.map(country => country.code), ['CN']);
  assert.deepEqual(location.countries[0]?.subdivisions.map(subdivision => subdivision.code), ['CN-XZ']);

  // This Grid is almost entirely IN-AR in the source data. The guard must not
  // depend on Natural Earth's de facto boundary happening to cross the cell.
  const sourceOnlyIndia = resolve('BY1AAA', 'NL76');
  assert.equal(sourceOnlyIndia.status, 'unknown');
  assert.deepEqual(sourceOnlyIndia.countries.map(country => country.code), ['CN']);
  assert.deepEqual(sourceOnlyIndia.countries[0]?.subdivisions.map(subdivision => subdivision.code), ['CN-XZ']);
});
