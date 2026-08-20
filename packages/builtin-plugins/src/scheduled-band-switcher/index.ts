import type { CapabilityList, CapabilityState } from '@tx5dr/contracts';
import {
  definePlugin,
  type OtherOperatorSnapshot,
  type PluginContextFor,
} from '@tx5dr/plugin-api';
import {
  isScheduleDayActive,
  isTimeInScheduleRange,
  normalizeFrequencyMhzToHz,
  parseScheduleDays,
  parseScheduleTime,
} from '../_shared/schedule-utils.js';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };
import jaLocale from './locales/ja.json' with { type: 'json' };

const TIMER_ID = 'scheduled-band-switcher';
const TIMER_INTERVAL_MS = 30_000;
const ROTATION_STATE_KEY = 'rotationState';
const FREQUENCY_TOLERANCE_HZ = 10;
const TUNER_SWITCH_CAPABILITY_ID = 'tuner_switch';
const TUNER_TUNE_CAPABILITY_ID = 'tuner_tune';

type SwitchMode = 'schedule' | 'rotation';
type ScheduleEntry = {
  id?: unknown;
  enabled?: unknown;
  days?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  frequencyMhz?: unknown;
};

type RotationState = {
  index: number;
  lastSwitchMs: number;
};
type BandSwitcherContext = PluginContextFor<readonly [
  'radio:read',
  'radio:control',
  'radio:tuner-control',
]>;

function getSwitchMode(ctx: BandSwitcherContext): SwitchMode {
  return ctx.config.bandSwitchMode === 'rotation' ? 'rotation' : 'schedule';
}

function getScheduleEntries(value: unknown): ScheduleEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is ScheduleEntry => Boolean(row) && typeof row === 'object' && !Array.isArray(row));
}

function getRotationFrequencies(value: unknown): number[] {
  const entries = typeof value === 'string'
    ? value.split(/\r?\n|,/)
    : Array.isArray(value)
      ? value
      : [];
  const frequencies: number[] = [];
  for (const entry of entries) {
    const frequency = normalizeFrequencyMhzToHz(entry);
    if (frequency && !frequencies.includes(frequency)) {
      frequencies.push(frequency);
    }
  }
  return frequencies;
}

function getScheduledTargetFrequency(ctx: BandSwitcherContext, now = new Date()): number | null {
  for (const row of getScheduleEntries(ctx.config.bandScheduleEntries)) {
    if (row.enabled === false) continue;
    const days = parseScheduleDays(row.days);
    const start = parseScheduleTime(row.startTime);
    const end = parseScheduleTime(row.endTime);
    const frequency = normalizeFrequencyMhzToHz(row.frequencyMhz);
    if (!days || !start || !end || !frequency) continue;
    if (isScheduleDayActive(days, now) && isTimeInScheduleRange(now, start, end)) {
      return frequency;
    }
  }
  return null;
}

function getRotationTargetFrequency(ctx: BandSwitcherContext, now = new Date()): number | null {
  const frequencies = getRotationFrequencies(ctx.config.rotationFrequenciesMhz);
  if (frequencies.length === 0) return null;

  const intervalMinutes = typeof ctx.config.rotationIntervalMinutes === 'number'
    ? ctx.config.rotationIntervalMinutes
    : Number(ctx.config.rotationIntervalMinutes);
  const intervalMs = Math.max(1, Number.isFinite(intervalMinutes) ? intervalMinutes : 30) * 60_000;
  const state = ctx.store.global.get<RotationState>(ROTATION_STATE_KEY, { index: -1, lastSwitchMs: 0 });
  if (state.lastSwitchMs > 0 && now.getTime() - state.lastSwitchMs < intervalMs) {
    return null;
  }

  const nextIndex = (Number.isInteger(state.index) ? state.index + 1 : 0) % frequencies.length;
  return frequencies[nextIndex] ?? null;
}

