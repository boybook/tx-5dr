// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HeroUIProvider } from '@heroui/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RadioConnectionStatus, RadioProfileSchema, type CapabilityDescriptor, type CapabilityState } from '@tx5dr/contracts';
import { RadioControlPanel } from '../../components/radio/control/RadioControlPanel';
import { CapabilityEnvironmentContext, type CapabilityEnvironment } from '../CapabilityEnvironment';
import { CapabilityDescriptorsContext, CapabilityStatesContext, ConnectionContext, ProfilesContext, RadioConnectionContext } from '../../store/radio/contexts';
import { initialConnectionState } from '../../store/radio/reducers';
import type { RadioService } from '../../services/radioService';
import radio from '../../i18n/locales/zh/radio.json';

vi.mock('../../components/radio/profile/PowerControlButton', () => ({ PowerControlButton: () => null }));
const mock = vi.hoisted(() => ({ group: vi.fn() }));
vi.mock('@tx5dr/core', async importOriginal => ({ ...await importOriginal<object>(), api: { writeRadioCapabilityGroup: mock.group } }));
const i18n = createInstance();
let mobile = true;
beforeAll(async () => {
  await i18n.init({ lng: 'zh', resources: { zh: { radio } }, interpolation: { escapeValue: false } });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&') });
  window.matchMedia = vi.fn().mockImplementation(query => ({ matches: mobile && query === '(max-width: 767px)', media: query,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }));
});
beforeEach(() => { mobile = true; mock.group.mockReset(); });
afterEach(cleanup);

const power: CapabilityDescriptor = { id: 'rf_power', category: 'rf', valueType: 'number', readable: true, writable: true,
  range: { min: 0, max: 1, step: 0.01 }, display: { mode: 'percent' }, updateMode: 'event',
  labelI18nKey: 'radio:capability.rf_power.label', descriptionI18nKey: 'radio:capability.rf_power.description',
  hasSurfaceControl: false, sessionId: 'session-a', target: { scope: 'trx', trx: 0 } };
const volume: CapabilityDescriptor = { ...power, id: 'af_gain', category: 'audio', labelI18nKey: 'radio:capability.af_gain.label', descriptionI18nKey: 'radio:capability.af_gain.description' };
const nr: CapabilityDescriptor = { ...power, id: 'nr', valueType: 'boolean', labelI18nKey: 'radio:capability.nr.label', descriptionI18nKey: 'radio:capability.nr.description' };
const permitted: CapabilityDescriptor = { ...power, id: 'tx_permitted', category: 'system', valueType: 'boolean', writable: false,
  labelI18nKey: 'radio:capability.tx_permitted.label', descriptionI18nKey: 'radio:capability.tx_permitted.description', target: { scope: 'global' } };
const band = ['rx_filter_low', 'rx_filter_high'].map(id => ({ ...power, id, category: 'operation' as const, range: { min: -12000, max: 12000, step: 1 },
  display: { mode: 'value' as const, unit: 'Hz' as const, signed: true }, labelI18nKey: `radio:capability.${id}.label`, descriptionI18nKey: `radio:capability.${id}.description`,
  compoundGroup: 'rx_filter_band', writeGroup: { id: 'rx_filter_band', members: ['rx_filter_low', 'rx_filter_high'] } }));
const catalog = new Map([power, nr, volume, ...band, permitted].map(d => [d.id, d]));
const values = new Map<string, CapabilityState>([['rf_power', 0.3], ['nr', true], ['af_gain', 0.5], ['rx_filter_low', 100], ['rx_filter_high', 3000], ['tx_permitted', true]]
  .map(([id, value]) => [String(id), { id: String(id), value: value as number | boolean, supported: true, availability: 'available', updatedAt: 1 }]));
