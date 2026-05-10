import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CtyIndex, effectivePrefix, parseCTYDat, parseCTYCsv } from '../src/callsign/cty.js';
import ctyCsvText from '../src/callsign/cty-data.js';
import { COUNTRY_ZH_MAP } from '../src/callsign/callsign.js';

const csvFixture = [
  'K,United States,291,NA,5,8,37.60,91.87,5.0,K W =K1ABC(4)[7] K2A;',
  'KH6,Hawaii,110,OC,31,61,21.12,157.48,10.0,KH6 AH6;',
  'KG4,Guantanamo Bay,105,NA,8,11,20.00,75.00,5.0,KG4 =W1AW/KG4;',
  '*TA1,European Turkey,390,EU,20,39,41.02,-28.97,-2.0,TA1 TB1;',
  'TA,Asiatic Turkey,390,AS,20,39,39.18,-35.65,-2.0,TA TB TC YM =TA1E/0{EU}<41.00/-29.00>~-2~;',
  'S0,Western Sahara,302,AF,33,46,24.82,13.85,0.0,S0 =VER20260509;'
].join('\n');

test('CTY CSV parser handles primary, exact and overrides', () => {
  const parsed = parseCTYCsv(csvFixture);
  const index = new CtyIndex(parsed);
  const exact = index.lookup('K1ABC');
  const override = index.lookup('TA1E/0');

  assert.equal(parsed.version, 'VER20260509');
  assert.equal(index.lookup('TA1ABC')?.entityName, 'European Turkey');
  assert.equal(index.lookup('TA6B')?.entityName, 'Asiatic Turkey');
  assert.equal(exact?.entityName, 'United States');
  assert.equal(exact?.matchKind, 'exact');
  assert.equal(exact?.cqZone, 4);
  assert.equal(exact?.ituZone, 7);
  assert.equal(override?.continent, 'EU');
  assert.equal(override?.latitude, 41);
  assert.equal(override?.longitude, -29);
  assert.equal(override?.utcOffsetHours, -2);
});

test('CTY lookup follows WSJT-X slash and /MM /AM semantics', () => {
  const index = new CtyIndex(parseCTYCsv(csvFixture));

  assert.equal(effectivePrefix('W1AW/KH6'), 'KH6');
  assert.equal(effectivePrefix('KH6/W1AW'), 'KH6');
  assert.equal(effectivePrefix('W1AW/QRP'), 'W1AW');
  assert.equal(effectivePrefix('W1AW/LH'), 'W1AW');
  assert.equal(index.lookup('W1AW/KH6')?.entityName, 'Hawaii');
  assert.equal(index.lookup('KH6/W1AW')?.entityName, 'Hawaii');
  assert.equal(index.lookup('W1AW/MM'), null);
  assert.equal(index.lookup('W1AW/AM'), null);
  assert.equal(index.lookup('W1AW/KG4')?.entityName, 'Guantanamo Bay');
});

test('CTY duplicate token keys keep first row like WSJT-X ordered_unique', () => {
  const parsed = parseCTYCsv([
    'A,First,1,NA,1,1,0,0,0,AA;',
    'B,Second,2,NA,2,2,0,0,0,AA;'
  ].join('\n'));
  const index = new CtyIndex(parsed);

  assert.deepEqual(parsed.duplicateKeys, ['AA']);
  assert.equal(index.lookup('AA1ZZ')?.entityName, 'First');
});

test('CTY.DAT parser shares token semantics', () => {
  const datFixture = `Test Entity:  01:  02:  NA:   1.00:    2.00:    -3.0:  TE:\n    TE,=TE1ABC(4)[5]{EU}<6/7>~8~;`;
  const index = new CtyIndex(parseCTYDat(datFixture));
  const record = index.lookup('TE1ABC');

  assert.equal(record?.entityName, 'Test Entity');
  assert.equal(record?.matchKind, 'exact');
  assert.equal(record?.cqZone, 4);
  assert.equal(record?.ituZone, 5);
  assert.equal(record?.continent, 'EU');
  assert.equal(record?.latitude, 6);
  assert.equal(record?.longitude, 7);
  assert.equal(record?.utcOffsetHours, 8);
});


test('current CTY entity names all have direct Chinese translations', () => {
  const ctyNames = [...new Set(parseCTYCsv(ctyCsvText).rows.map((row) => row.entityName))].sort();
  const missingNames = ctyNames.filter((name) => !COUNTRY_ZH_MAP[name]);

  assert.deepEqual(missingNames, []);
  assert.equal(COUNTRY_ZH_MAP['Sov Mil Order of Malta'], '马耳他主权军事修会');
  assert.equal(COUNTRY_ZH_MAP['Agalega & St. Brandon'], '阿加莱加和圣布兰登');
  assert.equal(COUNTRY_ZH_MAP['Dem. Rep. of the Congo'], '刚果民主共和国');
  assert.equal(COUNTRY_ZH_MAP['Asiatic Turkey'], '土耳其·亚洲');
  assert.equal(COUNTRY_ZH_MAP['European Turkey'], '土耳其·欧洲');
});