function commitRotationTarget(ctx: BandSwitcherContext, frequency: number, now: Date): void {
  const frequencies = getRotationFrequencies(ctx.config.rotationFrequenciesMhz);
  const index = frequencies.indexOf(frequency);
  if (index < 0) return;
  ctx.store.global.set(ROTATION_STATE_KEY, { index, lastSwitchMs: now.getTime() });
}

function isOperatorBusy(operator: OtherOperatorSnapshot): boolean {
  if (operator.isTransmitting) return true;
  const automation = operator.automation;
  if (!automation) return false;
  const targetCallsign = typeof automation.context?.targetCallsign === 'string'
    ? automation.context.targetCallsign.trim()
    : '';
  return automation.currentState !== 'TX6' || targetCallsign.length > 0;
}

function canSwitchRadio(ctx: BandSwitcherContext): boolean {
  if (!ctx.radio.isConnected) {
    ctx.log.debug('Scheduled band switch skipped because radio is not connected');
    return false;
  }

  const busyOperator = ctx.operator.getOtherOperators().find(isOperatorBusy);
  if (busyOperator) {
    ctx.log.debug('Scheduled band switch skipped because an operator is busy', {
      operatorId: busyOperator.id,
      callsign: busyOperator.callsign,
      isTransmitting: busyOperator.isTransmitting,
      state: busyOperator.automation?.currentState,
    });
    return false;
  }

  return true;
}

function getCapabilityState(snapshot: CapabilityList, id: string): CapabilityState | null {
  return snapshot.capabilities.find((capability) => capability.id === id) ?? null;
}

function isWritableCapabilityAvailable(snapshot: CapabilityList, id: string): boolean {
  const descriptor = snapshot.descriptors.find((item) => item.id === id);
  const state = getCapabilityState(snapshot, id);
  return descriptor?.writable === true
    && state?.supported === true
    && state.availability !== 'unavailable';
}

async function shouldAutoTuneAfterSwitch(ctx: BandSwitcherContext): Promise<boolean> {
  if (ctx.config.autoTuneAfterSwitchEnabled !== true) return false;
  if (!ctx.radio.isConnected) {
    ctx.log.debug('Scheduled band switch auto tune skipped because radio is not connected');
    return false;
  }

  // Capability refresh performs radio I/O and must not run outside the Host's
  // physical-idle fence. Use the cached projection here; the Host revalidates
  // the writable capabilities inside the composite switch-band transaction.
  const snapshot: CapabilityList = ctx.radioCapabilities.getSnapshot();

  const hasTunerSwitch = isWritableCapabilityAvailable(snapshot, TUNER_SWITCH_CAPABILITY_ID);
  const hasManualTune = isWritableCapabilityAvailable(snapshot, TUNER_TUNE_CAPABILITY_ID);
  if (!hasTunerSwitch || !hasManualTune) {
    ctx.log.debug('Scheduled band switch auto tune skipped because tuner capabilities are unavailable', {
      tunerSwitch: hasTunerSwitch,
      tunerTune: hasManualTune,
    });
    return false;
  }
  return true;
}

function configureTimer(ctx: BandSwitcherContext): void {
  if (ctx.config.bandSwitchEnabled === true) {
    ctx.timers.set(TIMER_ID, TIMER_INTERVAL_MS);
    return;
  }
  ctx.timers.clear(TIMER_ID);
}

async function runBandSwitchCheck(ctx: BandSwitcherContext, now = new Date()): Promise<void> {
  if (ctx.config.bandSwitchEnabled !== true) return;
  if (!canSwitchRadio(ctx)) return;

  const switchMode = getSwitchMode(ctx);
  const targetFrequency = switchMode === 'rotation'
    ? getRotationTargetFrequency(ctx, now)
    : getScheduledTargetFrequency(ctx, now);
  if (!targetFrequency) return;

  if (Math.abs(ctx.radio.frequency - targetFrequency) <= FREQUENCY_TOLERANCE_HZ) {
    if (switchMode === 'rotation') commitRotationTarget(ctx, targetFrequency, now);
    return;
  }

  ctx.log.info('Scheduled band switch setting radio frequency', {
    fromFrequency: ctx.radio.frequency,
    targetFrequency,
    mode: getSwitchMode(ctx),
  });
  const autoTune = await shouldAutoTuneAfterSwitch(ctx);
  await ctx.radioCommands.submit({
    type: 'switch-band',
    frequency: targetFrequency,
    autoTune,
  });
  if (switchMode === 'rotation') commitRotationTarget(ctx, targetFrequency, now);
  if (autoTune) ctx.log.info('Scheduled band switch auto tune triggered');
}