const profile = RadioProfileSchema.parse({ id: 'mobile-panel', name: 'Mock RX1', radio: { type: 'tci' }, audio: {}, audioLockedToRadio: false, createdAt: 1, updatedAt: 1 });
const client = { send: vi.fn(), onWSEvent: vi.fn(), offWSEvent: vi.fn() };
const service = { wsClientInstance: client } as unknown as RadioService;
function environment(overrides: Partial<CapabilityEnvironment> = {}): CapabilityEnvironment {
  return { profileId: profile.id, scope: 'a', connected: true, canControl: true, isAdmin: true, transmitting: false, write: vi.fn(), ...overrides };
}
function Host({ env, descriptors = catalog, states = values }: { env: CapabilityEnvironment; descriptors?: Map<string, CapabilityDescriptor>; states?: Map<string, CapabilityState> }) {
  return <I18nextProvider i18n={i18n}><HeroUIProvider disableAnimation>
    <ConnectionContext.Provider value={{ state: { ...initialConnectionState, isConnected: true, radioService: service }, dispatch() {} }}>
      <ProfilesContext.Provider value={{ profiles: [profile], activeProfileId: profile.id, profilesLoaded: true, hasConfiguredProfiles: true }}>
        <RadioConnectionContext.Provider value={{ radioConnected: true, radioConnectionStatus: RadioConnectionStatus.CONNECTED, radioConfig: { type: 'tci' }, radioInfo: null,
          reconnectProgress: null, radioConnectionHealth: null, coreCapabilities: null, coreCapabilityDiagnostics: null, fakeFrequencyEffective: false }}>
          <CapabilityDescriptorsContext.Provider value={descriptors}><CapabilityStatesContext.Provider value={states}>
            <CapabilityEnvironmentContext.Provider value={env}><RadioControlPanel isOpen onClose={() => {}} /></CapabilityEnvironmentContext.Provider>
          </CapabilityStatesContext.Provider></CapabilityDescriptorsContext.Provider>
        </RadioConnectionContext.Provider>
      </ProfilesContext.Provider>
    </ConnectionContext.Provider>
  </HeroUIProvider></I18nextProvider>;
}

