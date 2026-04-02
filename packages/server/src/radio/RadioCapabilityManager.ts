/**
 * RadioCapabilityManager - 统一电台控制能力管理器
 *
 * 职责：
 * - 连接时解析 descriptor、探测各能力是否支持、读取初始值、启动轮询
 * - 轮询检测到值变化时 emit 'capabilityChanged'
 * - 接收写命令，路由到对应的连接层方法
 * - 断开时停止轮询、清空缓存
 */

import { EventEmitter } from 'eventemitter3';
import type {
  CapabilityDescriptor,
  CapabilityOption,
  CapabilityState,
  CapabilityValue,
} from '@tx5dr/contracts';
import type { IRadioConnection } from './connections/IRadioConnection.js';
import { RadioConnectionType } from './connections/IRadioConnection.js';
import { createLogger } from '../utils/logger.js';
import { isRecoverableOptionalRadioError } from './optionalRadioError.js';

const logger = createLogger('RadioCapabilityManager');

type CapabilityRuntimeValue = CapabilityState['value'];
type ReadFn = (conn: IRadioConnection) => Promise<CapabilityRuntimeValue>;
type WriteFn = (conn: IRadioConnection, value: CapabilityValue) => Promise<void>;
type ActionFn = (conn: IRadioConnection) => Promise<void>;
type ProbeFn = (conn: IRadioConnection) => Promise<boolean>;
type DescriptorResolver = (conn: IRadioConnection) => Promise<CapabilityDescriptor>;

interface CapabilityDefinition {
  id: string;
  descriptor: CapabilityDescriptor;
  probeSupport: ProbeFn;
  read?: ReadFn;
  write?: WriteFn;
  action?: ActionFn;
  resolveDescriptor?: DescriptorResolver;
}

interface HamlibSupportProbeConnection extends IRadioConnection {
  isSupportedLevel(level: string): boolean;
  isSupportedFunction(functionName: string): boolean;
  isSupportedParm(parmName: string): boolean;
}

function hasHamlibSupportProbe(connection: IRadioConnection): connection is HamlibSupportProbeConnection {
  const candidate = connection as Partial<HamlibSupportProbeConnection>;
  return typeof candidate.isSupportedLevel === 'function'
    && typeof candidate.isSupportedFunction === 'function'
    && typeof candidate.isSupportedParm === 'function';
}

function createPercentDescriptor(
  id: string,
  category: CapabilityDescriptor['category'],
  labelI18nKey: string,
  descriptionI18nKey: string,
): CapabilityDescriptor {
  return {
    id,
    category,
    valueType: 'number',
    range: { min: 0, max: 1, step: 0.01 },
    readable: true,
    writable: true,
    updateMode: 'polling',
    pollIntervalMs: 10000,
    labelI18nKey,
    descriptionI18nKey,
    display: { mode: 'percent', decimals: 0 },
    hasSurfaceControl: false,
  };
}

function createBooleanDescriptor(
  id: string,
  category: CapabilityDescriptor['category'],
  labelI18nKey: string,
  descriptionI18nKey: string,
): CapabilityDescriptor {
  return {
    id,
    category,
    valueType: 'boolean',
    readable: true,
    writable: true,
    updateMode: 'polling',
    pollIntervalMs: 10000,
    labelI18nKey,
    descriptionI18nKey,
    hasSurfaceControl: false,
  };
}

function createOption(value: string | number, labelI18nKey?: string): CapabilityOption {
  return labelI18nKey ? { value, labelI18nKey } : { value };
}

function uniqueSortedNumbers(values: number[]): number[] {
  return Array.from(new Set(values.filter((value) => Number.isFinite(value)))).sort((a, b) => a - b);
}

function buildTuningStepOptions(steps: number[]): CapabilityOption[] {
  return uniqueSortedNumbers(steps)
    .filter((step) => step > 0)
    .map((step) => createOption(step));
}

function buildCtcssToneOptions(tones: number[]): CapabilityOption[] {
  return uniqueSortedNumbers(tones)
    .filter((tone) => tone > 0)
    .map((tone) => createOption(tone));
}

function buildDcsCodeOptions(codes: number[]): CapabilityOption[] {
  return uniqueSortedNumbers(codes)
    .filter((code) => code > 0)
    .map((code) => createOption(code));
}

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
      action: (conn) => conn.startTuning!().then(() => {}),
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

const CAPABILITY_DEFINITIONS = createDefinitions();
const CAPABILITY_DEFINITION_MAP = new Map(CAPABILITY_DEFINITIONS.map((definition) => [definition.id, definition]));

// ===== 事件接口 =====

export interface RadioCapabilityManagerEvents {
  capabilityList: (data: { descriptors: CapabilityDescriptor[]; capabilities: CapabilityState[] }) => void;
  capabilityChanged: (state: CapabilityState) => void;
}

export class RadioCapabilityManager extends EventEmitter<RadioCapabilityManagerEvents> {
  private connection: IRadioConnection | null = null;
  private readonly supportedCapabilities = new Set<string>();
  private readonly valueCache = new Map<string, CapabilityState>();
  private readonly descriptorCache = new Map<string, CapabilityDescriptor>();
  private readonly pollingTimers = new Map<string, ReturnType<typeof setInterval>>();

