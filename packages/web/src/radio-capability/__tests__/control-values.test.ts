import { describe, expect, it } from 'vitest';
import type { CapabilityDescriptor } from '@tx5dr/contracts';
import { formatCapabilityNumber, fromDisplayNumber, toDisplayNumber, toDisplayStep } from '../display-utils';
import { buildCapabilityGroupPayload } from '../group-values';
import { getPanelComponent } from '../CapabilityRegistry';

const base: CapabilityDescriptor = { id: 'af_gain', category: 'audio', valueType: 'number', readable: true, writable: true,
  updateMode: 'event', labelI18nKey: 'radio:capability.af_gain.label', hasSurfaceControl: false };

describe('native capability display', () => {
  it('round-trips dB through the existing normalized AF value', () => {
    const descriptor: CapabilityDescriptor = { ...base, display: { mode: 'value', unit: 'dB', transform: { scale: 60, offset: -60 } } };
    expect(toDisplayNumber(0.8, descriptor)).toBe(-12);
    expect(fromDisplayNumber(-30, descriptor)).toBe(0.5);
    expect(formatCapabilityNumber(0, descriptor)).toBe('-60 dB');
    expect(toDisplayStep(1 / 60, descriptor)).toBeCloseTo(1);
  });
  it('handles inverted balance and preserves frequency display conversion', () => {
    const balance: CapabilityDescriptor = { ...base, display: { mode: 'value', transform: { scale: -80, offset: 40 } } };
    expect(fromDisplayNumber(-40, balance)).toBe(1);
    expect(toDisplayStep(1 / 80, balance)).toBeCloseTo(1);
    const frequency: CapabilityDescriptor = { ...base, display: { mode: 'value', unit: 'kHz' } };
    expect(toDisplayNumber(48000, frequency)).toBe(48);
    expect(fromDisplayNumber(48, frequency)).toBe(48000);
    expect(toDisplayStep(1000, frequency)).toBe(1);
  });
  it('renders new capabilities by declared value type without a vendor registration', () => {
    expect(getPanelComponent('future_host_number', base)).toBeDefined();
    expect(getPanelComponent('future_host_action', { ...base, valueType: 'action' })).toBeDefined();
  });
});

describe('atomic capability groups', () => {
  const descriptors: CapabilityDescriptor[] = ['rx_filter_low', 'rx_filter_high'].map((id) => ({ ...base, id,
    sessionId: 'session-1', target: { scope: 'receiver', receiver: 0 },
    writeGroup: { id: 'rx_filter_band', members: ['rx_filter_low', 'rx_filter_high'] } }));
  it('submits both signed edges and a session identity without a writable target', () => {
    expect(buildCapabilityGroupPayload(descriptors, { rx_filter_low: -3000, rx_filter_high: -50 })).toEqual({
      groupId: 'rx_filter_band', sessionId: 'session-1', values: { rx_filter_low: -3000, rx_filter_high: -50 },
    });
  });
  it('rejects partial values, mixed sessions and mixed targets', () => {
    expect(() => buildCapabilityGroupPayload(descriptors, { rx_filter_low: 30 })).toThrow(/Incomplete/);
    expect(() => buildCapabilityGroupPayload(descriptors, { rx_filter_low: NaN, rx_filter_high: 3000 })).toThrow();
    expect(() => buildCapabilityGroupPayload([descriptors[0], { ...descriptors[1], sessionId: 'session-2' }], {})).toThrow(/Inconsistent/);
    expect(() => buildCapabilityGroupPayload([descriptors[0], { ...descriptors[1], target: { scope: 'receiver', receiver: 1 } }], {})).toThrow(/targets/);
  });
});
