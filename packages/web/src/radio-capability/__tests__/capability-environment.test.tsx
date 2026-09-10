// @vitest-environment jsdom
import { StrictMode, type ReactNode } from 'react';
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityDescriptor } from '@tx5dr/contracts';
import { CapabilityEnvironmentProvider, useCapabilityEnvironment } from '../CapabilityEnvironment';

const mocks = vi.hoisted(() => ({
  send: vi.fn(), profile: 'profile-a' as string | null, connected: true, socketConnected: true, canControl: true, admin: true, transmitting: false,
  descriptors: new Map<string, CapabilityDescriptor>(), client: {} as { send: ReturnType<typeof vi.fn>; onRawMessage: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> },
}));
vi.mock('../../store/radio/hooks', () => ({
  useConnection: () => ({ state: { isConnected: mocks.socketConnected, radioService: { wsClientInstance: mocks.client } } }),
  useProfiles: () => ({ activeProfileId: mocks.profile }),
  useRadioConnectionState: () => ({ radioConnected: mocks.connected, radioConfig: { type: 'tci', receiver: 0 } }),
  useCapabilityDescriptors: () => mocks.descriptors,
  usePTTState: () => ({ pttStatus: { isTransmitting: mocks.transmitting }, tuneToneStatus: { active: false } }),
}));
vi.mock('../../store/authStore', () => ({ useCan: () => mocks.canControl, useHasMinRole: () => mocks.admin }));
const descriptor: CapabilityDescriptor = { id: 'nb', category: 'rf', valueType: 'boolean', readable: true, writable: true,
  updateMode: 'event', labelI18nKey: 'nb', hasSurfaceControl: false, sessionId: 'session-a', target: { scope: 'receiver', receiver: 0 } };
beforeEach(() => {
  mocks.profile = 'profile-a'; mocks.connected = true; mocks.socketConnected = true; mocks.canControl = true; mocks.admin = true; mocks.transmitting = false;
  mocks.client = { send: mocks.send, onRawMessage: vi.fn(), off: vi.fn() }; mocks.descriptors = new Map([[descriptor.id, descriptor]]); mocks.send.mockReset();
});
afterEach(cleanup);

