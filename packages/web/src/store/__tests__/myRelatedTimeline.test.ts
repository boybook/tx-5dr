import { describe, expect, it } from 'vitest';
import type { FrameDisplayMessage } from '../../components/radio/digital/FramesTable';
import type { FrameMessage, SlotPack, SlotPackFrequencyContext } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import {
  buildMyRelatedTimelineGroups,
  findRecentSessionSeed,
  initialMyRelatedTimelineState,
  myRelatedTimelineReducer,
  type MyRelatedTimelineAction,
  type MyRelatedTimelineOperatorContext,
  type MyRelatedTransmissionLog,
} from '../radio/myRelatedTimeline';

const mode = MODES.FT8;

function reduce(actions: MyRelatedTimelineAction[]) {
  return actions.reduce(myRelatedTimelineReducer, initialMyRelatedTimelineState);
}

function createContext(
  overrides: Partial<MyRelatedTimelineOperatorContext> = {},
): MyRelatedTimelineOperatorContext {
  const base: MyRelatedTimelineOperatorContext = {
    operatorId: 'op-1',
    myCallsign: 'BG5BNW',
    targetCallsign: 'R9WXK',
    headerContextKey: '14_074_000:20m:FT8',
    startedAtMs: Date.UTC(2026, 4, 6, 6, 28, 30),
    frequencyContext: {
      frequency: 14_074_000,
      band: '20m',
      mode: 'FT8',
      description: '14.074 MHz',
    },
  };

  const next = {
    ...base,
    ...overrides,
  };

  if (overrides.headerContextKey) {
    return next;
  }

  const context = next.frequencyContext;
  return {
    ...next,
    headerContextKey: [
      context?.frequency ?? '',
      context?.band ?? '',
      context?.mode ?? '',
    ].join(':'),
  };
}

function createRxFrame(message: string, freq: number, snr = -10, dt = 0.1): FrameMessage {
  return {
    snr,
    dt,
    freq,
    message,
    confidence: 1,
  };
}

function createTxFrame(operatorId: string, message: string, freq: number): FrameMessage {
  return {
    snr: -999,
    dt: 0,
    freq,
    message,
    confidence: 1,
    operatorId,
  };
}

function createSlotPack(
  startMs: number,
  frames: FrameMessage[],
  frequencyContext?: SlotPackFrequencyContext,
  updateSeq = 1,
): SlotPack {
  return {
    slotId: `slot-${startMs}`,
    startMs,
    endMs: startMs + mode.slotMs,
    frames,
    stats: {
      totalDecodes: frames.length,
      successfulDecodes: frames.filter(frame => frame.snr !== -999).length,
      totalFramesBeforeDedup: frames.length,
      totalFramesAfterDedup: frames.length,
      lastUpdated: startMs,
      updateSeq,
    },
    decodeHistory: [],
    ...(frequencyContext ? { frequencyContext } : {}),
  };
}

function createTransmissionLog(
  slotStartMs: number,
  message: string,
  overrides: Partial<MyRelatedTransmissionLog> = {},
): MyRelatedTransmissionLog {
  return {
    operatorId: 'op-1',
    myCallsign: 'BG5BNW',
    headerContextKey: createContext().headerContextKey,
    time: new Date(slotStartMs).toISOString().slice(11, 19).replace(/:/g, ''),
    message,
    frequency: 1250,
    slotStartMs,
    replaceExisting: true,
    frequencyContext: createContext().frequencyContext,
    ...overrides,
  };
}

function createSeedMessage(message: string, freq: number, utc = '06:28:45'): FrameDisplayMessage {
  return {
    utc,
    db: -9,
    dt: 0.2,
    freq,
    message,
    logbookAnalysis: {
      callsign: 'R9WXK',
    },
  };
}

