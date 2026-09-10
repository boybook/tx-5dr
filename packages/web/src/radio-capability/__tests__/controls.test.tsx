// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HeroUIProvider } from '@heroui/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CapabilityDescriptor, CapabilityState } from '@tx5dr/contracts';
import { CapabilityControl } from '../CapabilityRegistry';
import { CapabilityEnvironmentContext, type CapabilityEnvironment } from '../CapabilityEnvironment';
import { CapabilityGroupControl } from '../components/CapabilityGroup';
import { CapabilityStatesContext } from '../../store/radio/contexts';
import { registerCapabilityComponent } from '../CapabilityRegistry';
import { TunerCapabilityControl } from '../components/TunerCapability';
import radio from '../../i18n/locales/zh/radio.json';

const mocks = vi.hoisted(() => ({ writeGroup: vi.fn() }));
vi.mock('@tx5dr/core', async importOriginal => ({ ...await importOriginal<object>(), api: { writeRadioCapabilityGroup: mocks.writeGroup } }));
const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'zh', resources: { zh: { radio } }, interpolation: { escapeValue: false } });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockImplementation(query => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }));
});
afterEach(() => { cleanup(); mocks.writeGroup.mockReset(); });

const base: CapabilityDescriptor = { id: 'af_gain', category: 'audio', valueType: 'number', readable: true, writable: true,
  range: { min: 0, max: 1, step: 0.01 }, display: { mode: 'percent' }, updateMode: 'event', labelI18nKey: 'radio:capability.af_gain.label', hasSurfaceControl: false, sessionId: 'session-1' };
const actual = (id: string, value: CapabilityState['value']): CapabilityState => ({ id, value, supported: true, availability: 'available', updatedAt: 1 });
function env(overrides: Partial<CapabilityEnvironment> = {}): CapabilityEnvironment {
  return { connected: true, canControl: true, isAdmin: true, transmitting: false, profileId: 'p', scope: 'p:1', write: vi.fn(), ...overrides };
}
function Host({ children, environment, states = new Map() }: { children: ReactNode; environment: CapabilityEnvironment; states?: Map<string, CapabilityState> }) {
  return <I18nextProvider i18n={i18n}><HeroUIProvider disableAnimation><CapabilityEnvironmentContext.Provider value={environment}>
    <CapabilityStatesContext.Provider value={states}><div className="radio-capability-controls">{children}</div></CapabilityStatesContext.Provider>
  </CapabilityEnvironmentContext.Provider></HeroUIProvider></I18nextProvider>;
}

