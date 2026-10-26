// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AudioDevice, AudioDeviceResolutionSet } from '@tx5dr/contracts';
import { AudioDeviceSettings } from '../AudioDeviceSettings';

const mocks = vi.hoisted(() => ({ getAudioDevices: vi.fn(), resolveAudioSettings: vi.fn() }));
vi.mock('@tx5dr/core', () => ({ api: mocks }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockImplementation(query => ({
    matches: false, media: query, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
  }));
});
afterEach(cleanup);

const codec: AudioDevice = {
  id: 'output-7', name: 'USB Audio CODEC', isDefault: false,
  channels: 2, sampleRate: 48000, type: 'output',
};

function renderSettings(devices: AudioDevice[], effectiveDevice: AudioDevice | null) {
  const deviceResolution: AudioDeviceResolutionSet = {
    input: { configuredDeviceName: null, configuredDevice: null, effectiveDevice: null, status: 'default' },
    output: {
      configuredDeviceName: codec.name, configuredDeviceId: 'output-3',
      configuredDevice: effectiveDevice, effectiveDevice,
      status: effectiveDevice ? 'selected' : 'missing',
    },
  };
  mocks.getAudioDevices.mockResolvedValue({ inputDevices: [], outputDevices: devices });
  mocks.resolveAudioSettings.mockResolvedValue({ deviceResolution });
  return render(<AudioDeviceSettings initialConfig={{ outputDeviceName: codec.name, outputDeviceId: 'output-3' }} />);
}

async function expectOutputLabel(container: HTMLElement, text: string) {
  await waitFor(() => {
    const trigger = container.querySelector('button[aria-label="audio.selectOutput"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.querySelector('[data-slot="value"]')?.textContent).toBe(text);
  });
}

describe('audio device selector rendering', () => {
  it('shows the resolved endpoint after its numeric device ID changes', async () => {
    const { container } = renderSettings([codec], codec);
    await expectOutputLabel(container, codec.name);
  });

  it('shows USB audio instead of HDMI when a saved numeric ID is reassigned', async () => {
    const { container } = renderSettings([codec, { ...codec, id: 'output-3', name: 'HDMI' }], codec);
    await expectOutputLabel(container, codec.name);
  });

  it('keeps a disconnected saved endpoint visible as unavailable', async () => {
    const { container } = renderSettings([], null);
    await expectOutputLabel(container, `${codec.name} (audio.deviceUnavailableShort)`);
  });
});
