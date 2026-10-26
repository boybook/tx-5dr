import { useEffect, useRef, useState, useCallback } from 'react';
import { SyncStatusProjectionSchema, type SyncStatusProjection } from '@tx5dr/contracts';
import { getAuthHeaders } from '../../utils/authHeaders';
import { createLogger } from '../../utils/logger';

const logger = createLogger('SyncStatus');

export function useSyncProviderStatuses(callsign: string) {
  const [providers, setProviders] = useState<Record<string, SyncStatusProjection>>({});
  const [unavailable, setUnavailable] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number>();
  const request = useRef<() => void>(() => {});
  const refresh = useCallback(() => request.current(), []);
  useEffect(() => {
    setProviders({}); setUnavailable(false); setUpdatedAt(undefined);
    if (!callsign) return;
    let disposed = false; let active = false; let again = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let latest: Record<string, SyncStatusProjection> = {};
    const poll = async () => {
      if (disposed) return;
      if (active) { again = true; return; }
      active = true; clearTimeout(timer);
      controller = new AbortController();
      try {
        const response = await fetch(`/api/plugins/sync-providers/status?callsign=${encodeURIComponent(callsign)}`, {
          headers: getAuthHeaders(), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        });
        if (!response.ok) throw new Error('Sync status request failed');
        const body = await response.json() as { providers?: unknown };
        if (!body || typeof body !== 'object' || !body.providers || typeof body.providers !== 'object') throw new Error('Invalid sync status response');
        // Parse each provider separately: one broken projection must not blank every badge.
        const next: Record<string, SyncStatusProjection> = {};
        for (const [id, value] of Object.entries(body.providers as Record<string, unknown>)) {
          const parsed = SyncStatusProjectionSchema.safeParse(value);
          if (parsed.success) next[id] = parsed.data;
          else logger.warn('Dropping invalid sync status projection', { provider: id });
        }
        if (disposed) return;
        failures = 0;
        for (const [id, entry] of Object.entries(next)) {
          const previous = latest[id]?.status;
          if (!entry.available && previous) next[id] = { ...entry, status: previous };
          if (entry.status && previous && previous.instanceId === entry.status.instanceId
            && (previous.startedAt > entry.status.startedAt || previous.operationId === entry.status.operationId && previous.revision > entry.status.revision)) next[id] = latest[id]!;
        }
        for (const [id, previous] of Object.entries(latest)) {
          if (!(id in next) && previous.supported) next[id] = { ...previous, available: false };
        }
        latest = next; setProviders(next); setUnavailable(false); setUpdatedAt(Date.now());
      } catch { failures += 1; if (!disposed) setUnavailable(true); }
      finally {
        active = false;
        if (!disposed) {
          const busy = Object.values(latest).some(entry => entry.status?.autoUploading || ['running', 'waiting', 'pausing'].includes(entry.status?.state ?? ''));
          const healthy = busy ? 1000 : document.hidden ? 30_000 : 10_000;
          const delay = again ? 0
            : failures > 0 ? Math.min(10_000 * 2 ** Math.min(failures - 1, 4), 120_000) + Math.floor(Math.random() * 1000)
            : healthy;
          again = false; timer = setTimeout(poll, delay);
        }
      }
    };
    request.current = () => { void poll(); };
    const focus = () => { void poll(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    void poll();
    return () => { disposed = true; controller?.abort(); clearTimeout(timer); request.current = () => {};
      window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [callsign]);
  return { providers, unavailable, updatedAt, refresh };
}
