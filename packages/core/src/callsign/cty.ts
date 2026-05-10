export type CtyMatchKind = 'prefix' | 'exact';

export interface CtyTokenOverrides {
  cqZone?: number;
  ituZone?: number;
  continent?: string;
  latitude?: number;
  longitude?: number;
  utcOffsetHours?: number;
}

export interface CtyPrefixToken {
  raw: string;
  key: string;
  exact: boolean;
  overrides: CtyTokenOverrides;
  row: CtyRow;
}

export interface CtyRow {
  rowIndex: number;
  entityName: string;
  entityCode?: number;
  primaryPrefix: string;
  waeOnly: boolean;
  continent: string;
  cqZone: number;
  ituZone: number;
  latitude: number;
  longitude: number;
  utcOffsetHours: number;
  tokens: CtyPrefixToken[];
}

export interface CtyLookupRecord {
  entityName: string;
  entityCode?: number;
  primaryPrefix: string;
  waeOnly: boolean;
  continent: string;
  cqZone: number;
  ituZone: number;
  latitude: number;
  longitude: number;
  utcOffsetHours: number;
  matchedPrefix: string;
  matchKind: CtyMatchKind;
  exact: boolean;
  needsReview: boolean;
}

export interface CtyParseResult {
  rows: CtyRow[];
  version?: string;
  duplicateKeys: string[];
}