describe('shared HeroUI capability controls', () => {
  it('shows the quick slider value only in its hover or keyboard tooltip', async () => {
    const user = userEvent.setup(); const environment = env();
    render(<Host environment={environment}><CapabilityControl descriptor={base} state={actual(base.id, 0)} showSliderInput={false} /></Host>);
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByText('0%')).toBeNull();
    const slider = screen.getByRole('slider');
    await user.hover(slider.closest('.cap-slider')!);
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe('0%'));
    expect(environment.write).not.toHaveBeenCalled();
    await user.unhover(slider.closest('.cap-slider')!);
    act(() => slider.focus());
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(environment.write).toHaveBeenCalledWith(base, 0.01, undefined));
    expect(environment.write).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe('1%'));
  });
  it.each(['unbounded', 'group-draft'])('keeps the input for %s controls in the quick presentation', kind => {
    const environment = env();
    const descriptor = kind === 'unbounded' ? { ...base, range: undefined } : base;
    const draftEditor = kind === 'group-draft' ? { text: '20', onChange: vi.fn() } : undefined;
    render(<Host environment={environment}><CapabilityControl descriptor={descriptor} state={actual(base.id, 0.2)}
      showSliderInput={false} draftEditor={draftEditor} /></Host>);
    expect(screen.getByRole('spinbutton')).toBeTruthy();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(environment.write).not.toHaveBeenCalled();
  });
  it('submits an input once on Enter then blur and keeps its proposal until confirmation', async () => {
    const user = userEvent.setup(); const environment = env();
    render(<Host environment={environment}><CapabilityControl descriptor={base} state={actual(base.id, 0.2)} /></Host>);
    const input = screen.getByRole('spinbutton');
    await user.clear(input); await user.type(input, '35'); await user.keyboard('{Enter}'); await user.tab();
    expect(environment.write).toHaveBeenCalledTimes(1); expect(environment.write).toHaveBeenCalledWith(base, 0.35, undefined);
    expect((input as HTMLInputElement).value).toBe('35');
  });
  it('keeps card and quick controls synchronized without broadcast feedback writes', async () => {
    const environment = env();
    const descriptor: CapabilityDescriptor = { ...base, id: 'nb', valueType: 'boolean', labelI18nKey: 'radio:capability.nb.label' };
    const tree = (value: boolean) => <Host environment={environment}><CapabilityControl descriptor={descriptor} state={actual('nb', value)} /><CapabilityControl descriptor={descriptor} state={actual('nb', value)} /></Host>;
    const { rerender } = render(tree(false));
    fireEvent.click(screen.getAllByRole('button', { name: radio.capability.nb.label })[0]);
    expect(environment.write).toHaveBeenCalledTimes(1);
    rerender(tree(true));
    expect(screen.getAllByRole('button', { name: radio.capability.nb.label }).map(button => button.getAttribute('aria-pressed'))).toEqual(['true', 'true']);
    expect(environment.write).toHaveBeenCalledTimes(1);
  });
  it('can return to the cached value while a previous input is still being applied', async () => {
    const user = userEvent.setup();
    let finishA!: (feedback: import('../control-types').CapabilityWriteFeedback) => void;
    let finishB!: (feedback: import('../control-types').CapabilityWriteFeedback) => void;
    const write = vi.fn().mockReturnValueOnce(new Promise(resolve => { finishA = resolve; })).mockReturnValueOnce(new Promise(resolve => { finishB = resolve; }));
    render(<Host environment={env({ write })}><CapabilityControl descriptor={base} state={actual(base.id, 0.2)} /></Host>);
    const input = screen.getByRole('spinbutton');
    await user.clear(input); await user.type(input, '70'); await user.keyboard('{Enter}');
    await user.clear(input); await user.type(input, '20'); await user.keyboard('{Enter}');
    expect(write.mock.calls.map(call => call[1])).toEqual([0.7, 0.2]);
    await act(async () => finishA({ outcome: 'completed', state: { ...actual(base.id, 0.7), updatedAt: 2 } }));
    expect((input as HTMLInputElement).value).toBe('20');
    await act(async () => finishB({ outcome: 'completed', state: { ...actual(base.id, 0.2), updatedAt: 3 } }));
    expect((input as HTMLInputElement).value).toBe('20');
  });
  it('does not represent an unknown toggle as off or permit it to be toggled', () => {
    const environment = env();
    const descriptor = { ...base, id: 'nb', valueType: 'boolean' as const, labelI18nKey: 'radio:capability.nb.label' };
    render(<Host environment={environment}><CapabilityControl descriptor={descriptor} state={actual('nb', null)} /></Host>);
    const button = screen.getByRole('button', { name: radio.capability.nb.label });
    expect(button.getAttribute('aria-pressed')).toBe('mixed'); expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button); expect(environment.write).not.toHaveBeenCalled();
  });
  it.each(['permission', 'readOnly', 'busy', 'unavailable', 'inactive', 'disconnected'])('blocks writes for %s controls', kind => {
    const environment = env({ canControl: kind !== 'permission', transmitting: kind === 'busy', connected: kind !== 'disconnected' });
    const descriptor = { ...base, writable: kind !== 'readOnly', requiresIdle: kind === 'busy' };
    render(<Host environment={environment}><CapabilityControl descriptor={descriptor} active={kind !== 'inactive'}
      state={{ ...actual(base.id, 0.2), availability: kind === 'unavailable' ? 'unavailable' : 'available' }} /></Host>);
    const input = screen.queryByRole('spinbutton');
    if (kind === 'readOnly') expect(input).toBeNull(); else expect((input as HTMLInputElement).disabled).toBe(true);
    expect(environment.write).not.toHaveBeenCalled();
  });
  it('uses actual discrete values and preserves the IQ sample-rate admin restriction', () => {
    const environment = env({ isAdmin: false });
    const descriptor: CapabilityDescriptor = { ...base, id: 'tci_iq_sample_rate', valueType: 'enum', options: [{ value: 48000, label: '48 kHz' }, { value: 96000, label: '96 kHz' }] };
    const { rerender } = render(<Host environment={environment}><CapabilityControl descriptor={descriptor} state={actual(descriptor.id, 48000)} /></Host>);
    expect((screen.getByRole('button', { name: '96 kHz' }) as HTMLButtonElement).disabled).toBe(true);
    const admin = { ...environment, isAdmin: true };
    rerender(<Host environment={admin}><CapabilityControl descriptor={descriptor} state={actual(descriptor.id, 48000)} /></Host>);
    fireEvent.click(screen.getByRole('button', { name: '96 kHz' })); expect(environment.write).toHaveBeenCalledWith(descriptor, 96000, undefined);
  });
  it('preserves partial limits under an inverted display transform', () => {
    const descriptor: CapabilityDescriptor = { ...base, range: undefined, limits: { min: 0, step: 1 },
      display: { mode: 'value', unit: 'dB', transform: { scale: -1, offset: 0 } } };
    render(<Host environment={env()}><CapabilityControl descriptor={descriptor} state={actual(descriptor.id, 20)} /></Host>);
    const input = screen.getByRole('spinbutton');
    expect(input.getAttribute('min')).toBeNull(); expect(input.getAttribute('max')).toBe('0');
    expect((input as HTMLInputElement).value).toBe('-20');
  });
  it('keeps the rendered control tree idle when unrelated parent data changes', () => {
    const environment = env(); const descriptor = { ...base, id: 'render_probe' }; const state = actual(descriptor.id, 0.2);
    const rendered = vi.fn(() => <span>0.2</span>);
    registerCapabilityComponent(descriptor.id, rendered);
    function Parent({ ticks }: { ticks: number }) {
      return <Host environment={environment}><span>{ticks}</span><CapabilityControl descriptor={descriptor} state={state} /></Host>;
    }
    const { rerender } = render(<Parent ticks={0} />);
    const initialRenders = rendered.mock.calls.length;
    for (let index = 1; index <= 100; index++) rerender(<Parent ticks={index} />);
    expect(rendered).toHaveBeenCalledTimes(initialRenders); expect(environment.write).not.toHaveBeenCalled();
  });
});

