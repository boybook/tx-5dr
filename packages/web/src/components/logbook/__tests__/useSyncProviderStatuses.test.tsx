// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSyncProviderStatuses } from '../useSyncProviderStatuses';
vi.mock('../../../utils/authHeaders', () => ({ getAuthHeaders: () => ({}) }));
const status = { operationId: 'one', revision: 2, operation: 'full_sync', state: 'paused', stage: 'downloading',
  startedAt: 1, updatedAt: 2, processed: 0, downloaded: 0, imported: 0, updated: 0, uploaded: 0, skipped: 0,
  failed: 0, conflicts: 0, rejected: 0, resumable: true, errors: [] };
function response(next = status) { return new Response(JSON.stringify({ providers: { generic: { supported: true, available: true, status: next } } })); }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('sync status polling', () => {
  it('retains the last result on failures and rejects a lower revision', async () => {
    const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useSyncProviderStatuses('BG5DRB'));
    await waitFor(() => expect(result.current.providers.generic?.status?.state).toBe('paused'));
    fetch.mockRejectedValueOnce(new Error('offline'));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.unavailable).toBe(true));
    expect(result.current.providers.generic?.status?.revision).toBe(2);
    fetch.mockResolvedValueOnce(response({ ...status, revision: 1, state: 'running' }));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.unavailable).toBe(false));
    expect(result.current.providers.generic?.status?.state).toBe('paused');
    fetch.mockResolvedValueOnce(response({ ...status, operationId: 'older-operation', startedAt: 0, revision: 100 }));
    act(() => result.current.refresh());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    expect(result.current.providers.generic?.status?.operationId).toBe('one');
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ providers: { generic: { supported: true, available: false, status: null } } })));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.providers.generic?.available).toBe(false));
    expect(result.current.providers.generic?.status?.state).toBe('paused');
  });
  it('clears a different callsign and does not overlap requests', async () => {
    let resolve!: (value: Response) => void;
    const fetch = vi.fn(async () => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(({ callsign }) => useSyncProviderStatuses(callsign), { initialProps: { callsign: 'BG5DRB' } });
    act(() => { result.current.refresh(); result.current.refresh(); });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(response()); });
    await waitFor(() => expect(result.current.providers.generic?.status).toBeDefined());
    rerender({ callsign: '' }); expect(result.current.providers).toEqual({});
  });
  it('keeps valid providers when one projection is invalid', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ providers: {
      good: { supported: true, available: true, status },
      bad: { supported: true },
    } })));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useSyncProviderStatuses('BG5DRB'));
    await waitFor(() => expect(result.current.providers.good?.status?.state).toBe('paused'));
    expect(result.current.providers.bad).toBeUndefined();
  });
});
