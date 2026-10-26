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
  type ScheduleTime,
} from '../_shared/schedule-utils.js';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };
import jaLocale from './locales/ja.json' with { type: 'json' };

const TIMER_ID = 'scheduled-band-switcher';
/** A tick only acts on an open window start or a pending retry; idle ticks do no I/O. */
const TIMER_INTERVAL_MS = 5_000;
/** A new check waits for the previous one, including auto tune, to settle. */
const CHECK_LEASE_MS = 90_000;
const ROTATION_STATE_KEY = 'rotationState';
const SCHEDULE_APPLIED_KEY = 'scheduleAppliedWindow';
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
/** One matched schedule window occurrence and the frequency it demands. */
type ScheduleTarget = {
  frequency: number;
  windowKey: string;
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

function getWindowStartMs(now: Date, start: ScheduleTime): number {
  const windowStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    start.hour,
    start.minute,
    0,
    0,
  );
  // An active overnight window began on the previous day.
  if (windowStart.getTime() > now.getTime()) {
    windowStart.setDate(windowStart.getDate() - 1);
  }
  return windowStart.getTime();
}

/**
 * Resolves the first matching schedule window and the identity of that window
 * occurrence, so one-shot switching can tell a running window from a new one.
 */
function getScheduledTarget(ctx: BandSwitcherContext, now = new Date()): ScheduleTarget | null {
  for (const [index, row] of getScheduleEntries(ctx.config.bandScheduleEntries).entries()) {
    if (row.enabled === false) continue;
    const days = parseScheduleDays(row.days);
    const start = parseScheduleTime(row.startTime);
    const end = parseScheduleTime(row.endTime);
    const frequency = normalizeFrequencyMhzToHz(row.frequencyMhz);
    if (!days || !start || !end || !frequency) continue;
    if (!isScheduleDayActive(days, now) || !isTimeInScheduleRange(now, start, end)) continue;
    return {
      frequency,
      windowKey: `${index}|${frequency}|${getWindowStartMs(now, start)}`,
    };
  }
  return null;
}

function keepsScheduleFrequency(ctx: BandSwitcherContext): boolean {
  return ctx.config.keepScheduleFrequency === true;
}

function getAppliedWindow(ctx: BandSwitcherContext): string {
  const value = ctx.store.global.get<string>(SCHEDULE_APPLIED_KEY, '');
  return typeof value === 'string' ? value : '';
}

function markAppliedWindow(ctx: BandSwitcherContext, windowKey: string): void {
  ctx.store.global.set(SCHEDULE_APPLIED_KEY, windowKey);
}

/** Forgets the applied window so re-enabling the switcher applies it again. */
function clearAppliedWindow(ctx: BandSwitcherContext): void {
  ctx.store.global.set(SCHEDULE_APPLIED_KEY, undefined);
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

async function switchRadioTo(
  ctx: BandSwitcherContext,
  targetFrequency: number,
  mode: SwitchMode,
): Promise<void> {
  ctx.log.info('Scheduled band switch setting radio frequency', {
    fromFrequency: ctx.radio.frequency,
    targetFrequency,
    mode,
  });
  const autoTune = await shouldAutoTuneAfterSwitch(ctx);
  await ctx.radioCommands.submit({
    type: 'switch-band',
    frequency: targetFrequency,
    autoTune,
  });
  if (autoTune) ctx.log.info('Scheduled band switch auto tune triggered');
}

/**
 * Holds the radio on the target for as long as the window is open; a switch
 * rejected by the Host stays unmarked and is retried on the next tick.
 */
async function runHeldScheduleWindow(ctx: BandSwitcherContext, target: ScheduleTarget): Promise<void> {
  if (!canSwitchRadio(ctx)) return;
  if (Math.abs(ctx.radio.frequency - target.frequency) <= FREQUENCY_TOLERANCE_HZ) return;
  await switchRadioTo(ctx, target.frequency, 'schedule');
}

/**
 * Switches once when a window opens and then leaves the radio to the operator
 * until the next window, so a deliberate retune is never reverted.
 */
async function runOneShotScheduleWindow(ctx: BandSwitcherContext, target: ScheduleTarget): Promise<void> {
  if (getAppliedWindow(ctx) === target.windowKey) return;
  if (!canSwitchRadio(ctx)) return;
  if (Math.abs(ctx.radio.frequency - target.frequency) > FREQUENCY_TOLERANCE_HZ) {
    await switchRadioTo(ctx, target.frequency, 'schedule');
  }
  // Only a settled Host command marks the window, so a busy or failing radio is retried.
  markAppliedWindow(ctx, target.windowKey);
}

async function runRotationCheck(ctx: BandSwitcherContext, now: Date): Promise<void> {
  if (!canSwitchRadio(ctx)) return;

  const targetFrequency = getRotationTargetFrequency(ctx, now);
  if (!targetFrequency) return;

  if (Math.abs(ctx.radio.frequency - targetFrequency) <= FREQUENCY_TOLERANCE_HZ) {
    commitRotationTarget(ctx, targetFrequency, now);
    return;
  }

  await switchRadioTo(ctx, targetFrequency, 'rotation');
  commitRotationTarget(ctx, targetFrequency, now);
}

async function runScheduleCheck(ctx: BandSwitcherContext, now: Date): Promise<void> {
  const target = getScheduledTarget(ctx, now);
  if (!target) return;
  if (keepsScheduleFrequency(ctx)) {
    await runHeldScheduleWindow(ctx, target);
    return;
  }
  await runOneShotScheduleWindow(ctx, target);
}

let activeCheckStartedAt = 0;

/** Prevents the shorter timer from stacking commands while a switch or auto tune is running. */
function acquireCheckLease(ctx: BandSwitcherContext): boolean {
  const nowMs = Date.now();
  if (activeCheckStartedAt > 0 && nowMs - activeCheckStartedAt < CHECK_LEASE_MS) {
    ctx.log.debug('Scheduled band switch check skipped because the previous check is still running');
    return false;
  }
  activeCheckStartedAt = nowMs;
  return true;
}

async function runBandSwitchCheck(ctx: BandSwitcherContext, now = new Date()): Promise<void> {
  if (ctx.config.bandSwitchEnabled !== true) return;
  if (!acquireCheckLease(ctx)) return;

  try {
    if (getSwitchMode(ctx) === 'rotation') {
      await runRotationCheck(ctx, now);
      return;
    }
    await runScheduleCheck(ctx, now);
  } finally {
    activeCheckStartedAt = 0;
  }
}

export const scheduledBandSwitcherPlugin = definePlugin({
  apiVersion: 2,
  name: 'scheduled-band-switcher',
  version: '1.1.0',
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
    keepScheduleFrequency: {
      type: 'boolean',
      default: false,
      label: 'keepScheduleFrequency',
      description: 'keepScheduleFrequencyDesc',
      scope: 'global',
      visibleWhen: { setting: 'bandSwitchMode', equals: 'schedule' },
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
    onConfigChange(changes, ctx) {
      configureTimer(ctx);
      if (changes.bandSwitchEnabled !== true) {
        clearAppliedWindow(ctx);
      }
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
  getScheduledTarget,
  getAppliedWindow,
  markAppliedWindow,
  getRotationTargetFrequency,
  commitRotationTarget,
  isOperatorBusy,
  runBandSwitchCheck,
  shouldAutoTuneAfterSwitch,
};
