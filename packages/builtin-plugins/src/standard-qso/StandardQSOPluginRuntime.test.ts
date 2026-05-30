import { describe, expect, it, vi } from 'vitest';
import { MODES, type FrameMessage, type OperatorConfig, type ParsedFT8Message, type SlotInfo } from '@tx5dr/contracts';
import { FT8MessageParser } from '@tx5dr/core';
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

function createParsedMessage(rawMessage: string, overrides: Partial<ParsedFT8Message> = {}): ParsedFT8Message {
  return {
    snr: -10,
    dt: 0,
    df: 1500,
    rawMessage,
    message: FT8MessageParser.parseMessage(rawMessage),
    slotId: 'slot-test',
    timestamp: 0,
    ...overrides,
  };
}

describe('StandardQSOPluginRuntime TX6 override', () => {
  it('omits the TX6 grid for compound CQ callsigns by default', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator({
      myCallsign: 'BG7KEO/QRP',
      myGrid: 'OL62',
    }));

    expect(runtime.getSnapshot().slots?.TX6).toBe('CQ BG7KEO/QRP');
  });

  it('regenerates compound CQ TX6 without a grid unless TX6 has a manual override', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator({
      myCallsign: 'BG7KEO/QRP',
      myGrid: 'OL62',
    }));

    runtime.patchContext({
      targetCallsign: 'JA1AAA',
      targetGrid: 'PM95',
      reportSent: -12,
    });
    runtime.updateSlots();

    expect(runtime.getSnapshot().slots?.TX6).toBe('CQ BG7KEO/QRP');

    runtime.setSlotContent({ slot: 'TX6', content: 'CQ TEST BG7KEO/QRP' });
    runtime.patchContext({
      targetCallsign: 'VK2ABC',
      targetGrid: 'QF56',
      reportSent: -7,
    });
    runtime.updateSlots();

    expect(runtime.getSnapshot().slots?.TX6).toBe('CQ TEST BG7KEO/QRP');
  });

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
  it('uses RR73 for special event callsigns when the structured reply fits FT8 text length', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator({ myCallsign: 'BG7WJH' }));

    runtime.patchContext({
      targetCallsign: 'LZ370TL',
      reportSent: -9,
    });
    runtime.updateSlots();

    expect(runtime.getSnapshot().slots).toMatchObject({
      TX1: '<LZ370TL> BG7WJH OL32',
      TX2: '<LZ370TL> BG7WJH -09',
      TX3: '<LZ370TL> BG7WJH R-09',
      TX4: '<LZ370TL> BG7WJH RR73',
      TX5: '<LZ370TL> BG7WJH 73',
    });
  });

  it('keeps RR73 for special event callsigns that exceed the old 22-character guard', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator());

    runtime.patchContext({
      targetCallsign: 'SX100PAOK',
      reportSent: -9,
    });
    runtime.updateSlots();

    expect(runtime.getSnapshot().slots).toMatchObject({
      TX1: '<SX100PAOK> BG5DRB OL32',
      TX2: '<SX100PAOK> BG5DRB -09',
      TX3: '<SX100PAOK> BG5DRB R-09',
      TX4: '<SX100PAOK> BG5DRB RR73',
      TX5: '<SX100PAOK> BG5DRB 73',
    });
  });

  it('keeps 23-character RR73 and R-report messages for compound callsigns', () => {
    const runtime = new StandardQSOPluginRuntime(createOperator());

    runtime.patchContext({
      targetCallsign: 'VA7CD/DU7',
      reportSent: -9,
    });
    runtime.updateSlots();

    expect(runtime.getSnapshot().slots).toMatchObject({
      TX1: '<VA7CD/DU7> BG5DRB OL32',
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

  it('advances from TX3 when Fox/Hound RR73 completes my callsign', async () => {
    const operator = createOperator({ myCallsign: 'BD4XYR', myGrid: 'OM89' });
    const runtime = new StandardQSOPluginRuntime(operator);
    const rawMessage = 'BD4XYR RR73; JH1UBK <EX8ABR> -24';
    const parsedMessage = createParsedMessage(rawMessage, { slotId: 'slot-fox-rr73' });

    runtime.patchContext({
      targetCallsign: 'EX8ABR',
      reportSent: -24,
      reportReceived: -10,
    });
    runtime.setState('TX3');

    await runtime.decide([parsedMessage]);

    const snapshot = runtime.getSnapshot();
    expect(snapshot.currentState).toBe('TX5');
    expect(snapshot.slots?.TX5).toBe('EX8ABR BD4XYR 73');
    expect(operator.recordQSOLog).toHaveBeenCalledWith(expect.objectContaining({
      callsign: 'EX8ABR',
      myCallsign: 'BD4XYR',
    }));
  });

  it('advances from TX3 when a portable Fox/Hound RR73 is clipped after the Fox callsign', async () => {
    const operator = createOperator({ myCallsign: 'BH5HIE', myGrid: 'PM00' });
    const runtime = new StandardQSOPluginRuntime(operator);
    const rawMessage = 'BH5HIE RR73; JH5FVT <EX8ABR/P';
    const parsedMessage = createParsedMessage(rawMessage, { snr: -12, slotId: 'slot-fox-rr73-clipped' });

    runtime.patchContext({
      targetCallsign: 'EX8ABR',
      reportSent: -16,
      reportReceived: -12,
    });
    runtime.setState('TX3');

    await runtime.decide([parsedMessage]);

    const snapshot = runtime.getSnapshot();
    expect(snapshot.currentState).toBe('TX5');
    expect(snapshot.slots?.TX5).toBe('EX8ABR BH5HIE 73');
    expect(operator.recordQSOLog).toHaveBeenCalledWith(expect.objectContaining({
      callsign: 'EX8ABR',
      myCallsign: 'BH5HIE',
    }));
  });

  it('matches a portable Fox callsign response against a base target callsign', async () => {
    const operator = createOperator({ myCallsign: 'BH5HIE', myGrid: 'PM00' });
    const runtime = new StandardQSOPluginRuntime(operator);
    const rawMessage = 'BH5HIE EX8ABR/P +02';
    const parsedMessage = createParsedMessage(rawMessage, { snr: -16, slotId: 'slot-portable-report' });

    runtime.patchContext({
      targetCallsign: 'EX8ABR',
      reportSent: -14,
    });
    runtime.setState('TX1');

    await runtime.decide([parsedMessage]);

    const snapshot = runtime.getSnapshot();
    expect(snapshot.currentState).toBe('TX3');
    expect(snapshot.slots?.TX3).toBe('EX8ABR/P BH5HIE R-16');
    expect(snapshot.context?.targetCallsign).toBe('EX8ABR/P');
    expect(snapshot.context?.reportReceived).toBe(2);
    expect(snapshot.context?.reportSent).toBe(-16);
  });
});
