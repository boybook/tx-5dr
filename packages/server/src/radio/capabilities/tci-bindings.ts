import type { CapabilityCategory, CapabilityDescriptor, CapabilityState, CapabilityValue } from '@tx5dr/contracts';
import { controlKey, type TciClient, type TciControlDescriptor, type TciControlId,
  type TciControlState, type TciControlTarget, type TciControlValue } from 'tci-client-node';
import type { CapabilityDefinition, RadioCapabilityBindings } from './types.js';

interface Mapping {
  control: TciControlId;
  id: string;
  category: CapabilityCategory;
  normalized?: boolean;
  nativeId?: string;
  globalOnly?: boolean;
  readOnly?: boolean;
  field?: string;
  group?: string;
}

const mappings: Mapping[] = [
  { control: 'drive', id: 'rf_power', category: 'rf', normalized: true },
  { control: 'tune_drive', id: 'tune_power', category: 'rf', normalized: true },
  { control: 'modulation', id: 'radio_mode', category: 'operation', readOnly: true },
  { control: 'split_enable', id: 'split_enabled', category: 'operation' },
  { control: 'volume', id: 'master_volume', category: 'audio', globalOnly: true },
  { control: 'mute', id: 'master_mute', category: 'audio', globalOnly: true },
  { control: 'rx_volume', id: 'af_gain', category: 'audio', normalized: true },
  { control: 'rx_mute', id: 'mute', category: 'audio' },
  { control: 'rx_balance', id: 'balance', category: 'audio', normalized: true },
  { control: 'mon_enable', id: 'monitor_enabled', category: 'audio' },
  { control: 'mon_volume', id: 'monitor_gain', category: 'audio', normalized: true },
  { control: 'agc_mode', id: 'agc_mode', category: 'rf' },
  { control: 'agc_gain', id: 'agc_gain', category: 'rf' },
  { control: 'sql_enable', id: 'sql_enabled', category: 'audio' },
  { control: 'sql_level', id: 'sql', category: 'audio', normalized: true, nativeId: 'sql_threshold' },
  { control: 'rx_nb_enable', id: 'nb', category: 'rf' },
  { control: 'rx_nb_param', id: 'nb_threshold', category: 'rf', field: 'threshold', group: 'nb_parameters' },
  { control: 'rx_nb_param', id: 'nb_pulse_length', category: 'rf', field: 'pulseLength', group: 'nb_parameters' },
  { control: 'rx_nb_level', id: 'nb_level', category: 'rf', normalized: true },
  { control: 'rx_nr_enable', id: 'nr', category: 'rf' },
  { control: 'rx_anc_enable', id: 'anc_enabled', category: 'rf' },
  { control: 'rx_anf_enable', id: 'auto_notch', category: 'rf' },
  { control: 'rx_apf_enable', id: 'apf_enabled', category: 'rf' },
  { control: 'rx_nf_enable', id: 'notch_filter_enabled', category: 'rf' },
  { control: 'rx_bin_enable', id: 'binaural_enabled', category: 'audio' },
  { control: 'rx_dse_enable', id: 'surround_enabled', category: 'audio' },
  { control: 'rx_filter_band', id: 'rx_filter_low', category: 'operation', field: 'lowHz', group: 'rx_filter_band' },
  { control: 'rx_filter_band', id: 'rx_filter_high', category: 'operation', field: 'highHz', group: 'rx_filter_band' },
  { control: 'rit_enable', id: 'rit_enabled', category: 'operation' },
  { control: 'rit_offset', id: 'rit_offset', category: 'operation' },
  { control: 'xit_enable', id: 'xit_enabled', category: 'operation' },
  { control: 'xit_offset', id: 'xit_offset', category: 'operation' },
  { control: 'digl_offset', id: 'digl_offset', category: 'operation' },
  { control: 'digu_offset', id: 'digu_offset', category: 'operation' },
  { control: 'cw_macros_speed', id: 'cw_macro_speed', category: 'operation' },
  { control: 'cw_macros_delay', id: 'cw_macro_delay', category: 'operation' },
  { control: 'cw_keyer_speed', id: 'key_speed', category: 'operation' },
  { control: 'rx_channel_enable', id: 'rx_channel_enabled', category: 'operation' },
  { control: 'rx_enable', id: 'receiver_enabled', category: 'operation' },
  { control: 'lock', id: 'lock_mode', category: 'system' },
  { control: 'vfo_lock', id: 'vfo_locked', category: 'system' },
  { control: 'tx_enable', id: 'tx_permitted', category: 'system' },
  { control: 'tx_frequency', id: 'actual_tx_frequency', category: 'operation' },
  { control: 'rx_nr_algorithm', id: 'nr_algorithm', category: 'rf' },
  { control: 'rx_nb_algorithm', id: 'nb_algorithm', category: 'rf' },
  { control: 'rx_step_att_enabled_ex', id: 'attenuator_enabled', category: 'rf' },
  { control: 'rx_step_att_ex', id: 'attenuator_level', category: 'rf' },
  { control: 'rx_preamp_att_ex', id: 'preamp_attenuation', category: 'rf' },
  { control: 'agc_auto_ex', id: 'agc_auto', category: 'rf' },
  { control: 'rx_ctun_ex', id: 'center_tuning', category: 'operation' },
  { control: 'vfo_sync_ex', id: 'vfo_sync', category: 'operation' },
  { control: 'vfo_swap_ex', id: 'vfo_swap', category: 'operation' },
  { control: 'fm_deviation_ex', id: 'fm_deviation', category: 'operation' },
  { control: 'tx_filter_band_ex', id: 'tx_filter_low', category: 'audio', field: 'lowHz', group: 'tx_filter_band' },
  { control: 'tx_filter_band_ex', id: 'tx_filter_high', category: 'audio', field: 'highHz', group: 'tx_filter_band' },
  { control: 'tx_profile_ex', id: 'tx_profile', category: 'audio' },
  { control: 'mic_level', id: 'mic_gain', category: 'audio', normalized: true },
  { control: 'tx_gain', id: 'tx_audio_gain', category: 'audio', normalized: true },
];

