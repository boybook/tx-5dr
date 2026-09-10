// @vitest-environment jsdom
import { StrictMode, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HeroUIProvider } from '@heroui/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RadioConnectionStatus, RadioProfileSchema, type CapabilityDescriptor } from '@tx5dr/contracts';
import { CapabilityEnvironmentProvider } from '../CapabilityEnvironment';
import { RadioQuickControls } from '../RadioQuickControls';
import { RadioControlPanel } from '../../components/radio/control/RadioControlPanel';
import { QUICK_CONTROLS_STORAGE_KEY } from '../quick-control-preferences';
import { CapabilityDescriptorsContext, CapabilityStatesContext, ConnectionContext, ProfilesContext, PTTContext, RadioConnectionContext } from '../../store/radio/contexts';
import { useRadioConnectionState } from '../../store/radio/hooks';
import { initialConnectionState, initialRadioState, radioReducer } from '../../store/radio/reducers';
import type { RadioAction, RadioState } from '../../store/radio/types';
import type { RadioService } from '../../services/radioService';
import radioText from '../../i18n/locales/zh/radio.json';

vi.mock('../../store/authStore', () => ({ useCan: () => true, useHasMinRole: () => true }));
vi.mock('@tx5dr/core', async importOriginal => ({
  ...await importOriginal<object>(),
  api: { getRadioPowerSupport: vi.fn().mockResolvedValue({ canPowerOn: false, canPowerOff: false, supportedStates: [] }) },
}));
const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'zh', resources: { zh: { radio: radioText } }, interpolation: { escapeValue: false } });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockImplementation(query => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }));
});
afterEach(cleanup);

const descriptor: CapabilityDescriptor = {
  id: 'af_gain', category: 'audio', valueType: 'number', readable: true, writable: true,
  range: { min: 0, max: 1, step: 0.01 }, display: { mode: 'percent' }, updateMode: 'event',
  labelI18nKey: 'radio:capability.af_gain.label', hasSurfaceControl: false, sessionId: 'session-a',
};

function Views() {
  const { radioConnected } = useRadioConnectionState();
  const [open, setOpen] = useState(false);
  return <>
    <output data-testid="radio-connected">{String(radioConnected)}</output>
    <RadioQuickControls active={!open} onOpenPanel={radioConnected ? () => setOpen(true) : undefined} />
    <RadioControlPanel isOpen={open && radioConnected} onClose={() => setOpen(false)} />
  </>;
}

/** The real contexts and reducer supply both views; the edit environment is not mocked. */
function Host({ state, service }: { state: RadioState; service: RadioService }) {
  return <StrictMode><I18nextProvider i18n={i18n}><HeroUIProvider disableAnimation>
    <ConnectionContext.Provider value={{ state: { ...initialConnectionState, isConnected: true, radioService: service }, dispatch: () => {} }}>
      <ProfilesContext.Provider value={state}>
        <RadioConnectionContext.Provider value={state}>
          <PTTContext.Provider value={state}>
            <CapabilityDescriptorsContext.Provider value={state.capabilityDescriptors}>
              <CapabilityStatesContext.Provider value={state.capabilityStates}>
                <CapabilityEnvironmentProvider><Views /></CapabilityEnvironmentProvider>
              </CapabilityStatesContext.Provider>
            </CapabilityDescriptorsContext.Provider>
          </PTTContext.Provider>
        </RadioConnectionContext.Provider>
      </ProfilesContext.Provider>
    </ConnectionContext.Provider>
  </HeroUIProvider></I18nextProvider></StrictMode>;
}

describe('capability views after initial Profile synchronization', () => {
  it.each(['tci', 'network', 'icom-wlan'])('uses the existing %s snapshot when REST Profiles arrive after WS capabilities', async type => {
    const profile = RadioProfileSchema.parse({ id: 'hydration-profile', name: 'Mock radio', radio: { type }, audio: {}, audioLockedToRadio: false, createdAt: 1, updatedAt: 1 });
    window.localStorage.setItem(QUICK_CONTROLS_STORAGE_KEY, JSON.stringify({ version: 1, profiles: { [profile.id]: [{ kind: 'capability', id: descriptor.id }] } }));
    const client = { send: vi.fn(), onRawMessage: vi.fn(), off: vi.fn(), onWSEvent: vi.fn(), offWSEvent: vi.fn() };
    const service = { wsClientInstance: client } as unknown as RadioService;
    let state = initialRadioState;
    const { rerender } = render(<Host state={state} service={service} />);
    const receive = (action: RadioAction) => {
      state = radioReducer(state, action);
      rerender(<Host state={state} service={service} />);
    };
    receive({ type: 'radioStatusUpdate', payload: { radioConnected: true, status: RadioConnectionStatus.CONNECTED, radioInfo: null, radioConfig: profile.radio } });
    receive({ type: 'setCapabilityList', payload: { descriptors: [descriptor], capabilities: [{ id: descriptor.id, value: 0.25, supported: true, updatedAt: 1 }] } });
    expect(screen.getByTestId('radio-connected').textContent).toBe('true');
    const snapshot = state.capabilityDescriptors;

    receive({ type: 'setProfiles', payload: { activeProfileId: profile.id, profiles: [profile] } });
    expect(state.capabilityDescriptors).toBe(snapshot);
    const quickControls = screen.getByRole('group', { name: radioText.capability.quick.title });
    expect((within(quickControls).getByRole('slider') as HTMLInputElement).disabled).toBe(false);
    expect((within(quickControls).getByRole('slider') as HTMLInputElement).value).toBe('0.25');

    fireEvent.click(screen.getByRole('button', { name: radioText.control.openRadioControl }));
    await waitFor(() => expect(screen.queryByText(radioText.capability.panel.notConnected)).toBeNull());
    const input = await screen.findByRole('spinbutton', { name: radioText.capability.af_gain.label });
    expect((input as HTMLInputElement).disabled).toBe(false);
    expect((input as HTMLInputElement).value).toBe('25');
    receive({ type: 'updateCapabilityState', payload: { id: descriptor.id, supported: true, value: 0.4, updatedAt: 2 } });
    expect((input as HTMLInputElement).value).toBe('40');
    expect(state.capabilityDescriptors).toBe(snapshot);
    expect(client.send).not.toHaveBeenCalled();
  });
});
