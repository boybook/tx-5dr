import type { CapabilityDefinition } from './types.js';
import { RadioConnectionType } from '../connections/IRadioConnection.js';
import {
  buildCtcssToneOptions,
  buildDcsCodeOptions,
  buildModeBandwidthOptions,
  buildTuningStepOptions,
  createBooleanDescriptor,
  createOption,
  createPercentDescriptor,
  hasHamlibSupportProbe,
} from './definition-builders.js';

function createDefinitions(): CapabilityDefinition[] {
  return [
    {
      id: 'tuner_switch',
      descriptor: {
        id: 'tuner_switch',
        category: 'antenna',
        valueType: 'boolean',
        readable: true,
        writable: true,
        updateMode: 'polling',
        pollIntervalMs: 5000,
        compoundGroup: 'tuner',
        compoundRole: 'switch',
        labelI18nKey: 'radio:capability.tuner_switch.label',
        descriptionI18nKey: 'radio:capability.tuner_switch.description',
        hasSurfaceControl: true,
        surfaceGroup: 'tuner',
      },
      probeSupport: async (conn) => {
        if (!conn.getTunerCapabilities) return false;
        const caps = await conn.getTunerCapabilities();
        return caps.hasSwitch;
      },
      read: (conn) => conn.getTunerStatus!().then((status) => status.enabled),
      write: (conn, value) => conn.setTuner!(Boolean(value)),
    },
    {
      id: 'tuner_tune',
      descriptor: {
        id: 'tuner_tune',
        category: 'antenna',
        valueType: 'action',
        readable: false,
        writable: true,
        updateMode: 'none',
        compoundGroup: 'tuner',
        compoundRole: 'action',
        labelI18nKey: 'radio:capability.tuner_tune.label',
        descriptionI18nKey: 'radio:capability.tuner_tune.description',
        hasSurfaceControl: true,
        surfaceGroup: 'tuner',
      },
      probeSupport: async (conn) => {
        if (!conn.getTunerCapabilities) return false;
        const caps = await conn.getTunerCapabilities();
        return caps.hasManualTune;
      },
      action: async (conn) => {
        const result = await conn.startTuning!();
        if (!result) {
          throw new Error('manual tuning failed');
        }
      },
    },
    {
      id: 'rf_power',
      descriptor: createPercentDescriptor(
        'rf_power',
        'rf',
        'radio:capability.rf_power.label',
        'radio:capability.rf_power.description',
      ),
      probeSupport: async (conn) => {
        if (conn.getType() === RadioConnectionType.HAMLIB && hasHamlibSupportProbe(conn) && conn.isSupportedLevel('RFPOWER')) {
          return true;
        }
        if (!conn.getRFPower) return false;
        await conn.getRFPower();
        return true;
      },
      read: (conn) => conn.getRFPower!(),
      write: (conn, value) => conn.setRFPower!(value as number),
    },
    {
      id: 'af_gain',
      descriptor: createPercentDescriptor(
        'af_gain',
        'audio',
        'radio:capability.af_gain.label',
        'radio:capability.af_gain.description',
      ),
      probeSupport: async (conn) => {
        if (conn.getType() === RadioConnectionType.HAMLIB && hasHamlibSupportProbe(conn) && conn.isSupportedLevel('AF')) {
          return true;
        }
        if (!conn.getAFGain) return false;
        await conn.getAFGain();
        return true;
      },
      read: (conn) => conn.getAFGain!(),
      write: (conn, value) => conn.setAFGain!(value as number),
    },
    {
      id: 'sql',
      descriptor: createPercentDescriptor(
        'sql',
        'audio',
        'radio:capability.sql.label',
        'radio:capability.sql.description',
      ),
      probeSupport: async (conn) => {
        if (conn.getType() === RadioConnectionType.HAMLIB && hasHamlibSupportProbe(conn) && conn.isSupportedLevel('SQL')) {
          return true;
        }
        if (!conn.getSQL) return false;
        await conn.getSQL();
        return true;
      },
      read: (conn) => conn.getSQL!(),
      write: (conn, value) => conn.setSQL!(value as number),
    },
    {
      id: 'mic_gain',
      descriptor: createPercentDescriptor(
        'mic_gain',
        'audio',
        'radio:capability.mic_gain.label',
        'radio:capability.mic_gain.description',
      ),
      probeSupport: async (conn) => {
        if (conn.getType() === RadioConnectionType.HAMLIB && hasHamlibSupportProbe(conn) && conn.isSupportedLevel('MICGAIN')) {
          return true;
        }
        if (!conn.getMicGain) return false;
        await conn.getMicGain();
        return true;
      },
      read: (conn) => conn.getMicGain!(),
      write: (conn, value) => conn.setMicGain!(value as number),
    },
    {
      id: 'nb',
      descriptor: createPercentDescriptor(
        'nb',
        'rf',
        'radio:capability.nb.label',
        'radio:capability.nb.description',
      ),
      probeSupport: async (conn) => {
        if (!conn.getNBEnabled) return false;
        await conn.getNBEnabled();
        return true;
      },
      read: (conn) => conn.getNBEnabled!(),
      write: (conn, value) => conn.setNBEnabled!(value as number),
    },
    {
      id: 'nr',
      descriptor: createPercentDescriptor(
        'nr',
        'rf',
        'radio:capability.nr.label',
        'radio:capability.nr.description',
      ),
      probeSupport: async (conn) => {
        if (!conn.getNREnabled) return false;
        await conn.getNREnabled();
        return true;
      },
      read: (conn) => conn.getNREnabled!(),
      write: (conn, value) => conn.setNREnabled!(value as number),
    },
    {
      id: 'lock_mode',
      descriptor: createBooleanDescriptor(
        'lock_mode',
        'system',
        'radio:capability.lock_mode.label',
        'radio:capability.lock_mode.description',
      ),
      probeSupport: async (conn) => {
        if (!conn.getLockMode) return false;
        await conn.getLockMode();
        return true;
      },
      read: (conn) => conn.getLockMode!(),
      write: (conn, value) => conn.setLockMode!(Boolean(value)),
    },
    {
      id: 'mute',
      descriptor: createBooleanDescriptor(
        'mute',
        'system',
        'radio:capability.mute.label',
        'radio:capability.mute.description',
      ),
      probeSupport: async (conn) => {
        if (!conn.getMuteEnabled) return false;
        await conn.getMuteEnabled();
        return true;
      },
      read: (conn) => conn.getMuteEnabled!(),
      write: (conn, value) => conn.setMuteEnabled!(Boolean(value)),
    },
    {
      id: 'vox',
      descriptor: createBooleanDescriptor(
        'vox',
        'audio',
        'radio:capability.vox.label',
        'radio:capability.vox.description',
      ),
      probeSupport: async (conn) => {
        if (!conn.getVOXEnabled) return false;
        await conn.getVOXEnabled();
        return true;
      },
      read: (conn) => conn.getVOXEnabled!(),
      write: (conn, value) => conn.setVOXEnabled!(Boolean(value)),
    },
    {
      id: 'mode_bandwidth',
      descriptor: {
        id: 'mode_bandwidth',
        category: 'operation',
        valueType: 'enum',
        options: [],
        readable: true,
        writable: true,
        updateMode: 'polling',
        pollIntervalMs: 2000,
        labelI18nKey: 'radio:capability.mode_bandwidth.label',
        descriptionI18nKey: 'radio:capability.mode_bandwidth.description',
        display: { mode: 'value', unit: 'Hz', decimals: 0 },
        hasSurfaceControl: false,
      },
      resolveDescriptor: async (conn) => ({
        id: 'mode_bandwidth',
        category: 'operation',
        valueType: 'enum',
        options: buildModeBandwidthOptions(
          conn.getSupportedModeBandwidths ? await conn.getSupportedModeBandwidths() : [],
        ),
        readable: true,
        writable: true,
        updateMode: 'polling',
        pollIntervalMs: 2000,
        labelI18nKey: 'radio:capability.mode_bandwidth.label',
        descriptionI18nKey: 'radio:capability.mode_bandwidth.description',
        display: { mode: 'value', unit: 'Hz', decimals: 0 },
        hasSurfaceControl: false,
      }),
      probeSupport: async (conn) => {
        if (!conn.getModeBandwidth || !conn.setModeBandwidth || !conn.getSupportedModeBandwidths) {
          return false;
        }
        const bandwidths = await conn.getSupportedModeBandwidths();
        await conn.getModeBandwidth();
        return bandwidths.length > 0;
      },
      read: (conn) => conn.getModeBandwidth!(),
      write: (conn, value) => conn.setModeBandwidth!(value as any),
    },
    {
      id: 'rit_offset',
      descriptor: {
        id: 'rit_offset',
        category: 'operation',
        valueType: 'number',
        range: { min: -9999, max: 9999, step: 1 },
        readable: true,
        writable: true,
        updateMode: 'polling',
        pollIntervalMs: 10000,
        labelI18nKey: 'radio:capability.rit_offset.label',
        descriptionI18nKey: 'radio:capability.rit_offset.description',
        display: { mode: 'value', unit: 'Hz', decimals: 0, signed: true },
        hasSurfaceControl: false,
      },
      resolveDescriptor: async (conn) => {
        const maxAbsOffset = conn.getMaxRit ? Math.max(1, await conn.getMaxRit()) : 9999;
        return {
          id: 'rit_offset',
          category: 'operation',
          valueType: 'number',
          range: { min: -maxAbsOffset, max: maxAbsOffset, step: 1 },
          readable: true,
          writable: true,
          updateMode: 'polling',
          pollIntervalMs: 10000,
          labelI18nKey: 'radio:capability.rit_offset.label',
          descriptionI18nKey: 'radio:capability.rit_offset.description',
          display: { mode: 'value', unit: 'Hz', decimals: 0, signed: true },
          hasSurfaceControl: false,
        };
      },
      probeSupport: async (conn) => {
        if (!conn.getRitOffset) return false;
        await conn.getRitOffset();
        return true;
      },
      read: (conn) => conn.getRitOffset!(),
      write: (conn, value) => conn.setRitOffset!(value as number),
    },
    {
      id: 'xit_offset',
      descriptor: {
        id: 'xit_offset',
        category: 'operation',
        valueType: 'number',
        range: { min: -9999, max: 9999, step: 1 },
        readable: true,
        writable: true,
        updateMode: 'polling',
        pollIntervalMs: 10000,
        labelI18nKey: 'radio:capability.xit_offset.label',
        descriptionI18nKey: 'radio:capability.xit_offset.description',
        display: { mode: 'value', unit: 'Hz', decimals: 0, signed: true },
        hasSurfaceControl: false,
      },
      resolveDescriptor: async (conn) => {
        const maxAbsOffset = conn.getMaxXit ? Math.max(1, await conn.getMaxXit()) : 9999;
        return {
          id: 'xit_offset',
          category: 'operation',
          valueType: 'number',
          range: { min: -maxAbsOffset, max: maxAbsOffset, step: 1 },
          readable: true,
          writable: true,
          updateMode: 'polling',
          pollIntervalMs: 10000,
          labelI18nKey: 'radio:capability.xit_offset.label',
          descriptionI18nKey: 'radio:capability.xit_offset.description',
          display: { mode: 'value', unit: 'Hz', decimals: 0, signed: true },
          hasSurfaceControl: false,
        };
      },
      probeSupport: async (conn) => {
        if (!conn.getXitOffset) return false;
        await conn.getXitOffset();
        return true;
      },
      read: (conn) => conn.getXitOffset!(),
      write: (conn, value) => conn.setXitOffset!(value as number),
    },
    {
      id: 'tuning_step',
      descriptor: {
        id: 'tuning_step',
        category: 'operation',
        valueType: 'enum',
        options: [],
        readable: true,
        writable: true,
        updateMode: 'polling',
        pollIntervalMs: 10000,
        labelI18nKey: 'radio:capability.tuning_step.label',
        descriptionI18nKey: 'radio:capability.tuning_step.description',
        display: { mode: 'value', unit: 'Hz', decimals: 0 },
        hasSurfaceControl: false,
      },
      resolveDescriptor: async (conn) => ({
        id: 'tuning_step',
        category: 'operation',
        valueType: 'enum',
        options: buildTuningStepOptions(conn.getSupportedTuningSteps ? await conn.getSupportedTuningSteps() : []),
        readable: true,
        writable: true,
        updateMode: 'polling',
        pollIntervalMs: 10000,
        labelI18nKey: 'radio:capability.tuning_step.label',
        descriptionI18nKey: 'radio:capability.tuning_step.description',
        display: { mode: 'value', unit: 'Hz', decimals: 0 },
        hasSurfaceControl: false,
      }),
      probeSupport: async (conn) => {
        if (!conn.getTuningStep) return false;
        await conn.getTuningStep();
        return true;
      },
      read: (conn) => conn.getTuningStep!(),
      write: (conn, value) => conn.setTuningStep!(value as number),
    },
    {
      id: 'power_state',
      descriptor: {
        id: 'power_state',
        category: 'system',
        valueType: 'enum',
        options: [
          createOption('off', 'radio:capability.options.power_state.off'),
          createOption('on', 'radio:capability.options.power_state.on'),
          createOption('standby', 'radio:capability.options.power_state.standby'),
          createOption('operate', 'radio:capability.options.power_state.operate'),
          createOption('unknown', 'radio:capability.options.power_state.unknown'),
        ],
        readable: true,
        writable: true,
        updateMode: 'polling',
        pollIntervalMs: 10000,
        labelI18nKey: 'radio:capability.power_state.label',
        descriptionI18nKey: 'radio:capability.power_state.description',
        display: { mode: 'value', unit: 'state' },
        hasSurfaceControl: false,
      },
      probeSupport: async (conn) => {
        if (!conn.getPowerState) return false;
        await conn.getPowerState();
        return true;
      },
      read: (conn) => conn.getPowerState!(),
      write: (conn, value) => conn.setPowerState!(String(value)),
    },
    {
      id: 'repeater_shift',
      descriptor: {
        id: 'repeater_shift',
        category: 'operation',
        valueType: 'enum',
        options: [
          createOption('none', 'radio:capability.options.repeater_shift.none'),
          createOption('minus', 'radio:capability.options.repeater_shift.minus'),
          createOption('plus', 'radio:capability.options.repeater_shift.plus'),
        ],
        readable: true,
        writable: true,
        updateMode: 'polling',
        pollIntervalMs: 10000,
        labelI18nKey: 'radio:capability.repeater_shift.label',
        descriptionI18nKey: 'radio:capability.repeater_shift.description',
        display: { mode: 'value', unit: 'state' },
        hasSurfaceControl: false,
      },
      probeSupport: async (conn) => {
        if (!conn.getRepeaterShift) return false;
        await conn.getRepeaterShift();
        return true;
      },
      read: (conn) => conn.getRepeaterShift!(),
      write: (conn, value) => conn.setRepeaterShift!(String(value)),
    },
    {
      id: 'repeater_offset',
      descriptor: {
        id: 'repeater_offset',
        category: 'operation',
        valueType: 'number',
        range: { min: 0, max: 10000000, step: 100 },
        readable: true,
        writable: true,
        updateMode: 'polling',
        pollIntervalMs: 10000,
        labelI18nKey: 'radio:capability.repeater_offset.label',
        descriptionI18nKey: 'radio:capability.repeater_offset.description',
        display: { mode: 'value', unit: 'kHz', decimals: 3 },
        hasSurfaceControl: false,
      },
      probeSupport: async (conn) => {
        if (!conn.getRepeaterOffset) return false;
        await conn.getRepeaterOffset();
        return true;
      },
      read: (conn) => conn.getRepeaterOffset!(),
      write: (conn, value) => conn.setRepeaterOffset!(value as number),
    },
    {
      id: 'ctcss_tone',
      descriptor: {
        id: 'ctcss_tone',
        category: 'operation',
        valueType: 'enum',
        options: [],
        readable: true,
        writable: true,
        updateMode: 'polling',
        pollIntervalMs: 10000,
        labelI18nKey: 'radio:capability.ctcss_tone.label',
        descriptionI18nKey: 'radio:capability.ctcss_tone.description',
        display: { mode: 'value', unit: 'toneHz', decimals: 1 },
        hasSurfaceControl: false,
      },
      resolveDescriptor: async (conn) => ({
        id: 'ctcss_tone',
        category: 'operation',
        valueType: 'enum',
        options: buildCtcssToneOptions(conn.getAvailableCtcssTones ? await conn.getAvailableCtcssTones() : []),
        readable: true,
        writable: true,
        updateMode: 'polling',
        pollIntervalMs: 10000,
        labelI18nKey: 'radio:capability.ctcss_tone.label',
        descriptionI18nKey: 'radio:capability.ctcss_tone.description',
        display: { mode: 'value', unit: 'toneHz', decimals: 1 },
        hasSurfaceControl: false,
      }),
      probeSupport: async (conn) => {
        if (!conn.getCtcssTone) return false;
        await conn.getCtcssTone();
        return true;
      },
      read: (conn) => conn.getCtcssTone!(),
      write: (conn, value) => conn.setCtcssTone!(value as number),
    },
    {
      id: 'dcs_code',
      descriptor: {
        id: 'dcs_code',
        category: 'operation',
        valueType: 'enum',
        options: [],
        readable: true,
        writable: true,
        updateMode: 'polling',
        pollIntervalMs: 10000,
        labelI18nKey: 'radio:capability.dcs_code.label',
        descriptionI18nKey: 'radio:capability.dcs_code.description',
        display: { mode: 'value', unit: 'code' },
        hasSurfaceControl: false,
      },
      resolveDescriptor: async (conn) => ({
        id: 'dcs_code',
        category: 'operation',
        valueType: 'enum',
        options: buildDcsCodeOptions(conn.getAvailableDcsCodes ? await conn.getAvailableDcsCodes() : []),
        readable: true,
        writable: true,
        updateMode: 'polling',
        pollIntervalMs: 10000,
        labelI18nKey: 'radio:capability.dcs_code.label',
        descriptionI18nKey: 'radio:capability.dcs_code.description',
        display: { mode: 'value', unit: 'code' },
        hasSurfaceControl: false,
      }),
      probeSupport: async (conn) => {
        if (!conn.getDcsCode) return false;
        await conn.getDcsCode();
        return true;
      },
      read: (conn) => conn.getDcsCode!(),
      write: (conn, value) => conn.setDcsCode!(value as number),
    },
  ];
}

export const CAPABILITY_DEFINITIONS = createDefinitions();
export const CAPABILITY_DEFINITION_MAP = new Map(CAPABILITY_DEFINITIONS.map((definition) => [definition.id, definition]));