describe('atomic group controls', () => {
  const descriptors = ['rx_filter_low', 'rx_filter_high'].map(id => ({ ...base, id, display: { mode: 'value' as const, unit: 'Hz' as const },
    labelI18nKey: `radio:capability.${id}.label`, range: { min: -12000, max: 12000, step: 1 }, writeGroup: { id: 'rx_filter_band', members: ['rx_filter_low', 'rx_filter_high'] } }));
  const states = new Map([['rx_filter_low', actual('rx_filter_low', -3000)], ['rx_filter_high', actual('rx_filter_high', -50)]]);
  it('does not write partial edits and only applies a valid complete group', async () => {
    const environment = env(); mocks.writeGroup.mockResolvedValue({ success: true });
    render(<Host environment={environment}><CapabilityGroupControl descriptors={descriptors} states={states} /></Host>);
    const inputs = screen.getAllByRole('spinbutton');
    fireEvent.change(inputs[0], { target: { value: '20' } });
    expect((screen.getByRole('button', { name: radio.capability.quick.apply }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(inputs[1], { target: { value: '3000' } });
    expect(mocks.writeGroup).not.toHaveBeenCalled(); expect(environment.write).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: radio.capability.quick.apply })); });
    expect(mocks.writeGroup).toHaveBeenCalledOnce();
    expect(mocks.writeGroup.mock.calls[0][0]).toEqual({ groupId: 'rx_filter_band', sessionId: 'session-1', values: { rx_filter_low: 20, rx_filter_high: 3000 } });
  });
  it('discards drafts when a session ends and ignores an old asynchronous failure', async () => {
    let reject!: (error: Error) => void;
    mocks.writeGroup.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    const environment = env();
    const { rerender } = render(<Host environment={environment}><CapabilityGroupControl descriptors={descriptors} states={states} /></Host>);
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '-2500' } });
    fireEvent.click(screen.getByRole('button', { name: radio.capability.quick.apply }));
    rerender(<Host environment={{ ...environment, scope: 'p:2' }}><CapabilityGroupControl descriptors={descriptors} states={states} /></Host>);
    await act(async () => reject(new Error('Old connection')));
    expect(screen.queryByRole('alert')).toBeNull(); expect(screen.queryByRole('button', { name: radio.capability.quick.apply })).toBeNull();
  });
});

describe('tuner behavior in shared controls', () => {
  it('requires the tuner switch before allowing its action', () => {
    registerCapabilityComponent('tuner_tune', TunerCapabilityControl);
    const descriptor: CapabilityDescriptor = { ...base, id: 'tuner_tune', valueType: 'action', labelI18nKey: 'radio:capability.tuner_tune.label' };
    const environment = env(); const tune = actual('tuner_tune', null);
    const tree = (enabled: boolean) => <Host environment={environment} states={new Map([['tuner_switch', actual('tuner_switch', enabled)], ['tuner_tune', tune]])}>
      <CapabilityControl descriptor={descriptor} state={tune} /></Host>;
    const { rerender } = render(tree(false));
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    rerender(tree(true)); fireEvent.click(screen.getByRole('button'));
    expect(environment.write).toHaveBeenCalledWith(descriptor, undefined, true);
  });
});