const TOKEN_OVERRIDE_START = /[({[<~]/;
const VERSION_PATTERN = /^VER\d{8}$/i;
const NON_PREFIX_SUFFIX = /^(?:[0-9AMPQR]|QRP|F[DF]|[AM]M|L[HT]|LGT)$/;

function parseNumber(value: string): number {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : NaN;
}

function stripTrailingSemicolon(value: string): string {
  return value.replace(/;+$/, '');
}

function parseOverrideNumber(raw: string, left: string, right: string): number | undefined {
  const value = parseOverrideText(raw, left, right);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOverrideText(raw: string, left: string, right: string): string | undefined {
  const start = raw.indexOf(left);
  if (start === -1) return undefined;
  const end = raw.indexOf(right, start + 1);
  if (end === -1) return undefined;
  const value = raw.slice(start + 1, end).trim();
  return value || undefined;
}

function parseOverrides(raw: string): CtyTokenOverrides {
  const overrides: CtyTokenOverrides = {};
  const cqZone = parseOverrideNumber(raw, '(', ')');
  const ituZone = parseOverrideNumber(raw, '[', ']');
  const continent = parseOverrideText(raw, '{', '}');
  const latLon = parseOverrideText(raw, '<', '>');
  const utcOffsetHours = parseOverrideNumber(raw, '~', '~');

  if (cqZone !== undefined) overrides.cqZone = cqZone;
  if (ituZone !== undefined) overrides.ituZone = ituZone;
  if (continent) overrides.continent = continent.toUpperCase();
  if (utcOffsetHours !== undefined) overrides.utcOffsetHours = utcOffsetHours;
  if (latLon) {
    const [lat, lon] = latLon.split('/').map((part) => Number(part.trim()));
    if (Number.isFinite(lat)) overrides.latitude = lat;
    if (Number.isFinite(lon)) overrides.longitude = lon;
  }

  return overrides;
}

function tokenKey(raw: string): string {
  const overrideIndex = raw.search(TOKEN_OVERRIDE_START);
  const key = overrideIndex === -1 ? raw : raw.slice(0, overrideIndex);
  return key.toUpperCase();
}

function normalizePrimaryPrefix(value: string): { primaryPrefix: string; waeOnly: boolean } | null {
  let raw = stripTrailingSemicolon(value.trim());
  if (!raw) return null;
  const waeOnly = raw.startsWith('*');
  if (waeOnly) raw = raw.slice(1);
  const key = tokenKey(raw).trim();
  if (!key) return null;
  return { primaryPrefix: key, waeOnly };
}

function createToken(rawToken: string, row: CtyRow): CtyPrefixToken | null {
  let raw = stripTrailingSemicolon(rawToken.trim());
  if (!raw) return null;

  let exact = false;
  if (raw.startsWith('=')) {
    exact = true;
    raw = raw.slice(1);
  }

  if (raw.startsWith('*')) {
    raw = raw.slice(1);
  }

  const key = tokenKey(raw).trim();
  if (!key || !/^[A-Z0-9/]+$/.test(key)) return null;

  return {
    raw: raw.toUpperCase(),
    key,
    exact,
    overrides: parseOverrides(raw),
    row,
  };
}

function attachTokens(row: CtyRow, rawTokens: string[]): void {
  const tokens: CtyPrefixToken[] = [];
  const seenKeys = new Set<string>();

  for (const rawToken of rawTokens) {
    const token = createToken(rawToken, row);
    if (!token) continue;
    tokens.push(token);
    seenKeys.add(token.key);
  }

  if (!seenKeys.has(row.primaryPrefix)) {
    const primaryToken = createToken(row.primaryPrefix, row);
    if (primaryToken) tokens.unshift(primaryToken);
  }

  row.tokens = tokens;
}

export function parseCTYCsv(text: string): CtyParseResult {
  const rows: CtyRow[] = [];
  let version: string | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const parts = line.split(',');
    if (parts.length < 10) continue;

    const primary = normalizePrimaryPrefix(parts[0]);
    if (!primary) continue;

    const entityCode = Number(parts[2].trim());
    const row: CtyRow = {
      rowIndex: rows.length,
      entityName: parts[1].trim(),
      entityCode: Number.isFinite(entityCode) ? entityCode : undefined,
      primaryPrefix: primary.primaryPrefix,
      waeOnly: primary.waeOnly,
      continent: parts[3].trim().toUpperCase(),
      cqZone: parseNumber(parts[4]),
      ituZone: parseNumber(parts[5]),
      latitude: parseNumber(parts[6]),
      longitude: parseNumber(parts[7]),
      utcOffsetHours: parseNumber(parts[8]),
      tokens: [],
    };

    const aliasField = parts.slice(9).join(',').trim();
    attachTokens(row, aliasField.split(/\s+/).filter(Boolean));
    for (const token of row.tokens) {
      if (token.exact && VERSION_PATTERN.test(token.key)) {
        version = token.key.toUpperCase();
      }
    }
    rows.push(row);
  }

  const duplicateKeys = collectDuplicateKeys(rows);
  return { rows, version, duplicateKeys };
}

export function parseCTYDat(text: string): CtyParseResult {
  const lines = text.split(/\r?\n/);
  const rows: CtyRow[] = [];
  let version: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#') || !line.endsWith(':')) continue;

    const fields = line.split(':').map((part) => part.trim());
    if (fields.length < 8) continue;

    const primary = normalizePrimaryPrefix(fields[7]);
    if (!primary) continue;

    const row: CtyRow = {
      rowIndex: rows.length,
      entityName: fields[0],
      entityCode: undefined,
      primaryPrefix: primary.primaryPrefix,
      waeOnly: primary.waeOnly,
      continent: fields[3].toUpperCase(),
      cqZone: parseNumber(fields[1]),
      ituZone: parseNumber(fields[2]),
      latitude: parseNumber(fields[4]),
      longitude: parseNumber(fields[5]),
      utcOffsetHours: parseNumber(fields[6]),
      tokens: [],
    };

    const aliasLines: string[] = [];
    while (index + 1 < lines.length) {
      const next = lines[index + 1].trim();
      index += 1;
      if (!next || next.startsWith('#')) continue;
      aliasLines.push(next);
      if (next.endsWith(';')) break;
    }

    const aliasTokens = aliasLines.join(' ').split(',').map((token) => token.trim()).filter(Boolean);
    attachTokens(row, aliasTokens);
    for (const token of row.tokens) {
      if (token.exact && VERSION_PATTERN.test(token.key)) {
        version = token.key.toUpperCase();
      }
    }
    rows.push(row);
  }

  const duplicateKeys = collectDuplicateKeys(rows);
  return { rows, version, duplicateKeys };
}

function collectDuplicateKeys(rows: CtyRow[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    for (const token of row.tokens) {
      if (seen.has(token.key)) duplicates.add(token.key);
      else seen.add(token.key);
    }
  }
  return [...duplicates].sort();
}

function applyTokenOverrides(row: CtyRow, token: CtyPrefixToken, matchedPrefix: string, matchKind: CtyMatchKind): CtyLookupRecord {
  return {
    entityName: row.entityName,
    entityCode: row.entityCode,
    primaryPrefix: row.primaryPrefix,
    waeOnly: row.waeOnly,
    continent: token.overrides.continent ?? row.continent,
    cqZone: token.overrides.cqZone ?? row.cqZone,
    ituZone: token.overrides.ituZone ?? row.ituZone,
    latitude: token.overrides.latitude ?? row.latitude,
    longitude: token.overrides.longitude ?? row.longitude,
    utcOffsetHours: token.overrides.utcOffsetHours ?? row.utcOffsetHours,
    matchedPrefix,
    matchKind,
    exact: token.exact,
    needsReview: row.entityCode === undefined,
  };
}

export function effectivePrefix(callsign: string): string {
  const upper = callsign.toUpperCase().trim();
  const slashIndex = upper.indexOf('/');
  if (slashIndex < 0) return upper;

  // Mirrors WSJT-X Radio::effective_prefix for portable/slash calls.
  const right = upper.slice(slashIndex + 1);
  let prefix: string;
  if (right.length >= slashIndex) {
    prefix = upper.slice(0, slashIndex);
  } else {
    prefix = right;
    if (NON_PREFIX_SUFFIX.test(prefix)) {
      prefix = upper.slice(0, slashIndex);
    }
  }

  return prefix;
}

export class CtyIndex {
  private readonly tokenByKey = new Map<string, CtyPrefixToken>();
  private readonly rowByPrimaryPrefix = new Map<string, CtyRow>();
  private readonly cache = new Map<string, CtyLookupRecord | null>();
  readonly rows: CtyRow[];
  readonly version: string;
  readonly duplicateKeys: string[];

  constructor(parseResult: CtyParseResult, fallbackVersion = 'cty-runtime') {
    this.rows = parseResult.rows;
    this.version = parseResult.version ?? fallbackVersion;
    this.duplicateKeys = parseResult.duplicateKeys;

    for (const row of this.rows) {
      if (!this.rowByPrimaryPrefix.has(row.primaryPrefix)) {
        this.rowByPrimaryPrefix.set(row.primaryPrefix, row);
      }
      for (const token of row.tokens) {
        if (VERSION_PATTERN.test(token.key) || token.key === 'VERSION') continue;
        if (!this.tokenByKey.has(token.key)) {
          this.tokenByKey.set(token.key, token);
        }
      }
    }
  }

  lookup(callsign: string): CtyLookupRecord | null {
    const call = callsign.toUpperCase().trim();
    if (!call) return null;
    if (call.endsWith('/MM') || call.endsWith('/AM')) return null;

    const cached = this.cache.get(call);
    if (cached !== undefined) return cached ? { ...cached } : null;

    const search = effectivePrefix(call);

    // Mirrors WSJT-X AD1CCty: exact full-call exceptions win before the
    // effective portable prefix is truncated.
    if (search !== call) {
      const fullExact = this.tokenByKey.get(call);
      if (fullExact?.exact) {
        const result = applyTokenOverrides(fullExact.row, fullExact, call, 'exact');
        this.cache.set(call, result);
        return { ...result };
      }
    }

    let searchPrefix = search;
    while (searchPrefix.length > 0) {
      const token = this.tokenByKey.get(searchPrefix);
      if (token && (!token.exact || call.length === searchPrefix.length)) {
        const row = this.lookupEntityRow(call, token);
        const result = applyTokenOverrides(row, token, searchPrefix, token.exact ? 'exact' : 'prefix');
        this.cache.set(call, result);
        return { ...result };
      }
      searchPrefix = searchPrefix.slice(0, -1);
    }

    this.cache.set(call, null);
    return null;
  }

  private lookupEntityRow(call: string, token: CtyPrefixToken): CtyRow {
    // WSJT-X AD1CCty.cpp special-case: most KG4 calls are mainland US, while
    // KG4 + 0/2 suffix length remains Guantanamo Bay.
    if (call.startsWith('KG4') && call.length !== 5 && call.length !== 3) {
      return this.rowByPrimaryPrefix.get('K') ?? token.row;
    }
    return token.row;
  }

  getAllRows(): CtyRow[] {
    return [...this.rows];
  }
}
