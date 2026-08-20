import { describe, expect, it } from 'vitest';
import { createMockContext } from '@tx5dr/plugin-api/testing';
import type { PluginRadioCommand } from '@tx5dr/plugin-api';
import type { CapabilityList } from '@tx5dr/contracts';
import { scheduledBandSwitcherTestables } from './index.js';

function createTunerCapabilitySnapshot(options: {
  tunerEnabled?: boolean;
  switchSupported?: boolean;
  tuneSupported?: boolean;
  switchAvailability?: 'available' | 'unavailable' | 'unknown';
  tuneAvailability?: 'available' | 'unavailable' | 'unknown';
} = {}): CapabilityList {
  return {
    descriptors: [
      {
        id: 'tuner_switch',
        category: 'antenna',
        valueType: 'boolean',
        readable: true,
        writable: true,
        updateMode: 'polling',
        labelI18nKey: 'radio:capability.tuner_switch.label',
        hasSurfaceControl: true,
      },
      {
        id: 'tuner_tune',
        category: 'antenna',
        valueType: 'action',
        readable: false,
        writable: true,
        updateMode: 'none',
        labelI18nKey: 'radio:capability.tuner_tune.label',
        hasSurfaceControl: true,
      },
    ],
    capabilities: [
      {
        id: 'tuner_switch',
        supported: options.switchSupported ?? true,
        availability: options.switchAvailability ?? 'available',
        value: options.tunerEnabled ?? false,
        updatedAt: 123,
      },
      {
        id: 'tuner_tune',
        supported: options.tuneSupported ?? true,
        availability: options.tuneAvailability ?? 'available',
        value: null,
        updatedAt: 123,
      },
    ],
  };
}