  async onConnected(connection: IRadioConnection): Promise<void> {
    this.connection = connection;
    this.stopAllPolling();
    this.supportedCapabilities.clear();
    this.valueCache.clear();

    await this.resolveDescriptors(connection);

    logger.info('Probing radio capabilities');
    try {
      await this.probeCapabilities();
    } catch (error) {
      logger.warn('Capability probe encountered an unexpected error', error);
    }

    try {
      await this.readInitialValues();
    } catch (error) {
      logger.warn('Initial capability read encountered an unexpected error', error);
    }

    this.startPolling();

    logger.info('Capability probe complete', {
      supported: Array.from(this.supportedCapabilities),
    });

    this.emit('capabilityList', this.getCapabilitySnapshot());
  }

  onDisconnected(): void {
    this.stopAllPolling();
    this.connection = null;
    this.supportedCapabilities.clear();
    this.valueCache.clear();
    this.descriptorCache.clear();
    this.emit('capabilityList', { descriptors: [], capabilities: [] });
  }

  async writeCapability(id: string, value?: CapabilityValue, action?: boolean): Promise<void> {
    if (!this.connection) {
      throw new Error('Radio not connected');
    }

    const definition = CAPABILITY_DEFINITION_MAP.get(id);
    const descriptor = this.descriptorCache.get(id);
    if (!definition || !descriptor) {
      throw new Error(`Unknown capability '${id}'`);
    }

    if (!this.supportedCapabilities.has(id)) {
      throw new Error(`Capability '${id}' is not supported by current radio`);
    }

    if (action) {
      if (!definition.action) {
        throw new Error(`No action handler for capability '${id}'`);
      }

      logger.info(`Executing action: ${id}`);
      await definition.action(this.connection);

      if (id === 'tuner_tune') {
        const tunerState = this.valueCache.get('tuner_switch');
        if (tunerState) {
          const updatedState: CapabilityState = {
            ...tunerState,
            meta: { ...tunerState.meta, status: 'tuning' },
            updatedAt: Date.now(),
          };
          this.valueCache.set('tuner_switch', updatedState);
          this.emit('capabilityChanged', updatedState);
        }
      }
      return;
    }

    if (value === undefined) {
      throw new Error(`Value required for capability '${id}'`);
    }

    this.assertWriteValue(descriptor, value);

    if (!definition.write) {
      throw new Error(`No write handler for capability '${id}'`);
    }

    logger.info(`Writing capability: ${id}`, { value });
    await definition.write(this.connection, value);

    const optimisticState: CapabilityState = {
      id,
      supported: true,
      value,
      meta: this.valueCache.get(id)?.meta,
      updatedAt: Date.now(),
    };
    this.valueCache.set(id, optimisticState);
    this.emit('capabilityChanged', optimisticState);

    setTimeout(() => {
      void this.pollCapabilityOnce(id);
    }, 500);
  }

  getCapabilitySnapshot(): { descriptors: CapabilityDescriptor[]; capabilities: CapabilityState[] } {
    return {
      descriptors: this.getCapabilityDescriptors(),
      capabilities: this.buildSnapshot(),
    };
  }

  getCapabilityStates(): CapabilityState[] {
    return this.buildSnapshot();
  }

  getCapabilityDescriptors(): CapabilityDescriptor[] {
    if (this.descriptorCache.size === 0) {
      return [];
    }

    return CAPABILITY_DEFINITIONS
      .map((definition) => this.descriptorCache.get(definition.id))
      .filter((descriptor): descriptor is CapabilityDescriptor => Boolean(descriptor));
  }

  private async resolveDescriptors(connection: IRadioConnection): Promise<void> {
    this.descriptorCache.clear();

    for (const definition of CAPABILITY_DEFINITIONS) {
      const fallbackDescriptor = definition.descriptor;
      try {
        const descriptor = definition.resolveDescriptor
          ? await definition.resolveDescriptor(connection)
          : fallbackDescriptor;
        this.descriptorCache.set(definition.id, descriptor);
      } catch (error) {
        logger.debug(`Using fallback descriptor for capability ${definition.id}`, error);
        this.descriptorCache.set(definition.id, fallbackDescriptor);
      }
    }
  }

  private async probeCapabilities(): Promise<void> {
    if (!this.connection) return;

    for (const definition of CAPABILITY_DEFINITIONS) {
      try {
        const supported = await definition.probeSupport(this.connection);
        if (supported) {
          this.supportedCapabilities.add(definition.id);
          logger.debug(`Capability supported: ${definition.id}`);
        }
      } catch (error) {
        if (isRecoverableOptionalRadioError(error)) {
          logger.debug(`Capability not supported: ${definition.id} (recoverable probe failure)`);
          continue;
        }

        logger.warn(`Capability probe failed for ${definition.id}`, error);
      }
    }
  }

