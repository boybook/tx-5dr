import { describe, expect, it, vi } from 'vitest';
import { MODES, type OperatorConfig } from '@tx5dr/contracts';
import {
  StandardQSOPluginRuntime,
  type StandardQSOPluginOperator,
} from './StandardQSOPluginRuntime.js';

function createOperator(overrides: Partial<OperatorConfig> = {}): StandardQSOPluginOperator {
  const config: OperatorConfig = {
    id: 'operator-1',
    mode: MODES.FT8,
    myCallsign: 'BG5DRB',
    myGrid: 'OL32',
    frequency: 7074000,
    transmitCycles: [0],
    autoReplyToCQ: false,
    autoResumeCQAfterFail: false,
    autoResumeCQAfterSuccess: false,
    replyToWorkedStations: false,
    prioritizeNewCalls: true,
    targetSelectionPriorityMode: 'dxcc_first',
    maxQSOTimeoutCycles: 6,
    maxCallAttempts: 5,
    ...overrides,
  };

  return {
    get config() {
      return config;
    },
    hasWorkedCallsign: vi.fn(async () => false),
    isTargetBeingWorkedByOthers: vi.fn(() => false),
    recordQSOLog: vi.fn(),
    notifySlotsUpdated: vi.fn(),
    notifyStateChanged: vi.fn(),
  };
}

describe('StandardQSOPluginRuntime TX6 override', () => {
  it('keeps a manually edited TX6 message across slot regeneration', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator());

    runtime.setSlotContent({ slot: 'TX6', content: 'CQ DX BG5DRB OL32' });
    runtime.patchContext({
      targetCallsign: 'JA1AAA',
      targetGrid: 'PM95',
      reportSent: -12,
    });
    runtime.updateSlots();

    expect(runtime.getSnapshot().slots?.TX6).toBe('CQ DX BG5DRB OL32');
  });

  it('clears the override when TX6 is emptied', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator());

    runtime.setSlotContent({ slot: 'TX6', content: 'CQ TEST BG5DRB OL32' });
    runtime.setSlotContent({ slot: 'TX6', content: '' });

    expect(runtime.getSnapshot().slots?.TX6).toBe('CQ BG5DRB OL32');
  });

  it('clears the override when TX6 matches the generated default CQ', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator());

    runtime.setSlotContent({ slot: 'TX6', content: 'CQ POTA BG5DRB OL32' });
    runtime.setSlotContent({ slot: 'TX6', content: 'CQ BG5DRB OL32' });
    runtime.updateSlots();

    expect(runtime.getSnapshot().slots?.TX6).toBe('CQ BG5DRB OL32');
  });
});
