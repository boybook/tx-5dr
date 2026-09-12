// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SstvTxStatus } from '@tx5dr/contracts';
import { useSstvTxStart } from '../useSstvTxStart';

const mocks = vi.hoisted(() => ({
  start: vi.fn(), toast: vi.fn(), t: (key: string) => key,
  status: { sstvTxTarget: undefined as 'local' | 'radio' | undefined },
  txStatus: null as SstvTxStatus | null,
  txCommandResult: null as { requestId: string; accepted: boolean } | null,
}));
vi.mock('@heroui/toast', () => ({ addToast: mocks.toast }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('../useImageRadio', () => ({ useImageRadioControls: () => mocks }));
vi.mock('../../store/radioStore', () => ({ useConnection: () => ({ state: { isReady: true, radioService: { startSstvTx: mocks.start } } }) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status = { sstvTxTarget: undefined };
  mocks.txStatus = null;
  mocks.txCommandResult = null;
});
afterEach(cleanup);

describe('SSTV local playback controls', () => {
  it('enables local playback only from explicit server status', () => {
    const { result, rerender } = renderHook(useSstvTxStart);
    expect(result.current.localPlayback).toBe(false);
    mocks.status.sstvTxTarget = 'local'; rerender();
    expect(result.current.localPlayback).toBe(true);
    mocks.status.sstvTxTarget = 'radio'; rerender();
    expect(result.current.localPlayback).toBe(false);
  });

  it('sends a null frequency and reports a post-acceptance output failure only once', async () => {
    mocks.status.sstvTxTarget = 'local';
    const { result, rerender } = renderHook(useSstvTxStart);
    await act(async () => {
      result.current.start('composer', async () => ({ artifactId: 'image', operatorId: 'op', mode: 'robot36', expectedFrequency: null,
        envelope: { enhancedPreamble: false, stationIdMode: 'none' } }));
    });
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ expectedFrequency: null }));
    const requestId = mocks.start.mock.calls[0][0].requestId;
    mocks.txCommandResult = { requestId, accepted: true }; rerender();
    mocks.txStatus = { requestId, sessionId: 'session', target: 'local', phase: 'on_air', revision: 1, samplesEmitted: 100, estimatedTotalSamples: 1000 }; rerender();
    expect(result.current.txActive).toBe(true);
    mocks.txStatus = { ...mocks.txStatus, phase: 'error', errorCode: 'IMAGE_TX_PLAYBACK_FAILED' }; rerender();
    expect(result.current.isBusy).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith({ title: 'txPlaybackFailed', color: 'danger' });
    rerender();
    expect(mocks.toast).toHaveBeenCalledOnce();
  });
});