describe('scheduled-band-switcher', () => {
  it('selects a frequency from an active schedule window', () => {
    const ctx = createMockContext({
      permissions: ['radio:read', 'radio:control', 'radio:tuner-control'],
      config: {
        bandScheduleEntries: [
          { enabled: true, days: 'thu', startTime: '08:00', endTime: '10:00', frequencyMhz: 14.074 },
        ],
      },
    });
    expect(scheduledBandSwitcherTestables.getScheduledTargetFrequency(ctx, new Date(2026, 0, 1, 9, 0))).toBe(14_074_000);
  });

  it('rotates through configured frequencies by interval', () => {
    const ctx = createMockContext({
      permissions: ['radio:read', 'radio:control', 'radio:tuner-control'],
      config: { rotationFrequenciesMhz: ['14.074', '7.074'], rotationIntervalMinutes: 30 },
    });
    const first = new Date(2026, 0, 1, 8, 0);
    expect(scheduledBandSwitcherTestables.getRotationTargetFrequency(ctx, first)).toBe(14_074_000);
    scheduledBandSwitcherTestables.commitRotationTarget(ctx, 14_074_000, first);
    expect(scheduledBandSwitcherTestables.getRotationTargetFrequency(ctx, new Date(2026, 0, 1, 8, 10))).toBeNull();
    expect(scheduledBandSwitcherTestables.getRotationTargetFrequency(ctx, new Date(2026, 0, 1, 8, 31))).toBe(7_074_000);
  });

  it('does not advance rotation state when the host rejects a busy radio', async () => {
    const ctx = createMockContext({
      permissions: ['radio:read', 'radio:control', 'radio:tuner-control'],
      config: {
        bandSwitchEnabled: true,
        bandSwitchMode: 'rotation',
        rotationFrequenciesMhz: ['14.074', '7.074'],
        rotationIntervalMinutes: 30,
      },
      radio: { frequency: 3_573_000, isConnected: true },
      radioCommands: { submit: async () => { throw new Error('physical transmitter is active'); } },
      operator: { getOtherOperators: () => [] },
    });
    const now = new Date(2026, 0, 1, 8, 0);

    await expect(scheduledBandSwitcherTestables.runBandSwitchCheck(ctx, now))
      .rejects.toThrow('physical transmitter is active');
    expect(scheduledBandSwitcherTestables.getRotationTargetFrequency(ctx, now)).toBe(14_074_000);
  });

  it('skips frequency changes while an operator is busy', async () => {
    const commands: PluginRadioCommand[] = [];
    const ctx = createMockContext({
      permissions: ['radio:read', 'radio:control', 'radio:tuner-control'],
      config: {
        bandSwitchEnabled: true,
        bandSwitchMode: 'schedule',
        bandScheduleEntries: [
          { enabled: true, days: 'thu', startTime: '08:00', endTime: '10:00', frequencyMhz: 14.074 },
        ],
      },
      radio: { frequency: 7_074_000, isConnected: true },
      radioCommands: { submit: async (command) => { commands.push(command); } },
      operator: {
        getOtherOperators: () => [{
          id: 'op-1',
          callsign: 'BG5DRB',
          grid: 'OL32',
          audioFrequencyHz: 1500,
          mode: { name: 'FT8', slotMs: 15000, toleranceMs: 100, windowTiming: [12000], transmitTiming: 1180, encodeAdvance: 400 },
          isTransmitting: true,
          transmitCycles: [0],
        }],
      },
    });

    await scheduledBandSwitcherTestables.runBandSwitchCheck(ctx, new Date(2026, 0, 1, 9, 0));
    expect(commands).toEqual([]);
  });

  it('sets the radio frequency when idle and connected', async () => {
    const commands: PluginRadioCommand[] = [];
    const ctx = createMockContext({
      permissions: ['radio:read', 'radio:control', 'radio:tuner-control'],
      config: {
        bandSwitchEnabled: true,
        bandSwitchMode: 'schedule',
        bandScheduleEntries: [
          { enabled: true, days: 'thu', startTime: '08:00', endTime: '10:00', frequencyMhz: 14.074 },
        ],
      },
      radio: { frequency: 7_074_000, isConnected: true },
      radioCommands: { submit: async (command) => { commands.push(command); } },
      operator: { getOtherOperators: () => [] },
    });

    await scheduledBandSwitcherTestables.runBandSwitchCheck(ctx, new Date(2026, 0, 1, 9, 0));
    expect(commands).toEqual([{ type: 'switch-band', frequency: 14_074_000, autoTune: false }]);
  });

  it('enables the tuner and triggers one tune after a successful switch when configured', async () => {
    const commands: PluginRadioCommand[] = [];
    const snapshot = createTunerCapabilitySnapshot({ tunerEnabled: false });
    const ctx = createMockContext({
      permissions: ['radio:read', 'radio:control', 'radio:tuner-control'],
      config: {
        bandSwitchEnabled: true,
        bandSwitchMode: 'schedule',
        autoTuneAfterSwitchEnabled: true,
        bandScheduleEntries: [
          { enabled: true, days: 'thu', startTime: '08:00', endTime: '10:00', frequencyMhz: 14.074 },
        ],
      },
      radio: {
        frequency: 7_074_000,
        isConnected: true,
      },
      radioCapabilities: {
        getSnapshot: () => snapshot,
        getState: (id) => snapshot.capabilities.find((capability) => capability.id === id) ?? null,
        refresh: async () => snapshot,
      },
      radioCommands: { submit: async (command) => { commands.push(command); } },
      operator: { getOtherOperators: () => [] },
    });

    await scheduledBandSwitcherTestables.runBandSwitchCheck(ctx, new Date(2026, 0, 1, 9, 0));

    expect(commands).toEqual([{ type: 'switch-band', frequency: 14_074_000, autoTune: true }]);
  });

  it('skips auto tuning when tuner capabilities are unavailable', async () => {
    const commands: PluginRadioCommand[] = [];
    const snapshot = createTunerCapabilitySnapshot({ tuneSupported: false });
    const ctx = createMockContext({
      permissions: ['radio:read', 'radio:control', 'radio:tuner-control'],
      config: {
        bandSwitchEnabled: true,
        bandSwitchMode: 'schedule',
        autoTuneAfterSwitchEnabled: true,
        bandScheduleEntries: [
          { enabled: true, days: 'thu', startTime: '08:00', endTime: '10:00', frequencyMhz: 14.074 },
        ],
      },
      radio: {
        frequency: 7_074_000,
        isConnected: true,
      },
      radioCapabilities: {
        getSnapshot: () => snapshot,
        getState: (id) => snapshot.capabilities.find((capability) => capability.id === id) ?? null,
        refresh: async () => snapshot,
      },
      radioCommands: { submit: async (command) => { commands.push(command); } },
      operator: { getOtherOperators: () => [] },
    });

    await scheduledBandSwitcherTestables.runBandSwitchCheck(ctx, new Date(2026, 0, 1, 9, 0));

    expect(commands).toEqual([{ type: 'switch-band', frequency: 14_074_000, autoTune: false }]);
  });

  it('does not auto tune when no frequency switch is needed', async () => {
    const commands: PluginRadioCommand[] = [];
    const snapshot = createTunerCapabilitySnapshot();
    const ctx = createMockContext({
      permissions: ['radio:read', 'radio:control', 'radio:tuner-control'],
      config: {
        bandSwitchEnabled: true,
        bandSwitchMode: 'schedule',
        autoTuneAfterSwitchEnabled: true,
        bandScheduleEntries: [
          { enabled: true, days: 'thu', startTime: '08:00', endTime: '10:00', frequencyMhz: 14.074 },
        ],
      },
      radio: {
        frequency: 14_074_000,
        isConnected: true,
      },
      radioCapabilities: {
        getSnapshot: () => snapshot,
        getState: (id) => snapshot.capabilities.find((capability) => capability.id === id) ?? null,
        refresh: async () => snapshot,
      },
      radioCommands: { submit: async (command) => {
        commands.push(command);
      } },
      operator: { getOtherOperators: () => [] },
    });

    await scheduledBandSwitcherTestables.runBandSwitchCheck(ctx, new Date(2026, 0, 1, 9, 0));

    expect(commands).toEqual([]);
  });
});
