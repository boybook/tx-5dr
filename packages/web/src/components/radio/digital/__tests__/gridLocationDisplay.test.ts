import { describe, expect, it } from 'vitest';
import type { GridLocation } from '@tx5dr/core';
import i18n from '../../../../i18n';
import enGridRegions from '../../../../i18n/locales/en/grid-regions.json';
import jaGridRegions from '../../../../i18n/locales/ja/grid-regions.json';
import zhGridRegions from '../../../../i18n/locales/zh/grid-regions.json';
import { formatGridLocation, getLocalizedGridSubdivisionName } from '../gridLocationDisplay';

const chinaGridLocation: GridLocation = {
  grid: 'PN99',
  status: 'compatible',
  countries: [{
    code: 'CN',
    nameEn: 'People\'s Republic of China',
    coveragePermille: 1000,
    subdivisions: [
      { code: 'CN-HL', nameEn: 'Heilongjiang' },
      { code: 'CN-JL', nameEn: 'Jilin' },
    ],
  }],
};

const taiwanGridLocation: GridLocation = {
  grid: 'PL03',
  status: 'compatible',
  countries: [{
    code: 'TW',
    nameEn: 'Taiwan',
    coveragePermille: 664,
    subdivisions: [],
  }],
};

const paracelGridLocation: GridLocation = {
  grid: 'OK66',
  status: 'unknown',
  countries: [{
    code: 'CN',
    nameEn: 'People\'s Republic of China',
    coveragePermille: 0,
    subdivisions: [{ code: 'CN-X01~', nameEn: 'Paracel Islands' }],
  }],
};

describe('Grid location display localization', () => {
  it('uses the CLDR names and locale-specific subdivision separators', () => {
    expect(formatGridLocation(chinaGridLocation, 'zh', i18n.getFixedT('zh'))).toBe('\u4e2d\u56fd \u00b7 \u9ed1\u9f99\u6c5f\u7701\u3001\u5409\u6797\u7701');
    expect(formatGridLocation(chinaGridLocation, 'ja', i18n.getFixedT('ja'))).toBe('\u4e2d\u56fd \u00b7 \u9ed2\u7adc\u6c5f\u7701\u3001\u5409\u6797\u7701');
    expect(formatGridLocation(chinaGridLocation, 'en', i18n.getFixedT('en'))).toBe('China · Heilongjiang, Jilin');
  });

  it('does not leak the app fallback language for an untranslated subdivision', () => {
    expect(getLocalizedGridSubdivisionName(
      { code: 'AD-08', nameEn: 'Escaldes-Engordany' },
      'ja',
      i18n.getFixedT('ja'),
    )).toBe('Escaldes-Engordany');
  });

  it('uses the product Chinese country label and the curated non-CLDR Xisha name', () => {
    expect(formatGridLocation(taiwanGridLocation, 'zh', i18n.getFixedT('zh'))).toBe('\u4e2d\u56fd\u53f0\u6e7e');
    expect(formatGridLocation(taiwanGridLocation, 'en', i18n.getFixedT('en'))).toBe('Taiwan');
    expect(formatGridLocation(paracelGridLocation, 'zh', i18n.getFixedT('zh'))).toBe('\u4e2d\u56fd \u00b7 \u897f\u6c99\u7fa4\u5c9b');
    expect(formatGridLocation(paracelGridLocation, 'ja', i18n.getFixedT('ja'))).toBe('\u4e2d\u56fd \u00b7 \u897f\u6c99\u8af8\u5cf6');
  });

  it('formats the China Tibet display override used for Zangnan-related Grids', () => {
    expect(formatGridLocation({
      grid: 'NL68',
      status: 'unknown',
      countries: [{
        code: 'CN',
        nameEn: 'People\'s Republic of China',
        coveragePermille: 0,
        subdivisions: [{ code: 'CN-XZ', nameEn: 'Tibet' }],
      }],
    }, 'zh', i18n.getFixedT('zh'))).toBe('\u4e2d\u56fd \u00b7 \u897f\u85cf\u81ea\u6cbb\u533a');
  });

  it('pins the CLDR revision and reports each locale coverage explicitly', () => {
    const documents = [enGridRegions, zhGridRegions, jaGridRegions];
    for (const document of documents) {
      expect(document._meta.source).toBe('Unicode CLDR 48.2');
      expect(document._meta.revision).toBe('11299982335beb974c1c63c45265184e759c0f41');
      expect(document._meta.localizedCount).toBe(Object.keys(document.subdivisions).length);
      expect(document._meta.localizedCount + document._meta.fallbackCount).toBe(document._meta.subdivisionCount);
      expect(document._meta.curatedSubdivisionOverrideCount).toBe(1);
      expect(document.subdivisions['CN-X01~']).toBeTruthy();
    }
    expect(zhGridRegions.countries.TW).toBe('\u4e2d\u56fd\u53f0\u6e7e');
  });
});
