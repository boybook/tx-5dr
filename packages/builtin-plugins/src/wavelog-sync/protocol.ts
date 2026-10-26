import { parseADIFFields, parseADIFRecord, sanitizeSyncFailureText } from '@tx5dr/plugin-api';
import type { QSORecord } from '@tx5dr/contracts';

export interface WaveLogPluginConfig {
  schemaVersion?: 2;
  apiVersion?: 'v1' | 'v2';
  url: string;
  apiKey: string;
  stationId: string;
  radioName?: string;
  autoUploadQSO: boolean;
  /** Legacy display-only value, never an upload cursor. */
  lastSyncTime?: number;
}
export interface Station {
  station_id: string;
  station_profile_name: string;
  station_callsign: string;
  station_gridsquare: string;
}
export interface InvalidRemoteRecord { reason: string; qsoCallsign?: string }
export interface RemotePage { records: QSORecord[]; cursor: number; total?: number; invalid: InvalidRemoteRecord[] }
export interface Confirmation {
  qsoId: number; callsign: string; time: number; mode: string; submode?: string;
  band: string; type: 'lotw' | 'qrz'; date?: number;
}
export class WavelogError extends Error {
  constructor(message: string, readonly httpStatus?: number, readonly nextAttemptAt?: number) { super(message); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WavelogError('Invalid API response');
  return value as Record<string, unknown>;
}
function integer(value: unknown, name: string): number {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) throw new WavelogError(`Invalid ${name}`);
  return number;
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new WavelogError(`Invalid ${name}`);
  return value;
}
export function protocolVersion(config: WaveLogPluginConfig): 'v1' | 'v2' {
  return config.apiVersion ?? (config.apiKey.startsWith('wl2_') ? 'v2' : 'v1');
}

