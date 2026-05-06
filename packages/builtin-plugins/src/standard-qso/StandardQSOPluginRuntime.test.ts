import { describe, expect, it, vi } from 'vitest';
import { MODES, type FrameMessage, type OperatorConfig, type SlotInfo } from '@tx5dr/contracts';
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


describe('StandardQSOPluginRuntime nonstandard callsign slots', () => {
  it('keeps 23-character RR73 and R-report messages for compound callsigns', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator());

    runtime.patchContext({
      targetCallsign: 'VA7CD/DU7',
      reportSent: -9,
    });
    runtime.updateSlots();

    expect(runtime.getSnapshot().slots).toMatchObject({
      TX1: '<VA7CD/DU7> BG5DRB -09',
      TX2: '<VA7CD/DU7> BG5DRB -09',
      TX3: '<VA7CD/DU7> BG5DRB R-09',
      TX4: '<VA7CD/DU7> BG5DRB RR73',
      TX5: '<VA7CD/DU7> BG5DRB 73',
    });
  });

  it('responds to a compound-callsign R-report with RR73 instead of RRR', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator());
    const message: FrameMessage = {
      snr: -9,
      freq: 1150,
      dt: 0,
      message: 'BG5DRB <VA7CD/DU7> R-17',
      confidence: 1,
    };
    const slotInfo: SlotInfo = {
      id: 'slot-1',
      startMs: 0,
      phaseMs: 0,
      driftMs: 0,
      cycleNumber: 0,
      utcSeconds: 0,
      mode: 'FT8',
    };

    runtime.requestCall('VA7CD/DU7', { message, slotInfo });

    const snapshot = runtime.getSnapshot();
    expect(snapshot.currentState).toBe('TX4');
    expect(snapshot.slots?.TX4).toBe('<VA7CD/DU7> BG5DRB RR73');
  });
});