  private async readInitialValues(): Promise<void> {
    for (const definition of CAPABILITY_DEFINITIONS) {
      if (!this.supportedCapabilities.has(definition.id)) {
        continue;
      }

      const descriptor = this.descriptorCache.get(definition.id);
      if (!descriptor?.readable || !definition.read) {
        continue;
      }

      await this.pollCapabilityOnce(definition.id);
    }
  }

  private startPolling(): void {
    for (const definition of CAPABILITY_DEFINITIONS) {
      if (!this.supportedCapabilities.has(definition.id)) {
        continue;
      }

      const descriptor = this.descriptorCache.get(definition.id);
      if (!descriptor || descriptor.updateMode !== 'polling' || !descriptor.pollIntervalMs || !descriptor.readable || !definition.read) {
        continue;
      }

      const timer = setInterval(() => {
        void this.pollCapabilityOnce(definition.id);
      }, descriptor.pollIntervalMs);

      this.pollingTimers.set(definition.id, timer);
      logger.debug(`Started polling for ${definition.id} (interval: ${descriptor.pollIntervalMs}ms)`);
    }
  }

  private stopAllPolling(): void {
    for (const [id, timer] of this.pollingTimers) {
      clearInterval(timer);
      logger.debug(`Stopped polling for ${id}`);
    }
    this.pollingTimers.clear();
  }

  private async pollCapabilityOnce(id: string): Promise<void> {
    if (!this.connection) return;

    const definition = CAPABILITY_DEFINITION_MAP.get(id);
    const descriptor = this.descriptorCache.get(id);
    if (!definition?.read || !descriptor?.readable) return;

    try {
      const newValue = await definition.read(this.connection);
      const cached = this.valueCache.get(id);

      if (!cached || cached.value !== newValue) {
        const newState: CapabilityState = {
          id,
          supported: true,
          value: newValue,
          meta: cached?.meta,
          updatedAt: Date.now(),
        };

        if (id === 'tuner_switch') {
          const currentMeta = cached?.meta ?? {};
          newState.meta = currentMeta.status === 'tuning' ? currentMeta : { ...currentMeta, status: 'idle' };
        }

        this.valueCache.set(id, newState);

        if (cached) {
          logger.debug(`Capability changed: ${id}`, { value: newValue });
          this.emit('capabilityChanged', newState);
        }
      }
    } catch (error) {
      if (isRecoverableOptionalRadioError(error)) {
        this.markCapabilityUnsupported(id, error);
        return;
      }

      logger.debug(`Failed to poll capability ${id}`, error);
    }
  }

  private markCapabilityUnsupported(id: string, error: unknown): void {
    const hadCachedState = this.valueCache.has(id);
    const hadPollingTimer = this.pollingTimers.has(id);

    this.supportedCapabilities.delete(id);
    this.valueCache.delete(id);

    const timer = this.pollingTimers.get(id);
    if (timer) {
      clearInterval(timer);
      this.pollingTimers.delete(id);
    }

    logger.info(`Capability downgraded to unsupported: ${id}`, {
      reason: error instanceof Error ? error.message : String(error),
    });

    if (hadCachedState || hadPollingTimer) {
      this.emit('capabilityChanged', {
        id,
        supported: false,
        value: null,
        updatedAt: Date.now(),
      });
    }
  }

  private buildSnapshot(): CapabilityState[] {
    if (this.descriptorCache.size === 0) {
      return [];
    }

    return CAPABILITY_DEFINITIONS
      .filter((definition) => this.descriptorCache.has(definition.id))
      .map((definition) => {
        const cached = this.valueCache.get(definition.id);
        if (cached) return cached;

        if (this.supportedCapabilities.has(definition.id)) {
          return {
            id: definition.id,
            supported: true,
            value: null,
            updatedAt: Date.now(),
          };
        }

        return {
          id: definition.id,
          supported: false,
          value: null,
          updatedAt: Date.now(),
        };
      });
  }

  private assertWriteValue(descriptor: CapabilityDescriptor, value: CapabilityValue): void {
    switch (descriptor.valueType) {
      case 'boolean':
        if (typeof value !== 'boolean') {
          throw new Error(`Capability '${descriptor.id}' expects a boolean value`);
        }
        return;
      case 'number':
        if (typeof value !== 'number') {
          throw new Error(`Capability '${descriptor.id}' expects a numeric value`);
        }
        if (descriptor.range && (value < descriptor.range.min || value > descriptor.range.max)) {
          throw new Error(`Capability '${descriptor.id}' value out of range`);
        }
        return;
      case 'enum': {
        if (typeof value !== 'string' && typeof value !== 'number') {
          throw new Error(`Capability '${descriptor.id}' expects an enum value`);
        }
        if (descriptor.options && descriptor.options.length > 0) {
          const matched = descriptor.options.some((option) => option.value === value);
          if (!matched) {
            throw new Error(`Capability '${descriptor.id}' received an unsupported enum value`);
          }
        }
        return;
      }
      case 'action':
        throw new Error(`Capability '${descriptor.id}' is action-only`);
      default:
        throw new Error(`Unsupported capability value type for '${descriptor.id}'`);
    }
  }
}