/** Thin Wavelog wire adapter. All reconciliation and durable cursors belong to the provider. */
export class WavelogProtocol {
  constructor(private fetch: (url: string, init?: RequestInit) => Promise<Response>, readonly config: WaveLogPluginConfig) {}
  private url(path: string): string { return `${this.config.url.replace(/\/+$/, '')}/index.php/${path}`; }
  private async request(path: string, body?: unknown, readOnly = false, signal?: AbortSignal): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.fetch(this.url(path), {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json',
            ...(protocolVersion(this.config) === 'v2' ? { Authorization: `Bearer ${this.config.apiKey}` } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        });
        const raw = await response.text();
        let parsed: unknown;
        try { parsed = JSON.parse(raw); }
        catch { throw new WavelogError('Wavelog returned an invalid JSON response', response.status); }
        if (!response.ok) {
          const data = object(parsed);
          const error = data.error && typeof data.error === 'object' ? object(data.error) : data;
          const detail = [error.message, error.reason, ...(Array.isArray(data.messages) ? data.messages : [])]
            .filter((item): item is string => typeof item === 'string').join(' | ');
          const retryHeader = response.headers.get('retry-after');
          const seconds = retryHeader && /^\d+$/.test(retryHeader) ? Number(retryHeader) : undefined;
          const retryAt = retryHeader ? (seconds === undefined ? Date.parse(retryHeader) : Date.now() + seconds * 1000) : undefined;
          throw new WavelogError(sanitizeSyncFailureText(detail || `HTTP ${response.status}`, [this.config.apiKey]), response.status,
            retryAt && Number.isFinite(retryAt) ? retryAt : undefined);
        }
        const data = object(parsed);
        if (data.status === 'failed' || data.status === 'error') {
          throw new WavelogError(sanitizeSyncFailureText(String(data.reason ?? data.message ?? 'Wavelog request failed'), [this.config.apiKey]));
        }
        return data;
      } catch (error) {
        if (signal?.aborted) throw error;
        const normalized = error instanceof WavelogError ? error : new WavelogError('Wavelog network request failed');
        const retryable = normalized.httpStatus === undefined || normalized.httpStatus === 408 || normalized.httpStatus === 429 || normalized.httpStatus >= 500;
        if (!readOnly || !retryable || attempt >= 2) throw normalized;
        const delay = normalized.nextAttemptAt ? Math.max(0, normalized.nextAttemptAt - Date.now()) : [1000, 3000][attempt]! + Math.floor(Math.random() * 200);
        if (normalized.nextAttemptAt && delay > 3000) throw new WavelogError(normalized.message, normalized.httpStatus, Date.now() + delay);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delay);
          const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('Cancelled')); };
          signal?.addEventListener('abort', abort, { once: true });
        });
      }
    }
  }
  async stations(requiredScopes: readonly string[] = ['station:read', 'qso:read']): Promise<Station[]> {
    let rows: unknown;
    if (protocolVersion(this.config) === 'v2') {
      const token = object((await this.request('api/v2/token', undefined, true)).data);
      const scopes = token.scopes;
      if (!Array.isArray(scopes)) throw new WavelogError('Invalid token scopes');
      const required = [...new Set(['station:read', ...requiredScopes])];
      const missing = required.filter(scope => !scopes.includes(scope));
      if (missing.length) throw new WavelogError(`Missing token permissions: ${missing.join(', ')}`, 403);
      rows = (await this.request('api/v2/station', undefined, true)).data;
    } else {
      // station_info is an array; use the existing fetch boundary directly.
      const auth = await this.request(`api/check_auth/${encodeURIComponent(this.config.apiKey)}`, undefined, true);
      if (auth.rights !== 'r' && auth.rights !== 'rw') throw new WavelogError('API key requires read permission', 403);
      if (requiredScopes.includes('qso:write') && auth.rights !== 'rw') throw new WavelogError('API key requires write permission', 403);
      const response = await this.fetch(this.url(`api/station_info/${encodeURIComponent(this.config.apiKey)}`), { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new WavelogError(`Station request failed: HTTP ${response.status}`, response.status);
      rows = await response.json();
    }
    if (!Array.isArray(rows)) throw new WavelogError('Invalid station list');
    return rows.map(value => {
      const row = object(value); const v2 = protocolVersion(this.config) === 'v2';
      return { station_id: String(integer(row[v2 ? 'id' : 'station_id'], 'station ID')),
        station_profile_name: String(row[v2 ? 'name' : 'station_profile_name'] ?? ''),
        station_callsign: String(row[v2 ? 'callsign' : 'station_callsign'] ?? ''),
        station_gridsquare: String(row[v2 ? 'gridsquare' : 'station_gridsquare'] ?? '') };
    });
  }
  async download(cursor: number, signal?: AbortSignal): Promise<RemotePage> {
    const v2 = protocolVersion(this.config) === 'v2';
    const response = await this.request(v2
      ? `api/v2/qso?format=adif&station_id=${encodeURIComponent(this.config.stationId)}&since_id=${cursor}&page=1&per_page=1000`
      : 'api/get_contacts_adif', v2 ? undefined : { key: this.config.apiKey, station_id: this.config.stationId, fetchfromid: cursor, limit: 1000 }, true, signal);
    const data = v2 ? object(response.data) : response;
    const count = integer(data[v2 ? 'exported' : 'exported_qsos'], 'export count');
    const next = integer(data.lastfetchedid, 'download cursor');
    if ((count > 0 && next <= cursor) || next < cursor) throw new WavelogError('Download cursor did not advance');
    const adif = count === 0 && data.adif == null ? '' : text(data.adif, 'ADIF');
    const eoh = adif.search(/<eoh>/i);
    const parts = (eoh >= 0 ? adif.slice(eoh + 5) : adif).split(/<eor>/i).filter(part => part.trim());
    if (parts.length !== count) throw new WavelogError('Export count does not match the ADIF records');
    // One malformed remote record must not pin the cursor forever: skip it, advance,
    // and let the caller report it as a bounded failure.
    const records: QSORecord[] = []; const invalid: InvalidRemoteRecord[] = [];
    for (const part of parts) {
      let fields: Record<string, string>;
      try { fields = parseADIFFields(part); } catch { invalid.push({ reason: 'Unreadable ADIF record' }); continue; }
      if (!fields.call || !fields.qso_date || !fields.time_on || !fields.mode || !fields.freq || !(Number(fields.freq) > 0)) {
        invalid.push({ reason: 'ADIF record is missing identity fields', ...(fields.call ? { qsoCallsign: fields.call } : {}) });
        continue;
      }
      const record = parseADIFRecord(part, 'wavelog', { resolveDxcc: false });
      if (!record || !Number.isFinite(record.startTime)) {
        invalid.push({ reason: 'Invalid ADIF record', ...(fields.call ? { qsoCallsign: fields.call } : {}) });
        continue;
      }
      records.push(record);
    }
    const meta = v2 && response.meta ? object(response.meta) : undefined;
    return { records, cursor: next, total: meta?.total === undefined ? undefined : integer(meta.total, 'total'), invalid };
  }
  payload(adif: string): Record<string, unknown> {
    return protocolVersion(this.config) === 'v2'
      ? { station_profile_id: this.config.stationId, import_type: 'adif', adif }
      : { key: this.config.apiKey, station_profile_id: this.config.stationId, type: 'adif', string: adif };
  }
  async upload(adif: string, count: number, signal?: AbortSignal): Promise<{ imported: number; skipped: number; complete: boolean; message?: string }> {
    const v2 = protocolVersion(this.config) === 'v2';
    const response = await this.request(v2 ? 'api/v2/qso' : 'api/qso', this.payload(adif), false, signal);
    const data = v2 ? object(response.data) : response;
    if (v2) {
      const parsed = integer(data.parsed, 'parsed'); const imported = integer(data.imported, 'imported'); const skipped = integer(data.skipped, 'skipped');
      if (parsed !== count || imported + skipped > count || !Array.isArray(data.messages)) throw new WavelogError('Invalid bulk import summary');
      return { imported, skipped, complete: imported + skipped === count && data.messages.length === 0,
        message: data.messages.filter(item => typeof item === 'string').join(' | ') };
    }
    const parsed = integer(data.adif_count, 'parsed'); const errors = integer(data.adif_errors, 'errors');
    return { imported: data.status === 'created' && errors === 0 && parsed === count ? count : 0,
      skipped: 0, complete: data.status === 'created' && errors === 0 && parsed === count };
  }
  async confirmations(since: string, page: number): Promise<{ records: Confirmation[]; more: boolean; invalid: InvalidRemoteRecord[] }> {
    const response = await this.request(`api/v2/confirmation?station_id=${encodeURIComponent(this.config.stationId)}&type=lotw,qrz&since=${since}&page=${page}&per_page=1000`, undefined, true);
    if (!Array.isArray(response.data)) throw new WavelogError('Invalid confirmation list');
    const records: Confirmation[] = []; const invalid: InvalidRemoteRecord[] = [];
    for (const value of response.data) {
      // A single malformed confirmation must not fail every incremental download.
      try {
        const row = object(value); const type = text(row.type, 'confirmation type').toLowerCase();
        if (type !== 'lotw' && type !== 'qrz') throw new WavelogError('Unknown confirmation type');
        const time = Date.parse(`${text(row.qso_date, 'QSO date').replace(' ', 'T')}Z`);
        if (!Number.isFinite(time)) throw new WavelogError('Invalid confirmation QSO time');
        const date = row.confirmation_date ? Date.parse(`${String(row.confirmation_date).replace(' ', 'T')}${String(row.confirmation_date).includes(' ') ? 'Z' : 'T00:00:00Z'}`) : undefined;
        records.push({ qsoId: integer(row.qso_id, 'QSO ID'), callsign: text(row.callsign, 'callsign'), time,
          mode: text(row.mode, 'mode'), submode: typeof row.submode === 'string' ? row.submode : undefined,
          band: text(row.band, 'band'), type, date: date && Number.isFinite(date) ? date : undefined } as Confirmation);
      } catch (error) {
        invalid.push({ reason: error instanceof Error ? error.message : 'Invalid confirmation' });
      }
    }
    const meta = object(response.meta);
    if (typeof meta.has_more !== 'boolean') throw new WavelogError('Invalid confirmation pagination');
    return { records, more: meta.has_more, invalid };
  }
}
