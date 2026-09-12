// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CWDecoderProvider, useCWDecoder, useCWDecoderTuning } from '../useCWDecoder';

const mocks = vi.hoisted(() => ({ service: null as unknown }));
vi.mock('../../store/radioStore', () => ({ useConnection: () => ({ state: { radioService: mocks.service } }) }));
vi.mock('@tx5dr/core', () => ({ api: {} }));
afterEach(cleanup);

describe('CW decoder presentation subscriptions', () => {
  it('updates transcript readers without refreshing the spectrum tuning projection', async () => {
    const bus = new EventEmitter();
    mocks.service = { wsClientInstance: { onWSEvent: bus.on.bind(bus), offWSEvent: bus.off.bind(bus) } };
    let tuningRenders = 0;
    let tuning!: ReturnType<typeof useCWDecoderTuning>;
    let transcript!: ReturnType<typeof useCWDecoder>;
    function Tuning() { tuning = useCWDecoderTuning(); tuningRenders++; return null; }
    function Transcript() { transcript = useCWDecoder(); return null; }
    const view = render(<CWDecoderProvider><Tuning /><Transcript /></CWDecoderProvider>);
    await act(async () => {});
    const before = tuningRenders;
    const timestamp = Date.now();
    for (const [index, text] of ['C', 'CQ', 'CQ TEST'].entries()) {
      act(() => bus.emit('cwDecoderEvent', { type: 'partial', text, timestamp: timestamp + index }));
    }
    expect(transcript.pendingText).toBe('CQ TEST');
    expect(tuningRenders).toBe(before);
    act(() => bus.emit('cwDecoderStatusChanged', { state: 'running', running: true, config: { targetFreqHz: 1000, filterWidthHz: 500 } }));
    expect(tuning).toMatchObject({ targetFreqHz: 1000, filterWidthHz: 500, decoderVisible: true });
    const tuned = tuningRenders;
    act(() => bus.emit('cwDecoderStatusChanged', { state: 'running', running: true, pendingText: 'CQ MORE', config: { targetFreqHz: 1000, filterWidthHz: 500 } }));
    expect(tuningRenders).toBe(tuned);
    view.unmount();
    expect(bus.eventNames()).toEqual([]);
  });
});