describe('mobile capability panel', () => {
  it('keeps help collapsed and opens it without changing the parameter', async () => {
    const env = environment(); render(<Host env={env} />);
    expect(screen.queryByText(radio.capability.rf_power.description)).toBeNull();
    expect(screen.queryByRole('spinbutton', { name: radio.capability.af_gain.label })).toBeNull();
    const help = screen.getByRole('button', { name: i18n.t('radio:capability.panel.describe', { name: radio.capability.rf_power.label }) });
    await userEvent.click(help);
    expect(help.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('region', { name: i18n.t('radio:capability.panel.descriptionOf', { name: radio.capability.rf_power.label }) }).textContent).toContain(radio.capability.rf_power.description);
    await userEvent.click(help);
    expect(screen.queryByRole('region', { name: i18n.t('radio:capability.panel.descriptionOf', { name: radio.capability.rf_power.label }) })).toBeNull();
    expect(env.write).not.toHaveBeenCalled();
  });
  it('cancels a pending text edit before pointer navigation changes category', async () => {
    const user = userEvent.setup(); const env = environment(); render(<Host env={env} />);
    const input = screen.getByRole('spinbutton', { name: radio.capability.rf_power.label });
    await user.clear(input); await user.type(input, '75');
    await user.click(screen.getByRole('tab', { name: radio.capability.panel.audio }));
    expect(env.write).not.toHaveBeenCalled();
    expect(screen.getByRole('spinbutton', { name: radio.capability.af_gain.label })).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: radio.capability.panel.rf }));
    expect((screen.getByRole('spinbutton', { name: radio.capability.rf_power.label }) as HTMLInputElement).value).toBe('30');
  });
  it('cancels rather than committing when keyboard focus leaves an input for navigation', () => {
    const env = environment(); render(<Host env={env} />);
    const input = screen.getByRole('spinbutton', { name: radio.capability.rf_power.label });
    fireEvent.change(input, { target: { value: '75' } });
    fireEvent.blur(input, { relatedTarget: screen.getByRole('tab', { name: radio.capability.panel.audio }) });
    expect(env.write).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe('30');
  });
  it('pins a control without applying a pending input draft', async () => {
    const user = userEvent.setup(); const env = environment(); render(<Host env={env} />);
    const input = screen.getByRole('spinbutton', { name: radio.capability.rf_power.label });
    await user.clear(input); await user.type(input, '75');
    await user.click(screen.getByRole('button', { name: `${radio.capability.quick.pin} · ${radio.capability.rf_power.label}` }));
    expect(env.write).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe('30');
    expect(screen.getByRole('button', { name: `${radio.capability.quick.unpin} · ${radio.capability.rf_power.label}` })).toBeTruthy();
  });
  it.each(['permission', 'busy', 'unknown'] as const)('shows the %s restriction outside the collapsed help', kind => {
    const env = environment({ canControl: kind !== 'permission', transmitting: kind === 'busy' });
    const descriptors = new Map(catalog).set(power.id, { ...power, requiresIdle: true });
    const states = new Map(values);
    if (kind === 'unknown') states.set(power.id, { ...values.get(power.id)!, value: null, availability: 'unknown' });
    render(<Host env={env} descriptors={descriptors} states={states} />);
    const reason = kind === 'permission' ? radio.capability.quick.noPermission : kind === 'busy' ? radio.capability.panel.unavailableBusy : radio.capability.panel.unknownState;
    expect(screen.getAllByRole('status').some(status => status.textContent === reason)).toBe(true);
    expect(env.write).not.toHaveBeenCalled();
  });
  it('shows a rejected write without requiring hover and restores the actual value', async () => {
    const user = userEvent.setup(); const write = vi.fn().mockResolvedValue({ outcome: 'failed', error: 'Rejected setting' });
    render(<Host env={environment({ write })} />);
    const input = screen.getByRole('spinbutton', { name: radio.capability.rf_power.label });
    await user.clear(input); await user.type(input, '75'); await user.keyboard('{Enter}');
    expect(await screen.findByText('Rejected setting')).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe('30');
    expect(write).toHaveBeenCalledOnce();
  });
  it('searches descriptions and abbreviations across categories without radio queries', async () => {
    const env = environment(); client.send.mockClear(); render(<Host env={env} />);
    await userEvent.click(screen.getByRole('button', { name: radio.capability.panel.search }));
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: radio.capability.af_gain.description } });
    expect(screen.getByRole('spinbutton', { name: radio.capability.af_gain.label })).toBeTruthy();
    expect(screen.queryByRole('spinbutton', { name: radio.capability.rf_power.label })).toBeNull();
    fireEvent.change(search, { target: { value: 'NR' } });
    expect(screen.getByRole('button', { name: radio.capability.nr.label })).toBeTruthy();
    fireEvent.change(search, { target: { value: 'not-a-control' } });
    expect(screen.getByText(radio.capability.panel.noResults)).toBeTruthy();
    expect(client.send).not.toHaveBeenCalled(); expect(env.write).not.toHaveBeenCalled();
  });
  it('keeps atomic fields together, cancels their drafts on navigation and submits once', async () => {
    const env = environment(); mock.group.mockResolvedValue({ success: true }); render(<Host env={env} />);
    await userEvent.click(screen.getByRole('tab', { name: radio.capability.panel.operation }));
    const low = () => screen.getByRole('spinbutton', { name: radio.capability.rx_filter_low.label });
    expect((low() as HTMLInputElement).value).toBe('100');
    fireEvent.change(low(), { target: { value: '200' } });
    await userEvent.click(screen.getByRole('tab', { name: radio.capability.panel.audio }));
    await userEvent.click(screen.getByRole('tab', { name: radio.capability.panel.operation }));
    expect((low() as HTMLInputElement).value).toBe('100');
    expect(mock.group).not.toHaveBeenCalled();
    fireEvent.change(low(), { target: { value: '250' } });
    await userEvent.click(screen.getByRole('button', { name: radio.capability.quick.apply }));
    expect(mock.group).toHaveBeenCalledOnce();
    expect(mock.group.mock.calls[0][0].values).toEqual({ rx_filter_low: 250, rx_filter_high: 3000 });
    expect(env.write).not.toHaveBeenCalled();
  });
  it('shows global scope and read-only feedback even while help is collapsed', async () => {
    render(<Host env={environment()} />);
    await userEvent.click(screen.getByRole('tab', { name: radio.capability.panel.system }));
    expect(screen.getByText(radio.capability.panel.targetGlobalShort)).toBeTruthy();
    expect(screen.getByText(radio.capability.quick.readOnly)).toBeTruthy();
    expect(screen.queryByRole('button', { name: radio.capability.tx_permitted.label })).toBeNull();
  });
  it('resets search and category when a new connection session arrives', async () => {
    const env = environment(); const { rerender } = render(<Host env={env} />);
    await userEvent.click(screen.getByRole('button', { name: radio.capability.panel.search }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: radio.capability.af_gain.description } });
    rerender(<Host env={{ ...env, scope: 'b' }} />);
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.getByRole('spinbutton', { name: radio.capability.rf_power.label })).toBeTruthy();
    expect(env.write).not.toHaveBeenCalled();
  });
  it('falls back to a visible category when a capability disappears', async () => {
    const env = environment(); const { rerender } = render(<Host env={env} />);
    await userEvent.click(screen.getByRole('tab', { name: radio.capability.panel.audio }));
    const reduced = new Map(catalog); reduced.delete(volume.id);
    rerender(<Host env={env} descriptors={reduced} />);
    expect(screen.queryByRole('tab', { name: radio.capability.panel.audio })).toBeNull();
    expect(screen.getByRole('spinbutton', { name: radio.capability.rf_power.label })).toBeTruthy();
  });
  it('keeps desktop categories and full explanations visible', () => {
    mobile = false; render(<Host env={environment()} />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByText(radio.capability.rf_power.description, { exact: false })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: radio.capability.af_gain.label })).toBeTruthy();
  });
});