describe('myRelatedTimelineReducer', () => {
  it('keeps accumulating RX messages across multiple cycles in the same active session', () => {
    const startMs = Date.UTC(2026, 4, 6, 6, 28, 30);
    const secondStart = startMs + mode.slotMs;
    const context = createContext({ startedAtMs: startMs });

    const state = reduce([
      { type: 'replaceSessionContext', payload: { nextContext: context } },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(startMs, [createRxFrame('R9WXK BG5BNW -08', 1200)], context.frequencyContext),
          currentMode: mode,
        },
      },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(secondStart, [createRxFrame('BG5BNW R9WXK RR73', 1210)], context.frequencyContext),
          currentMode: mode,
        },
      },
    ]);

    const groups = buildMyRelatedTimelineGroups(state);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.messages[0]?.message).toBe('R9WXK BG5BNW -08');
    expect(groups[1]?.messages[0]?.message).toBe('BG5BNW R9WXK RR73');
    expect(state.activeSession?.groups).toHaveLength(2);
  });

  it('freezes the current RX session on frequency change and starts a new segmented session', () => {
    const startMs = Date.UTC(2026, 4, 6, 6, 28, 30);
    const secondStart = startMs + mode.slotMs;
    const firstContext = createContext({ startedAtMs: startMs });
    const secondContext = createContext({
      startedAtMs: secondStart,
      frequencyContext: {
        frequency: 7_074_000,
        band: '40m',
        mode: 'FT8',
        description: '7.074 MHz',
      },
    });

    const state = reduce([
      { type: 'replaceSessionContext', payload: { nextContext: firstContext } },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(startMs, [createRxFrame('R9WXK BG5BNW -08', 1200)], firstContext.frequencyContext),
          currentMode: mode,
        },
      },
      { type: 'replaceSessionContext', payload: { nextContext: secondContext, forceRestart: true } },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(secondStart, [createRxFrame('BG5BNW R9WXK RR73', 1210)], secondContext.frequencyContext),
          currentMode: mode,
        },
      },
    ]);

    const groups = buildMyRelatedTimelineGroups(state);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.frequencyContext).toMatchObject({ frequency: 14_074_000, band: '20m' });
    expect(groups[1]?.frequencyContext).toMatchObject({ frequency: 7_074_000, band: '40m' });
    expect(state.committedRxGroups).toHaveLength(1);
    expect(state.activeSession?.groups).toHaveLength(1);
  });

  it('seeds the selected RX immediately and dedupes the later slot pack echo', () => {
    const startMs = Date.UTC(2026, 4, 6, 6, 28, 30);
    const context = createContext({ startedAtMs: startMs });
    const seedMessage = createSeedMessage('CQ R9WXK PM95', 980);

    const state = reduce([
      {
        type: 'seedSelectedRx',
        payload: {
          context,
          currentMode: mode,
          message: seedMessage,
          slotStartMs: startMs,
          frequencyContext: context.frequencyContext,
        },
      },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(startMs, [createRxFrame('CQ R9WXK PM95', 980, -9, 0.2)], context.frequencyContext),
          currentMode: mode,
        },
      },
    ]);

    const groups = buildMyRelatedTimelineGroups(state);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.messages).toHaveLength(1);
    expect(groups[0]?.messages[0]?.message).toBe('CQ R9WXK PM95');
  });

  it('does not backfill older slot packs into a restarted RX session', () => {
    const firstStart = Date.UTC(2026, 4, 6, 6, 28, 30);
    const secondStart = firstStart + mode.slotMs;
    const firstContext = createContext({ startedAtMs: firstStart, targetCallsign: 'OLD1AA' });
    const secondContext = createContext({ startedAtMs: secondStart, targetCallsign: 'NEW2BB' });

    const state = reduce([
      { type: 'replaceSessionContext', payload: { nextContext: firstContext } },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(firstStart, [createRxFrame('OLD1AA BG5BNW -05', 1200)], firstContext.frequencyContext),
          currentMode: mode,
        },
      },
      { type: 'replaceSessionContext', payload: { nextContext: secondContext, forceRestart: true } },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(firstStart, [createRxFrame('NEW2BB BG5BNW -07', 1210)], secondContext.frequencyContext, 2),
          currentMode: mode,
        },
      },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(secondStart, [createRxFrame('NEW2BB BG5BNW -09', 1212)], secondContext.frequencyContext),
          currentMode: mode,
        },
      },
    ]);

    const groups = buildMyRelatedTimelineGroups(state);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.messages.map(message => message.message)).toEqual(['OLD1AA BG5BNW -05']);
    expect(groups[1]?.messages.map(message => message.message)).toEqual(['NEW2BB BG5BNW -09']);
  });

  it('shows a current operator CQ only through the global TX stream and does not auto-start an RX session', () => {
    const startMs = Date.UTC(2026, 4, 6, 6, 28, 30);

    const state = reduce([
      {
        type: 'ingestTransmissionLog',
        payload: {
          log: createTransmissionLog(startMs, 'CQ BG5BNW PM95', {
            replaceExisting: false,
          }),
          currentMode: mode,
        },
      },
    ]);

    const groups = buildMyRelatedTimelineGroups(state);
    expect(state.activeSession).toBeNull();
    expect(state.globalTxGroups).toHaveLength(1);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.messages.map(message => message.message)).toEqual(['CQ BG5BNW PM95']);
  });

  it('keeps only the latest TX row for the same operator and slot', () => {
    const startMs = Date.UTC(2026, 4, 6, 6, 28, 30);

    const state = reduce([
      {
        type: 'ingestTransmissionLog',
        payload: {
          log: createTransmissionLog(startMs, 'CQ BG5BNW PM95', { replaceExisting: false }),
          currentMode: mode,
        },
      },
      {
        type: 'ingestTransmissionLog',
        payload: {
          log: createTransmissionLog(startMs, 'R9WXK BG5BNW -12', { replaceExisting: false }),
          currentMode: mode,
        },
      },
    ]);

    const groups = buildMyRelatedTimelineGroups(state);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.messages.filter(message => message.db === 'TX')).toHaveLength(1);
    expect(groups[0]?.messages.find(message => message.db === 'TX')?.message).toBe('R9WXK BG5BNW -12');
  });

  it('shows TX from another operator without changing the selected operator RX session', () => {
    const startMs = Date.UTC(2026, 4, 6, 6, 28, 30);
    const context = createContext({ startedAtMs: startMs, targetCallsign: 'R9WXK' });

    const state = reduce([
      { type: 'replaceSessionContext', payload: { nextContext: context } },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(startMs, [createRxFrame('R9WXK BG5BNW -08', 1200)], context.frequencyContext),
          currentMode: mode,
        },
      },
      {
        type: 'ingestTransmissionLog',
        payload: {
          log: createTransmissionLog(startMs, 'CQ BA7XYZ PM01', {
            operatorId: 'op-2',
            myCallsign: 'BA7XYZ',
            message: 'CQ BA7XYZ PM01',
            frequency: 1400,
            replaceExisting: false,
          }),
          currentMode: mode,
        },
      },
    ]);

    const groups = buildMyRelatedTimelineGroups(state);
    const txMessages = groups.flatMap(group => group.messages.filter(message => message.db === 'TX'));
    const rxMessages = groups.flatMap(group => group.messages.filter(message => message.db !== 'TX'));

    expect(state.activeSession?.operatorId).toBe('op-1');
    expect(state.activeSession?.groups).toHaveLength(1);
    expect(txMessages.map(message => message.message)).toEqual(['CQ BA7XYZ PM01']);
    expect(txMessages[0]?.emphasisCallsigns).toEqual(['BA7XYZ']);
    expect(rxMessages.map(message => message.message)).toEqual(['R9WXK BG5BNW -08']);
  });

  it('keeps two operators TX messages in the same slot when both are present', () => {
    const startMs = Date.UTC(2026, 4, 6, 6, 28, 30);

    const state = reduce([
      {
        type: 'ingestTransmissionLog',
        payload: {
          log: createTransmissionLog(startMs, 'CQ BG5BNW PM95', {
            operatorId: 'op-1',
            myCallsign: 'BG5BNW',
            frequency: 1200,
            replaceExisting: false,
          }),
          currentMode: mode,
        },
      },
      {
        type: 'ingestTransmissionLog',
        payload: {
          log: createTransmissionLog(startMs, 'CQ BA7XYZ PM01', {
            operatorId: 'op-2',
            myCallsign: 'BA7XYZ',
            frequency: 1400,
            replaceExisting: false,
          }),
          currentMode: mode,
        },
      },
    ]);

    const groups = buildMyRelatedTimelineGroups(state);
    const txMessages = groups.flatMap(group => group.messages.filter(message => message.db === 'TX'));

    expect(txMessages).toHaveLength(2);
    expect(txMessages.map(message => message.operatorId)).toEqual(['op-1', 'op-2']);
  });

  it('keeps headerContextKey as a stable string for RX groups appended from slot packs', () => {
    const startMs = Date.UTC(2026, 4, 6, 9, 32, 15);
    const nextSlotStart = startMs + mode.slotMs;
    const context = createContext({
      startedAtMs: startMs,
      targetCallsign: 'JR4HCQ',
      frequencyContext: {
        frequency: 21_074_000,
        band: '15m',
        mode: 'FT8',
        radioMode: 'USB',
        description: '21.074 MHz 15m',
      },
    });

    const state = reduce([
      { type: 'replaceSessionContext', payload: { nextContext: context } },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(
            nextSlotStart,
            [createRxFrame('BG5BNW JR4HCQ -15', 1245)],
            {
              frequency: 21_074_000,
              band: '15m',
              mode: 'FT8',
              radioMode: 'PKTUSB',
              description: '21.074 MHz',
            },
          ),
          currentMode: mode,
        },
      },
    ]);

    const groups = buildMyRelatedTimelineGroups(state);
    expect(typeof groups[0]?.headerContextKey).toBe('string');
    expect(groups[0]?.headerContextKey).toBe('21074000:15m:FT8');
  });

  it('replaces the displayed RX row when the same slot message is refreshed with a new frequency', () => {
    const startMs = Date.UTC(2026, 4, 6, 9, 32, 30);
    const context = createContext({
      startedAtMs: startMs,
      targetCallsign: 'JA6NRG',
      frequencyContext: {
        frequency: 21_074_000,
        band: '15m',
        mode: 'FT8',
        radioMode: 'USB',
        description: '21.074 MHz 15m',
      },
    });

    const state = reduce([
      { type: 'replaceSessionContext', payload: { nextContext: context } },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(
            startMs,
            [createRxFrame('BG5BNW JA6NRG -13', 1245, -17, 0.2)],
            context.frequencyContext,
            1,
          ),
          currentMode: mode,
        },
      },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(
            startMs,
            [createRxFrame('BG5BNW JA6NRG -13', 1400, -17, 0.2)],
            context.frequencyContext,
            2,
          ),
          currentMode: mode,
        },
      },
    ]);

    const groups = buildMyRelatedTimelineGroups(state);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.messages).toHaveLength(1);
    expect(groups[0]?.messages[0]?.message).toBe('BG5BNW JA6NRG -13');
    expect(groups[0]?.messages[0]?.freq).toBe(1400);
  });

  it('restores all local TX and only the selected operator RX snapshot', () => {
    const startMs = Date.UTC(2026, 4, 6, 6, 28, 30);
    const context = createContext({ startedAtMs: startMs });
    const slotPack = createSlotPack(
      startMs,
      [
        createRxFrame('R9WXK BG5BNW -08', 1200),
        createTxFrame('op-1', 'BG5BNW R9WXK RR73', 1205),
        createTxFrame('op-2', 'BA7XYZ CQ PM01', 1400),
      ],
      context.frequencyContext,
      3,
    );

    const state = reduce([
      { type: 'replaceSessionContext', payload: { nextContext: context } },
      { type: 'beginRestore' },
      {
        type: 'finalizeRestore',
        payload: {
          slotPacks: [slotPack],
          currentMode: mode,
          context,
          operatorCallsignsById: {
            'op-1': 'BG5BNW',
            'op-2': 'BA7XYZ',
          },
        },
      },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack,
          currentMode: mode,
        },
      },
    ]);

    const groups = buildMyRelatedTimelineGroups(state);
    const txMessages = groups.flatMap(group => group.messages.filter(message => message.db === 'TX'));
    const rxMessages = groups.flatMap(group => group.messages.filter(message => message.db !== 'TX'));

    expect(state.globalTxGroups).toHaveLength(1);
    expect(state.committedRxGroups).toHaveLength(1);
    expect(state.activeSession?.groups ?? []).toHaveLength(0);
    expect(txMessages.map(message => message.message)).toEqual([
      'BG5BNW R9WXK RR73',
      'BA7XYZ CQ PM01',
    ]);
    expect(rxMessages.map(message => message.message)).toEqual(['R9WXK BG5BNW -08']);
    expect(state.lastProcessedSlotPackSeq.get(slotPack.slotId)).toBe(3);
  });

  it('keeps a short completion carryover so the peer terminal 73 is still captured after RR73', () => {
    const firstStart = Date.UTC(2026, 4, 6, 12, 3, 30);
    const secondStart = firstStart + mode.slotMs;
    const thirdStart = secondStart + mode.slotMs;
    const context = createContext({
      startedAtMs: firstStart,
      myCallsign: 'BG5DRB',
      targetCallsign: 'BI4PPP',
      frequencyContext: {
        frequency: 21_074_000,
        band: '15m',
        mode: 'FT8',
        description: '21.074 MHz',
      },
    });
    const slotPackFrequencyContext: SlotPackFrequencyContext = {
      frequency: 21_074_000,
      band: '15m',
      mode: 'FT8',
      radioMode: 'PKTUSB',
      description: '21.074 MHz 15m',
    };

    const state = reduce([
      { type: 'replaceSessionContext', payload: { nextContext: context } },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(firstStart, [createRxFrame('BG5DRB BI4PPP OM87', 1362, -1, 0.2)], slotPackFrequencyContext),
          currentMode: mode,
        },
      },
      {
        type: 'ingestTransmissionLog',
        payload: {
          log: createTransmissionLog(secondStart, 'BI4PPP BG5DRB RR73', {
            operatorId: 'op-1',
            myCallsign: 'BG5DRB',
            frequencyContext: context.frequencyContext,
          }),
          currentMode: mode,
        },
      },
      {
        type: 'freezeActiveSession',
        payload: {
          reason: 'qso-complete',
          carryUntilMs: thirdStart + mode.slotMs,
        },
      },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(thirdStart, [createRxFrame('BG5DRB BI4PPP 73', 1362, -6, 0.1)], slotPackFrequencyContext),
          currentMode: mode,
        },
      },
    ]);

    const groups = buildMyRelatedTimelineGroups(state);
    const rxMessages = groups.flatMap(group => group.messages.filter(message => message.db !== 'TX'));

    expect(state.activeSession).toBeNull();
    expect(rxMessages.map(message => message.message)).toEqual([
      'BG5DRB BI4PPP OM87',
      'BG5DRB BI4PPP 73',
    ]);
  });

  it('drops the completion carryover once a new session starts', () => {
    const firstStart = Date.UTC(2026, 4, 6, 12, 3, 30);
    const secondStart = firstStart + mode.slotMs;
    const thirdStart = secondStart + mode.slotMs;
    const firstContext = createContext({
      startedAtMs: firstStart,
      myCallsign: 'BG5DRB',
      targetCallsign: 'BI4PPP',
    });
    const secondContext = createContext({
      startedAtMs: secondStart,
      myCallsign: 'BG5DRB',
      targetCallsign: 'JA1AAA',
    });

    const state = reduce([
      { type: 'replaceSessionContext', payload: { nextContext: firstContext } },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(firstStart, [createRxFrame('BG5DRB BI4PPP OM87', 1362, -1, 0.2)], firstContext.frequencyContext),
          currentMode: mode,
        },
      },
      {
        type: 'freezeActiveSession',
        payload: {
          reason: 'qso-complete',
          carryUntilMs: thirdStart + mode.slotMs,
        },
      },
      { type: 'replaceSessionContext', payload: { nextContext: secondContext, forceRestart: true } },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(thirdStart, [createRxFrame('BG5DRB BI4PPP 73', 1362, -6, 0.1)], firstContext.frequencyContext),
          currentMode: mode,
        },
      },
    ]);

    expect(state.activeSession?.targetCallsign).toBe('JA1AAA');
    expect(state.completedSessionCarryover).toBeNull();
  });

  it('does not restart the active session when only radioMode or description changes', () => {
    const startMs = Date.UTC(2026, 4, 6, 12, 3, 30);
    const initialContext = createContext({
      startedAtMs: startMs,
      myCallsign: 'BG5DRB',
      targetCallsign: 'JQ7CLL',
      frequencyContext: {
        frequency: 7_074_000,
        band: '40m',
        mode: 'FT8',
        radioMode: 'USB',
        description: '7.074 MHz',
      },
    });
    const updatedContext = createContext({
      ...initialContext,
      frequencyContext: {
        frequency: 7_074_000,
        band: '40m',
        mode: 'FT8',
        radioMode: 'PKTUSB',
        description: '7.074 MHz 40m',
      },
    });

    const state = reduce([
      { type: 'replaceSessionContext', payload: { nextContext: initialContext } },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(startMs, [createRxFrame('BG5DRB JQ7CLL QM07', 1846, -14, -1.0)], updatedContext.frequencyContext),
          currentMode: mode,
        },
      },
      { type: 'replaceSessionContext', payload: { nextContext: updatedContext } },
    ]);

    expect(state.committedRxGroups).toHaveLength(0);
    expect(state.activeSession?.groups).toHaveLength(1);
    expect(state.activeSession?.frequencyContext).toMatchObject({
      frequency: 7_074_000,
      band: '40m',
      mode: 'FT8',
      radioMode: 'PKTUSB',
      description: '7.074 MHz 40m',
    });
  });

  it('finds the latest inbound direct-call seed when a target session auto-starts after the decode slot', () => {
    const previousSlotStart = Date.UTC(2026, 4, 6, 6, 28, 30);
    const currentSlotStart = previousSlotStart + mode.slotMs;
    const context = createContext({
      startedAtMs: currentSlotStart,
      myCallsign: 'BG5DRB',
      targetCallsign: 'UN3QA',
    });

    const seed = findRecentSessionSeed(
      [
        createSlotPack(
          previousSlotStart,
          [
            createRxFrame('CQ UN3QA LO91', 1845, -18, 0.1),
            createRxFrame('BG5DRB UN3QA -17', 1851, -20, -0.1),
          ],
          context.frequencyContext,
          2,
        ),
      ],
      context,
      mode,
    );

    expect(seed?.slotStartMs).toBe(previousSlotStart);
    expect(seed?.message.message).toBe('BG5DRB UN3QA -17');
    expect(seed?.message.freq).toBe(1851);
  });

  it('does not auto-seed stale history outside the recent lookback window', () => {
    const oldSlotStart = Date.UTC(2026, 4, 6, 6, 28, 30);
    const currentSlotStart = oldSlotStart + mode.slotMs * 3;
    const context = createContext({
      startedAtMs: currentSlotStart,
      myCallsign: 'BG5DRB',
      targetCallsign: 'UN3QA',
    });

    const seed = findRecentSessionSeed(
      [
        createSlotPack(
          oldSlotStart,
          [createRxFrame('BG5DRB UN3QA -17', 1851, -20, -0.1)],
          context.frequencyContext,
          1,
        ),
      ],
      context,
      mode,
    );

    expect(seed).toBeNull();
  });
});