describe('capability UI connection lifetime', () => {
  describe.each([false, true])('initial synchronization (StrictMode: %s)', strict => {
    it.each(['capabilities-first', 'profile-first', 'together'])('accepts the initial Profile with %s arrival', order => {
      mocks.profile = null; mocks.connected = false; mocks.socketConnected = false; mocks.descriptors = new Map();
      const wrapper = ({ children }: { children: ReactNode }) => {
        const provider = <CapabilityEnvironmentProvider>{children}</CapabilityEnvironmentProvider>;
        return strict ? <StrictMode>{provider}</StrictMode> : provider;
      };
      const { result, rerender } = renderHook(useCapabilityEnvironment, { wrapper });
      const beforeSync = result.current.write;
      expect(result.current.connected).toBe(false);
      mocks.connected = true; mocks.socketConnected = true; rerender();
      const snapshot = new Map([[descriptor.id, descriptor]]);
      if (order === 'capabilities-first') {
        mocks.descriptors = snapshot; rerender();
        expect(result.current.connected).toBe(false);
      } else if (order === 'profile-first') {
        mocks.profile = 'profile-a'; rerender();
      }
      mocks.profile = 'profile-a'; mocks.descriptors = snapshot; rerender();
      expect(result.current.connected).toBe(true);
      // Incremental value broadcasts do not resend or replace the descriptor list.
      rerender(); expect(result.current.connected).toBe(true);
      beforeSync(descriptor, true); expect(mocks.send).not.toHaveBeenCalled();
      result.current.write(descriptor, true);
      expect(mocks.send).toHaveBeenCalledOnce();
      expect(mocks.send).toHaveBeenCalledWith('writeRadioCapability', { id: 'nb', value: true, action: undefined, sessionId: 'session-a' }, expect.any(String));
    });
  });
  it('does no I/O on mount and carries the captured descriptor session on write', () => {
    const { result } = renderHook(useCapabilityEnvironment, { wrapper: CapabilityEnvironmentProvider });
    expect(mocks.send).not.toHaveBeenCalled();
    result.current.write(descriptor, true);
    expect(mocks.send).toHaveBeenCalledWith('writeRadioCapability', { id: 'nb', value: true, action: undefined, sessionId: 'session-a' }, expect.any(String));
  });
  it('rejects old callbacks after disconnect/reconnect', () => {
    const { result, rerender } = renderHook(useCapabilityEnvironment, { wrapper: CapabilityEnvironmentProvider });
    const oldWrite = result.current.write;
    mocks.connected = false; rerender(); oldWrite(descriptor, true);
    mocks.connected = true; rerender(); oldWrite(descriptor, true);
    expect(mocks.send).not.toHaveBeenCalled();
    result.current.write(descriptor, true); expect(mocks.send).toHaveBeenCalledOnce();
  });
  it('waits for new profile descriptors instead of binding the old radio to the new profile', () => {
    const { result, rerender } = renderHook(useCapabilityEnvironment, { wrapper: CapabilityEnvironmentProvider });
    const oldWrite = result.current.write;
    mocks.profile = 'profile-b'; rerender(); expect(result.current.connected).toBe(false);
    result.current.write(descriptor, true); oldWrite(descriptor, true); expect(mocks.send).not.toHaveBeenCalled();
    const next = { ...descriptor, sessionId: 'session-b' }; mocks.descriptors = new Map([[next.id, next]]); rerender();
    expect(result.current.connected).toBe(true); oldWrite(descriptor, true); result.current.write(descriptor, true); expect(mocks.send).not.toHaveBeenCalled();
    result.current.write(next, false); expect(mocks.send).toHaveBeenCalledOnce();
  });
  it('does not treat a cleared Profile during a later switch as initial synchronization', () => {
    const { result, rerender } = renderHook(useCapabilityEnvironment, { wrapper: CapabilityEnvironmentProvider });
    const oldWrite = result.current.write;
    mocks.profile = null; rerender();
    mocks.profile = 'profile-b'; rerender();
    expect(result.current.connected).toBe(false);
    result.current.write(descriptor, true); oldWrite(descriptor, true);
    expect(mocks.send).not.toHaveBeenCalled();
    const next = { ...descriptor, sessionId: 'session-b' };
    mocks.descriptors = new Map([[next.id, next]]); rerender();
    expect(result.current.connected).toBe(true);
    result.current.write(next, false); expect(mocks.send).toHaveBeenCalledOnce();
  });
  it('rejects a stale target even without a server session ID', () => {
    const legacy = { ...descriptor, sessionId: undefined }; mocks.descriptors = new Map([[legacy.id, legacy]]);
    const { result, rerender } = renderHook(useCapabilityEnvironment, { wrapper: CapabilityEnvironmentProvider });
    const oldWrite = result.current.write;
    mocks.descriptors = new Map([[legacy.id, { ...legacy, target: { scope: 'receiver', receiver: 1 } }]]); rerender();
    oldWrite(legacy, true); expect(mocks.send).not.toHaveBeenCalled();
  });
  it('accepts a new profile and descriptor snapshot arriving in the same render', () => {
    const { result, rerender } = renderHook(useCapabilityEnvironment, { wrapper: CapabilityEnvironmentProvider });
    const next = { ...descriptor, sessionId: 'session-b' };
    mocks.profile = 'profile-b'; mocks.descriptors = new Map([[next.id, next]]); rerender();
    expect(result.current.connected).toBe(true);
    result.current.write(next, true); expect(mocks.send).toHaveBeenCalledOnce();
  });
  it('invalidates retained writers when the environment unmounts', () => {
    const { result, unmount } = renderHook(useCapabilityEnvironment, { wrapper: CapabilityEnvironmentProvider });
    const write = result.current.write; unmount(); write(descriptor, true);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each(['permission', 'idle', 'readOnly', 'group', 'iqAdmin'])('rechecks %s at dispatch time', kind => {
    const current = { ...descriptor, id: kind === 'iqAdmin' ? 'tci_iq_sample_rate' : descriptor.id,
      requiresIdle: kind === 'idle', writable: kind !== 'readOnly', writeGroup: kind === 'group' ? { id: 'g', members: ['nb'] } : undefined };
    mocks.descriptors = new Map([[current.id, current]]);
    const { result, rerender } = renderHook(useCapabilityEnvironment, { wrapper: CapabilityEnvironmentProvider });
    const write = result.current.write;
    if (kind === 'permission') mocks.canControl = false;
    if (kind === 'idle') mocks.transmitting = true;
    if (kind === 'iqAdmin') mocks.admin = false;
    rerender(); write(current, true); expect(mocks.send).not.toHaveBeenCalled();
  });
});
