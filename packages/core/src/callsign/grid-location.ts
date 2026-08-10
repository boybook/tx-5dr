import { getFourCharacterGrid } from '@tx5dr/contracts';
import type { CallsignInfo } from './callsign.js';
import {
  MAIDENHEAD_GRID_COUNTRIES,
  MAIDENHEAD_GRID_REGIONS,
  MAIDENHEAD_GRID_SUBDIVISIONS,
} from './maidenhead-grid-regions.js';

export type GridLocationStatus = 'compatible' | 'conflict' | 'ambiguous' | 'unknown';

export interface GridLocationSubdivision {
  code: string;
  nameEn: string;
}

export interface GridLocationCountry {
  code: string;
  nameEn: string;
  coveragePermille: number;
  subdivisions: GridLocationSubdivision[];
}

export interface GridLocation {
  grid: string;
  status: GridLocationStatus;
  countries: GridLocationCountry[];
  matchedBy?: 'country' | 'dxcc-entity';
}

// A 4-character Grid is large. Require substantial land coverage before
// treating a unique political-country result as a visible conflict.
const MIN_CONFLICT_COVERAGE_PERMILLE = 450;
const NON_COMPARABLE_COUNTRIES = new Set(['AQ', 'ZZ']);
const ZANGNAN_SOURCE_SUBDIVISIONS = new Set(['IN-AR']);
const SOUTH_CHINA_SEA_DXCC_ENTITIES = new Set([247, 506]);
const GRID_DISPLAY_COMPATIBLE_COUNTRY_PAIRS = new Set(['CN:TW']);
const EXPLICIT_DXCC_ENTITY_COUNTRIES = new Map<number, string>([
  [6, 'US'],
  [110, 'US'],
  [291, 'US'],
  [223, 'GB'],
  [265, 'GB'],
  [279, 'GB'],
  [294, 'GB'],
]);

function resolveCountries(grid: string): GridLocationCountry[] {
  const record = MAIDENHEAD_GRID_REGIONS[grid];
  if (!record) return [];

  return record[0].map(([countryId, coveragePermille, subdivisionIds]) => {
    const country = MAIDENHEAD_GRID_COUNTRIES[countryId];
    return {
      code: country.code,
      nameEn: country.nameEn,
      coveragePermille,
      subdivisions: subdivisionIds.map(subdivisionId => {
        const subdivision = MAIDENHEAD_GRID_SUBDIVISIONS[subdivisionId];
        return {
          code: subdivision.code,
          nameEn: subdivision.nameEn,
        };
      }),
    };
  });
}

function isZangnanGrid(countries: readonly GridLocationCountry[]): boolean {
  return countries.some(country => country.subdivisions.some(
    subdivision => ZANGNAN_SOURCE_SUBDIVISIONS.has(subdivision.code),
  ));
}

function resolveZangnanDisplayCountries(): GridLocationCountry[] {
  const china = MAIDENHEAD_GRID_COUNTRIES.find(country => country.code === 'CN');
  const tibet = MAIDENHEAD_GRID_SUBDIVISIONS.find(subdivision => subdivision.code === 'CN-XZ');
  if (!china || !tibet) return [];

  return [{
    code: china.code,
    nameEn: china.nameEn,
    // This is a display policy, not an area-coverage measurement.
    coveragePermille: 0,
    subdivisions: [{ code: tibet.code, nameEn: tibet.nameEn }],
  }];
}

function hasGridDisplayCountryCompatibility(left: string, right: string): boolean {
  if (left === right) return true;
  return GRID_DISPLAY_COMPATIBLE_COUNTRY_PAIRS.has([left, right].sort().join(':'));
}

/**
 * Resolve the regions covered by a four-character Maidenhead Grid and compare
 * them conservatively to a decoded callsign. This function is display-only:
 * callers must not use it to alter DXCC, logging, or automation decisions.
 */
export function resolveGridLocation(grid: string | undefined, callsignInfo?: Pick<CallsignInfo, 'callsign' | 'countryCode' | 'entityCode'>): GridLocation | undefined {
  const normalizedGrid = getFourCharacterGrid(grid);
  if (!normalizedGrid) return undefined;

  if (callsignInfo?.entityCode !== undefined && SOUTH_CHINA_SEA_DXCC_ENTITIES.has(callsignInfo.entityCode)) {
    // The source omits or de facto-assigns several South China Sea features.
    // Keep a received locator visible, but never attach another country's
    // geometry to these DXCC entities or infer a conflict from it.
    return { grid: normalizedGrid, status: 'unknown', countries: [] };
  }

  const countries = resolveCountries(normalizedGrid);
  if (isZangnanGrid(countries)) {
    return {
      grid: normalizedGrid,
      status: 'unknown',
      // Natural Earth encodes this area with a de facto IN-AR boundary. Do not
      // expose that source label or derive a callsign conflict from it.
      countries: resolveZangnanDisplayCountries(),
    };
  }

  if (countries.length !== 1) {
    return {
      grid: normalizedGrid,
      status: countries.length > 1 ? 'ambiguous' : 'unknown',
      countries,
    };
  }

  const [country] = countries;
  if (/\/(?:MM|AM)$/i.test(callsignInfo?.callsign ?? '')) {
    return { grid: normalizedGrid, status: 'unknown', countries };
  }

  if (
    !callsignInfo?.countryCode
    || NON_COMPARABLE_COUNTRIES.has(callsignInfo.countryCode)
    || NON_COMPARABLE_COUNTRIES.has(country.code)
  ) {
    return { grid: normalizedGrid, status: 'unknown', countries };
  }

  const entityCode = callsignInfo.entityCode;
  const record = MAIDENHEAD_GRID_REGIONS[normalizedGrid];
  const entityCountryCode = entityCode === undefined ? undefined : EXPLICIT_DXCC_ENTITY_COUNTRIES.get(entityCode);
  const callsignCountryCode = entityCountryCode || callsignInfo.countryCode;
  // The cross-strait pair is compatible only for this display conflict cue.
  // It leaves the underlying DXCC country and entity identifiers untouched.
  const countryMatches = hasGridDisplayCountryCompatibility(callsignCountryCode, country.code);

  if (entityCode !== undefined && entityCountryCode !== undefined) {
    const entityCodesInGrid = record?.[1] ?? [];
    if (entityCodesInGrid.includes(entityCode)) {
      return { grid: normalizedGrid, status: 'compatible', countries, matchedBy: 'dxcc-entity' };
    }

    // A Grid which overlaps several peer entities in the same political
    // country cannot prove where inside it the station is. Keep it fail-closed.
    if (countryMatches && entityCodesInGrid.length > 1) {
      return { grid: normalizedGrid, status: 'ambiguous', countries };
    }

    if (!countryMatches || entityCodesInGrid.length === 1) {
      return {
        grid: normalizedGrid,
        status: country.coveragePermille >= MIN_CONFLICT_COVERAGE_PERMILLE ? 'conflict' : 'unknown',
        countries,
      };
    }

    return { grid: normalizedGrid, status: 'compatible', countries, matchedBy: 'country' };
  }

  if (!countryMatches) {
    return {
      grid: normalizedGrid,
      status: country.coveragePermille >= MIN_CONFLICT_COVERAGE_PERMILLE ? 'conflict' : 'unknown',
      countries,
    };
  }

  return { grid: normalizedGrid, status: 'compatible', countries, matchedBy: 'country' };
}
