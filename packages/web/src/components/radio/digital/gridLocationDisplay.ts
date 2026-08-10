import type { TFunction } from 'i18next';
import { getIntlLocale, resolveSupportedLanguage } from '../../../i18n/language';
import type { GridLocation, GridLocationCountry, GridLocationSubdivision } from '@tx5dr/core';

export const GRID_REGIONS_NAMESPACE = 'gridRegions';

function getLocalizedGridCountryName(country: GridLocationCountry, language: string, t: TFunction): string {
  let fallback = country.nameEn;
  try {
    fallback = new Intl.DisplayNames([getIntlLocale(language)], { type: 'region' }).of(country.code) || country.nameEn;
  } catch {
    // Use the Natural Earth English label when Intl has no region name.
  }
  return translateGridRegion(t, `countries.${country.code}`, language, fallback);
}

function translateGridRegion(t: TFunction, key: string, language: string, fallback: string): string {
  const translated = t(key, {
    ns: GRID_REGIONS_NAMESPACE,
    lng: resolveSupportedLanguage(language),
    fallbackLng: false,
    defaultValue: fallback,
  });
  return typeof translated === 'string' ? translated : fallback;
}

export function getLocalizedGridSubdivisionName(
  subdivision: GridLocationSubdivision,
  language: string,
  t: TFunction,
): string {
  return translateGridRegion(t, `subdivisions.${subdivision.code}`, language, subdivision.nameEn);
}

export function formatGridLocation(location: GridLocation | undefined, language: string, t: TFunction): string | undefined {
  if (!location || location.countries.length === 0) return undefined;

  const subdivisionSeparator = translateGridRegion(
    t,
    'subdivisionSeparator',
    language,
    resolveSupportedLanguage(language) === 'en' ? ', ' : '、',
  );
  return location.countries.map(country => {
    const countryName = getLocalizedGridCountryName(country, language, t);
    const subdivisions = country.subdivisions.map(subdivision => getLocalizedGridSubdivisionName(subdivision, language, t));
    return subdivisions.length > 0 ? `${countryName} · ${subdivisions.join(subdivisionSeparator)}` : countryName;
  }).join(' / ');
}