export const scheduledBandSwitcherPlugin = definePlugin({
  apiVersion: 2,
  name: 'scheduled-band-switcher',
  version: '1.0.0',
  type: 'utility',
  instanceScope: 'global',
  permissions: ['radio:read', 'radio:control', 'radio:tuner-control'],
  description: 'Switch the station radio frequency from a global schedule or rotation list',

  settings: {
    bandSwitchEnabled: {
      type: 'boolean',
      default: false,
      label: 'bandSwitchEnabled',
      description: 'bandSwitchEnabledDesc',
      scope: 'global',
    },
    bandSwitchMode: {
      type: 'string',
      default: 'schedule',
      label: 'bandSwitchMode',
      description: 'bandSwitchModeDesc',
      scope: 'global',
      options: [
        { label: 'modeSchedule', value: 'schedule' },
        { label: 'modeRotation', value: 'rotation' },
      ],
    },
    autoTuneAfterSwitchEnabled: {
      type: 'boolean',
      default: false,
      label: 'autoTuneAfterSwitchEnabled',
      description: 'autoTuneAfterSwitchEnabledDesc',
      scope: 'global',
    },
    bandScheduleEntries: {
      type: 'object[]',
      default: [],
      label: 'bandScheduleEntries',
      description: 'bandScheduleEntriesDesc',
      scope: 'global',
      visibleWhen: { setting: 'bandSwitchMode', equals: 'schedule' },
      itemFields: [
        { key: 'enabled', type: 'boolean', label: 'entryEnabled' },
        { key: 'days', type: 'string', label: 'entryDays', description: 'entryDaysDesc', placeholder: 'daily or mon-fri' },
        { key: 'startTime', type: 'string', label: 'entryStartTime', description: 'entryStartTimeDesc', placeholder: '08:00' },
        { key: 'endTime', type: 'string', label: 'entryEndTime', description: 'entryEndTimeDesc', placeholder: '10:00' },
        { key: 'frequencyMhz', type: 'number', label: 'entryFrequencyMhz', description: 'entryFrequencyMhzDesc', placeholder: '14.074' },
      ],
    },
    rotationFrequenciesMhz: {
      type: 'string[]',
      default: [],
      label: 'rotationFrequenciesMhz',
      description: 'rotationFrequenciesMhzDesc',
      scope: 'global',
      visibleWhen: { setting: 'bandSwitchMode', equals: 'rotation' },
    },
    rotationIntervalMinutes: {
      type: 'number',
      default: 30,
      label: 'rotationIntervalMinutes',
      description: 'rotationIntervalMinutesDesc',
      scope: 'global',
      min: 1,
      max: 1440,
      visibleWhen: { setting: 'bandSwitchMode', equals: 'rotation' },
    },
  },

  onLoad(ctx) {
    configureTimer(ctx);
  },

  hooks: {
    onConfigChange(_changes, ctx) {
      configureTimer(ctx);
    },
    onTimer(timerId, ctx) {
      if (timerId !== TIMER_ID) return;
      void runBandSwitchCheck(ctx).catch((error) => {
        ctx.log.error('Scheduled band switch failed', error);
      });
    },
  },
});

export const scheduledBandSwitcherLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
  ja: jaLocale,
};

export const scheduledBandSwitcherTestables = {
  getScheduledTargetFrequency,
  getRotationTargetFrequency,
  commitRotationTarget,
  isOperatorBusy,
  runBandSwitchCheck,
  shouldAutoTuneAfterSwitch,
};