interface BindingPort {
  sessionId: string;
  receiver: number;
  trx: number;
  channel: number;
  run<T>(name: string, task: () => Promise<T>, observation?: boolean, replacePending?: boolean): Promise<T>;
  assertIdle(): void;
}

/** Protocol-neutral UI mapping. Vendor command names/shapes are only interpreted by the library. */
export function createTciCapabilityBindings(client: TciClient, port: BindingPort): RadioCapabilityBindings {
  const initialDeadline = Date.now() + 2000;
  let controls = new Map(client.getControlCapabilities().map((d) => [d.id, d]));
  const entries = mappings.filter((m) => controls.has(m.control)).map((mapping) => {
    const d = controls.get(mapping.control)!;
    return { ...mapping, id: mapping.normalized && mapping.nativeId && !hasRange(d) ? mapping.nativeId : mapping.id };
  });
  const byControl = new Map<TciControlId, Mapping[]>();
  for (const entry of entries) byControl.set(entry.control, [...(byControl.get(entry.control) ?? []), entry]);
  const groupEntries = new Map<string, Mapping[]>();
  for (const entry of entries) if (entry.group) groupEntries.set(entry.group, [...(groupEntries.get(entry.group) ?? []), entry]);

  function target(d: TciControlDescriptor): TciControlTarget {
    switch (d.scope) {
      case 'global': return { scope: 'global' };
      case 'receiver': return { scope: 'receiver', receiver: port.receiver };
      case 'trx': return { scope: 'trx', trx: port.trx };
      case 'channel': return { scope: 'channel', receiver: port.receiver, channel: port.channel };
    }
  }
  const supported = (m: Mapping, d: TciControlDescriptor) => d.support === 'implemented' && (!m.globalOnly || d.scope === 'global');

  function descriptor(m: Mapping): CapabilityDescriptor {
    const d = controls.get(m.control)!;
    const r = m.field ? d.fields?.[m.field] : d.range;
    const normalized = Boolean(m.normalized && hasRange(d));
    const group = m.group ? groupEntries.get(m.group)! : undefined;
    const options = d.options?.map((value) => m.id === 'radio_mode'
      ? { value: String(value).toUpperCase(), label: String(value).toUpperCase() }
      : ['agc_mode', 'nr_algorithm', 'nb_algorithm'].includes(m.id)
        ? { value, labelI18nKey: `radio:capability.${m.id}.options.${value}` }
        : typeof value === 'number' ? { value } : { value, label: value });
    const scale = normalized ? (d.range!.max! - d.range!.min!) * (d.inverted ? -1 : 1) : 1;
    const offset = normalized ? (d.inverted ? d.range!.max! : d.range!.min!) : 0;
    const nativeUnit = d.unit === 'native' ? undefined : d.unit;
    return {
      id: m.id, category: m.category, sessionId: port.sessionId, target: target(d),
      valueType: m.field ? 'number' : d.valueType === 'action' ? 'action' : d.valueType === 'boolean' ? 'boolean' : d.valueType === 'enum' ? 'enum' : 'number',
      readable: d.valueType !== 'action' && (d.readable || d.confirmation !== 'sent'),
      writable: supported(m, d) && d.writable && !m.readOnly && (d.valueType !== 'enum' || Boolean(options?.length)),
      updateMode: d.updateMode, pollIntervalMs: d.updateMode === 'polling' ? 10_000 : undefined,
      range: normalized ? { min: 0, max: 1, step: r?.step === undefined ? undefined : r.step / Math.abs(scale) }
        : r?.min !== undefined && r.max !== undefined ? { min: r.min, max: r.max, step: r.step } : undefined,
      limits: !normalized && r ? { ...r } : undefined,
      options, requiresIdle: d.requiresIdle,
      compoundGroup: m.group,
      writeGroup: group ? { id: m.group!, members: group.map((member) => member.id) } : undefined,
      labelI18nKey: `radio:capability.${m.id}.label`,
      descriptionI18nKey: `radio:capability.${m.id}.description`,
      hasSurfaceControl: false,
      display: { mode: normalized && d.unit === 'percent' ? 'percent' : 'value',
        unit: nativeUnit, decimals: nativeUnit === 'dB' ? 2 : 0, signed: (r?.min ?? 0) < 0,
        ...(normalized && d.unit !== 'percent' ? { transform: { scale, offset } } : {}),
      },
    };
  }

  function project(m: Mapping, state?: TciControlState): CapabilityState {
    const d = controls.get(m.control)!;
    let value: CapabilityValue | null = null;
    const raw = m.field && state?.value && typeof state.value === 'object'
      ? (state.value as unknown as Record<string, number>)[m.field] : state?.value;
    if (typeof raw === 'boolean' || typeof raw === 'string') value = m.id === 'radio_mode' ? String(raw).toUpperCase() : raw;
    else if (typeof raw === 'number') {
      value = m.normalized && hasRange(d) ? normalize(raw, d) : raw;
    }
    return {
      id: m.id, supported: supported(m, d), value,
      availability: supported(m, d) ? state?.availability ?? (!d.readable && d.writable ? 'available' : 'unknown') : 'unknown',
      lastError: state?.lastError, availabilityReason: state?.lastError ? 'runtime_error' : undefined,
      updatedAt: state?.updatedAt ?? Date.now(),
      meta: { source: state?.source, revision: state?.revision, evidence: d.evidence,
        support: d.support, ...(d.reason ? { supportReason: d.reason } : {}) },
    };
  }

  async function readState(m: Mapping, force: boolean): Promise<CapabilityState> {
    const d = controls.get(m.control)!;
    if (!supported(m, d)) return project(m);
    const t = target(d);
    let state = client.getControlState(m.control, t);
    if (d.readable && (force || (!state && Date.now() < initialDeadline))) {
      const deadline = force ? Date.now() + 1000 : initialDeadline;
      const remaining = () => Math.max(0, Math.min(force ? 1000 : 250, deadline - Date.now()));
      await port.run(`control.read.${m.control}`, async () => {
        if (m.control === 'tx_profile_ex' && remaining() > 0) {
          await client.readControl('tx_profiles_ex', undefined, { timeoutMs: remaining() }).catch(() => undefined);
        }
        if (remaining() > 0) await client.readControl(m.control, t, { timeoutMs: remaining() }).catch(() => undefined);
      }, true);
      state = client.getControlState(m.control, t);
    }
    return project(m, state);
  }

  async function writeNative(m: Mapping, value: TciControlValue) {
    const d = controls.get(m.control)!;
    return port.run(`control.write.${m.control}`, async () => {
      if (d.requiresIdle) port.assertIdle();
      return client.writeControl(m.control, value, target(d));
    }, false, d.valueType !== 'action');
  }

  const definitions: CapabilityDefinition[] = entries.map((m) => ({
    id: m.id, descriptor: descriptor(m), resolveDescriptor: async () => descriptor(m),
    probeSupport: async () => ({ supported: supported(m, controls.get(m.control)!), source: 'backend-declared' }),
    readState: async (_conn, force) => readState(m, force),
    ...(!m.field && controls.get(m.control)!.valueType !== 'action' ? { write: async (_conn: unknown, value: CapabilityValue) => {
      const d = controls.get(m.control)!;
      const native = m.normalized && typeof value === 'number' && hasRange(d) ? denormalize(value, d) : value;
      const result = await writeNative(m, native);
      return {
        value: result.applied === null ? undefined : project(m, client.getControlState(m.control, target(d))).value ?? undefined,
        confirmed: result.outcome !== 'sent',
        meta: { requested: result.requested, applied: result.applied, limited: result.outcome === 'clamped', acknowledgement: result.acknowledgement },
      };
    } } : {}),
    ...(controls.get(m.control)!.valueType === 'action' ? { action: async () => { await writeNative(m, null); } } : {}),
  }));

  return {
    definitions,
    groups: [...groupEntries].map(([id, members]) => ({
      id, members: members.map((m) => m.id),
      async write(values) {
        const fields = Object.fromEntries(members.map((m) => [m.field!, values[m.id]]));
        await writeNative(members[0], fields as unknown as TciControlValue);
      },
    })),
    subscribe(listener, descriptorsChanged) {
      const onState = (state: TciControlState) => {
        const selected = byControl.get(state.id);
        const d = controls.get(state.id);
        if (!selected || !d || controlKey(state.id, state.target) !== controlKey(state.id, target(d))) return;
        listener(selected.map((m) => project(m, state)));
      };
      const onDescriptors = (descriptors: TciControlDescriptor[]) => {
        controls = new Map(descriptors.map((d) => [d.id, d]));
        descriptorsChanged();
      };
      client.on('controlChanged', onState);
      client.on('controlCapabilitiesChanged', onDescriptors);
      return () => {
        client.off('controlChanged', onState);
        client.off('controlCapabilitiesChanged', onDescriptors);
      };
    },
  };
}

function hasRange(d: TciControlDescriptor): boolean {
  return d.range?.min !== undefined && d.range.max !== undefined && d.range.max > d.range.min;
}
function normalize(value: number, d: TciControlDescriptor): number {
  const position = Math.max(0, Math.min(1, (value - d.range!.min!) / (d.range!.max! - d.range!.min!)));
  return d.inverted ? 1 - position : position;
}
function denormalize(value: number, d: TciControlDescriptor): number {
  const native = d.range!.min! + (d.inverted ? 1 - value : value) * (d.range!.max! - d.range!.min!);
  const step = d.range!.step;
  const rounded = step === undefined ? native : d.range!.min! + Math.round((native - d.range!.min!) / step) * step;
  return Number(rounded.toPrecision(12));
}
