import { describe, expect, it } from 'vitest';
import type { FrameDisplayMessage } from '../../components/radio/digital/FramesTable';
import type { FrameMessage, SlotPack, SlotPackFrequencyContext } from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';
import {
  buildMyRelatedTimelineGroups,
  initialMyRelatedTimelineState,
  myRelatedTimelineReducer,
  type MyRelatedTimelineAction,
  type MyRelatedTransmissionLog,
} from '../radio/myRelatedTimeline';

const mode = MODES.FT8;

function reduce(actions: MyRelatedTimelineAction[]) {
  return actions.reduce(myRelatedTimelineReducer, initialMyRelatedTimelineState);
}

function createFrequencyContext(overrides: Partial<SlotPackFrequencyContext> = {}): SlotPackFrequencyContext {
  return {
    frequency: 14_074_000,
    band: '20m',
    mode: 'FT8',
    description: '14.074 MHz',
    ...overrides,
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
    headerContextKey: '14074000:20m:FT8',
    time: new Date(slotStartMs).toISOString().slice(11, 19).replace(/:/g, ''),
    message,
    frequency: 1250,
    slotStartMs,
    replaceExisting: true,
    frequencyContext: createFrequencyContext(),
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
      callsign: 'JA1XXX',
    },
  };
}

describe('myRelatedTimelineReducer', () => {
  it('puts matching RX into the current live layer', () => {
    const slotStartMs = Date.UTC(2026, 4, 6, 6, 28, 30);
    const state = reduce([
      {
        type: 'syncLiveContext',
        payload: {
          currentMode: mode,
          liveSlotStartMs: slotStartMs,
          visibleOperatorCallsigns: ['BG5BNW', 'BA7XYZ'],
          targetCallsign: '',
        },
      },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(slotStartMs, [
            createRxFrame('R9WXK BG5BNW -08', 1200),
            createRxFrame('BA7XYZ CQ PM01', 1400),
            createRxFrame('CQ JA1ABC PM95', 1600),
          ], createFrequencyContext()),
          currentMode: mode,
          liveSlotStartMs: slotStartMs,
          visibleOperatorCallsigns: ['BG5BNW', 'BA7XYZ'],
          targetCallsign: '',
        },
      },
    ]);

    const groups = buildMyRelatedTimelineGroups(state);
    const rxMessages = groups.flatMap(group => group.messages.filter(message => message.db !== 'TX'));

    expect(state.liveGroups).toHaveLength(1);
    expect(rxMessages.map(message => message.message)).toEqual([
      'R9WXK BG5BNW -08',
      'BA7XYZ CQ PM01',
    ]);
  });

  it('allows current selected operator targetCall to pull unmatched RX into live groups', () => {
    const slotStartMs = Date.UTC(2026, 4, 6, 6, 28, 30);
    const state = reduce([
      {
        type: 'syncLiveContext',
        payload: {
          currentMode: mode,
          liveSlotStartMs: slotStartMs,
          visibleOperatorCallsigns: ['BG5BNW'],
          targetCallsign: 'JA1XXX',
        },
      },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(slotStartMs, [
            createRxFrame('CQ JA1XXX PM95', 980),
            createRxFrame('CQ JA1ABC PM95', 1000),
          ], createFrequencyContext()),
          currentMode: mode,
          liveSlotStartMs: slotStartMs,
          visibleOperatorCallsigns: ['BG5BNW'],
          targetCallsign: 'JA1XXX',
        },
      },
    ]);

    const rxMessages = buildMyRelatedTimelineGroups(state)
      .flatMap(group => group.messages.filter(message => message.db !== 'TX'));

    expect(rxMessages.map(message => message.message)).toEqual(['CQ JA1XXX PM95']);
  });

  it('reprojects the same live cycle immediately when target context changes', () => {
    const slotStartMs = Date.UTC(2026, 4, 6, 6, 28, 30);
    const state = reduce([
      {
        type: 'syncLiveContext',
        payload: {
          currentMode: mode,
          liveSlotStartMs: slotStartMs,
          visibleOperatorCallsigns: ['BG5BNW'],
          targetCallsign: 'JA1XXX',
        },
      },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(slotStartMs, [
            createRxFrame('CQ JA1XXX PM95', 980),
            createRxFrame('CQ JA2YYY PM95', 1000),
          ], createFrequencyContext()),
          currentMode: mode,
          liveSlotStartMs: slotStartMs,
          visibleOperatorCallsigns: ['BG5BNW'],
          targetCallsign: 'JA1XXX',
        },
      },
      {
        type: 'syncLiveContext',
        payload: {
          currentMode: mode,
          liveSlotStartMs: slotStartMs,
          visibleOperatorCallsigns: ['BG5BNW'],
          targetCallsign: 'JA2YYY',
        },
      },
    ]);

    const rxMessages = buildMyRelatedTimelineGroups(state)
      .flatMap(group => group.messages.filter(message => message.db !== 'TX'));

    expect(rxMessages.map(message => message.message)).toEqual(['CQ JA2YYY PM95']);
  });

  it('freezes the previous live cycle when the next cycle starts', () => {
    const firstStart = Date.UTC(2026, 4, 6, 6, 28, 30);
    const secondStart = firstStart + mode.slotMs;
    const state = reduce([
      {
        type: 'syncLiveContext',
        payload: {
          currentMode: mode,
          liveSlotStartMs: firstStart,
          visibleOperatorCallsigns: ['BG5BNW'],
          targetCallsign: '',
        },
      },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(firstStart, [createRxFrame('R9WXK BG5BNW -08', 1200)], createFrequencyContext()),
          currentMode: mode,
          liveSlotStartMs: firstStart,
          visibleOperatorCallsigns: ['BG5BNW'],
          targetCallsign: '',
        },
      },
      {
        type: 'syncLiveContext',
        payload: {
          currentMode: mode,
          liveSlotStartMs: secondStart,
          visibleOperatorCallsigns: ['BG5BNW'],
          targetCallsign: '',
        },
      },
    ]);

    expect(state.frozenGroups).toHaveLength(1);
    expect(state.liveGroups).toHaveLength(0);
    expect(buildMyRelatedTimelineGroups(state)[0]?.messages[0]?.message).toBe('R9WXK BG5BNW -08');
  });

  it('freezes a late related RX update after the live slot has advanced', () => {
    const rr73Start = Date.UTC(2026, 4, 6, 10, 18, 45);
    const nextStart = rr73Start + mode.slotMs;
    const state = reduce([
      {
        type: 'syncLiveContext',
        payload: {
          currentMode: mode,
          liveSlotStartMs: rr73Start,
          visibleOperatorCallsigns: ['BG5DRB'],
          targetCallsign: 'JA2UCL',
        },
      },
      {
        type: 'syncLiveContext',
        payload: {
          currentMode: mode,
          liveSlotStartMs: nextStart,
          visibleOperatorCallsigns: ['BG5DRB'],
          targetCallsign: 'JA2UCL',
        },
      },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(rr73Start, [
            createRxFrame('BG5DRB JA2UCL RR73', 908, -14, 0),
            createRxFrame('CQ JA1ABC PM95', 1600),
          ], createFrequencyContext(), 2),
          currentMode: mode,
          liveSlotStartMs: nextStart,
          visibleOperatorCallsigns: ['BG5DRB'],
          targetCallsign: 'JA2UCL',
        },
      },
    ]);

    const rxMessages = buildMyRelatedTimelineGroups(state)
      .flatMap(group => group.messages.filter(message => message.db !== 'TX'));

    expect(state.frozenGroups).toHaveLength(1);
    expect(state.liveGroups).toHaveLength(0);
    expect(rxMessages.map(message => message.message)).toEqual(['BG5DRB JA2UCL RR73']);
  });

  it('ignores a late old-slot RX update when it is not related', () => {
    const oldStart = Date.UTC(2026, 4, 6, 10, 18, 45);
    const nextStart = oldStart + mode.slotMs;
    const state = reduce([
      {
        type: 'syncLiveContext',
        payload: {
          currentMode: mode,
          liveSlotStartMs: nextStart,
          visibleOperatorCallsigns: ['BG5DRB'],
          targetCallsign: 'JA2UCL',
        },
      },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(oldStart, [
            createRxFrame('JA1AAA JA2BBB RR73', 908, -14, 0),
            createTxFrame('op-1', 'JA2UCL BG5DRB 73', 2397),
          ], createFrequencyContext(), 2),
          currentMode: mode,
          liveSlotStartMs: nextStart,
          visibleOperatorCallsigns: ['BG5DRB'],
          targetCallsign: 'JA2UCL',
        },
      },
    ]);

    expect(buildMyRelatedTimelineGroups(state)).toEqual([]);
    expect(state.lastProcessedSlotPackSeq.get(`slot-${oldStart}`)).toBe(2);
  });

  it('appends newly decoded related frames from later old-slot updateSeq values without duplicating existing ones', () => {
    const oldStart = Date.UTC(2026, 4, 6, 10, 18, 45);
    const nextStart = oldStart + mode.slotMs;
    const state = reduce([
      {
        type: 'syncLiveContext',
        payload: {
          currentMode: mode,
          liveSlotStartMs: nextStart,
          visibleOperatorCallsigns: ['BG5DRB'],
          targetCallsign: 'JA2UCL',
        },
      },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(oldStart, [
            createRxFrame('BG5DRB JA2UCL -11', 908, -6, 0.1),
          ], createFrequencyContext(), 1),
          currentMode: mode,
          liveSlotStartMs: nextStart,
          visibleOperatorCallsigns: ['BG5DRB'],
          targetCallsign: 'JA2UCL',
        },
      },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(oldStart, [
            createRxFrame('BG5DRB JA2UCL -11', 908, -6, 0.1),
            createRxFrame('BG5DRB JA2UCL RR73', 908, -14, 0),
          ], createFrequencyContext(), 2),
          currentMode: mode,
          liveSlotStartMs: nextStart,
          visibleOperatorCallsigns: ['BG5DRB'],
          targetCallsign: 'JA2UCL',
        },
      },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(oldStart, [
            createRxFrame('BG5DRB JA2UCL -11', 908, -6, 0.1),
            createRxFrame('BG5DRB JA2UCL RR73', 908, -14, 0),
            createRxFrame('BG5DRB JA2UCL 73', 908, -15, 0),
            createTxFrame('op-1', 'JA2UCL BG5DRB 73', 2397),
          ], createFrequencyContext(), 3),
          currentMode: mode,
          liveSlotStartMs: nextStart,
          visibleOperatorCallsigns: ['BG5DRB'],
          targetCallsign: 'JA2UCL',
        },
      },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(oldStart, [
            createRxFrame('BG5DRB JA2UCL -11', 908, -6, 0.1),
            createRxFrame('BG5DRB JA2UCL RR73', 908, -14, 0),
            createRxFrame('BG5DRB JA2UCL 73', 908, -15, 0),
            createRxFrame('BG5DRB JA2UCL RRR', 908, -15, 0),
          ], createFrequencyContext(), 3),
          currentMode: mode,
          liveSlotStartMs: nextStart,
          visibleOperatorCallsigns: ['BG5DRB'],
          targetCallsign: 'JA2UCL',
        },
      },
    ]);

    const messages = buildMyRelatedTimelineGroups(state)
      .flatMap(group => group.messages.map(message => message.message));

    expect(messages).toEqual([
      'BG5DRB JA2UCL -11',
      'BG5DRB JA2UCL RR73',
      'BG5DRB JA2UCL 73',
    ]);
    expect(messages).not.toContain('JA2UCL BG5DRB 73');
    expect(messages).not.toContain('BG5DRB JA2UCL RRR');
    expect(state.lastProcessedSlotPackSeq.get(`slot-${oldStart}`)).toBe(3);
  });

  it('keeps TX globally visible across live and frozen layers', () => {
    const firstStart = Date.UTC(2026, 4, 6, 6, 28, 30);
    const secondStart = firstStart + mode.slotMs;
    const state = reduce([
      {
        type: 'syncLiveContext',
        payload: {
          currentMode: mode,
          liveSlotStartMs: firstStart,
          visibleOperatorCallsigns: ['BG5BNW'],
          targetCallsign: '',
        },
      },
      {
        type: 'ingestTransmissionLog',
        payload: {
          log: createTransmissionLog(firstStart, 'CQ BG5BNW PM95'),
          currentMode: mode,
          liveSlotStartMs: firstStart,
        },
      },
      {
        type: 'syncLiveContext',
        payload: {
          currentMode: mode,
          liveSlotStartMs: secondStart,
          visibleOperatorCallsigns: ['BG5BNW'],
          targetCallsign: '',
        },
      },
      {
        type: 'ingestTransmissionLog',
        payload: {
          log: createTransmissionLog(secondStart, 'CQ BA7XYZ PM01', {
            operatorId: 'op-2',
            myCallsign: 'BA7XYZ',
            frequency: 1400,
          }),
          currentMode: mode,
          liveSlotStartMs: secondStart,
        },
      },
    ]);

    const txMessages = buildMyRelatedTimelineGroups(state)
      .flatMap(group => group.messages.filter(message => message.db === 'TX'));

    expect(txMessages.map(message => message.message)).toEqual([
      'CQ BG5BNW PM95',
      'CQ BA7XYZ PM01',
    ]);
  });

  it('keeps a manual seed visible in the current cycle and then freezes it on the next cycle', () => {
    const firstStart = Date.UTC(2026, 4, 6, 6, 28, 30);
    const secondStart = firstStart + mode.slotMs;
    const frequencyContext = createFrequencyContext();
    const state = reduce([
      {
        type: 'syncLiveContext',
        payload: {
          currentMode: mode,
          liveSlotStartMs: firstStart,
          visibleOperatorCallsigns: ['BG5BNW'],
          targetCallsign: '',
        },
      },
      {
        type: 'seedSelectedRx',
        payload: {
          currentMode: mode,
          message: createSeedMessage('CQ JA1XXX PM95', 980),
          slotStartMs: firstStart,
          liveSlotStartMs: firstStart,
          frequencyContext,
        },
      },
      {
        type: 'syncLiveContext',
        payload: {
          currentMode: mode,
          liveSlotStartMs: secondStart,
          visibleOperatorCallsigns: ['BG5BNW'],
          targetCallsign: '',
        },
      },
    ]);

    const groups = buildMyRelatedTimelineGroups(state);
    expect(state.liveGroups).toHaveLength(0);
    expect(state.frozenGroups).toHaveLength(1);
    expect(groups[0]?.messages[0]?.message).toBe('CQ JA1XXX PM95');
  });

  it('dedupes a manual seed when the real slotPack echo arrives in the same cycle', () => {
    const slotStartMs = Date.UTC(2026, 4, 6, 6, 28, 30);
    const frequencyContext = createFrequencyContext();
    const state = reduce([
      {
        type: 'syncLiveContext',
        payload: {
          currentMode: mode,
          liveSlotStartMs: slotStartMs,
          visibleOperatorCallsigns: ['BG5BNW'],
          targetCallsign: '',
        },
      },
      {
        type: 'seedSelectedRx',
        payload: {
          currentMode: mode,
          message: createSeedMessage('BG5BNW JA1XXX -10', 980),
          slotStartMs,
          liveSlotStartMs: slotStartMs,
          frequencyContext,
        },
      },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack: createSlotPack(slotStartMs, [createRxFrame('BG5BNW JA1XXX -10', 1400, -17, 0.2)], frequencyContext, 2),
          currentMode: mode,
          liveSlotStartMs: slotStartMs,
          visibleOperatorCallsigns: ['BG5BNW'],
          targetCallsign: '',
        },
      },
    ]);

    const groups = buildMyRelatedTimelineGroups(state);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.messages).toHaveLength(1);
    expect(groups[0]?.messages[0]?.freq).toBe(1400);
    expect(groups[0]?.messages[0]?.db).toBe(-17);
  });

  it('restores older cycles into frozen and the latest cycle into live', () => {
    const firstStart = Date.UTC(2026, 4, 6, 6, 28, 30);
    const secondStart = firstStart + mode.slotMs;
    const state = reduce([
      { type: 'beginRestore' },
      {
        type: 'finalizeRestore',
        payload: {
          slotPacks: [
            createSlotPack(
              firstStart,
              [
                createRxFrame('R9WXK BG5BNW -08', 1200),
                createTxFrame('op-1', 'BG5BNW R9WXK RR73', 1205),
              ],
              createFrequencyContext(),
              1,
            ),
            createSlotPack(
              secondStart,
              [
                createRxFrame('CQ JA1XXX PM95', 980),
                createTxFrame('op-2', 'BA7XYZ CQ PM01', 1400),
              ],
              createFrequencyContext({ frequency: 7_074_000, band: '40m', description: '7.074 MHz' }),
              1,
            ),
          ],
          currentMode: mode,
          liveSlotStartMs: secondStart,
          visibleOperatorCallsigns: ['BG5BNW'],
          targetCallsign: 'JA1XXX',
          operatorCallsignsById: {
            'op-1': 'BG5BNW',
            'op-2': 'BA7XYZ',
          },
        },
      },
    ]);

    expect(state.frozenGroups).toHaveLength(1);
    expect(state.liveGroups).toHaveLength(1);

    const groups = buildMyRelatedTimelineGroups(state);
    const messages = groups.flatMap(group => group.messages.map(message => message.message));
    expect(messages).toEqual([
      'R9WXK BG5BNW -08',
      'BG5BNW R9WXK RR73',
      'BA7XYZ CQ PM01',
      'CQ JA1XXX PM95',
    ]);
  });

  it('clears frozen and live layers while preserving processed slot tracking', () => {
    const slotStartMs = Date.UTC(2026, 4, 6, 6, 28, 30);
    const slotPack = createSlotPack(slotStartMs, [createRxFrame('R9WXK BG5BNW -08', 1200)], createFrequencyContext(), 2);
    const state = reduce([
      {
        type: 'syncLiveContext',
        payload: {
          currentMode: mode,
          liveSlotStartMs: slotStartMs,
          visibleOperatorCallsigns: ['BG5BNW'],
          targetCallsign: '',
        },
      },
      {
        type: 'ingestSlotPack',
        payload: {
          slotPack,
          currentMode: mode,
          liveSlotStartMs: slotStartMs,
          visibleOperatorCallsigns: ['BG5BNW'],
          targetCallsign: '',
        },
      },
      { type: 'clearTimeline' },
    ]);

    expect(state.frozenGroups).toEqual([]);
    expect(state.liveGroups).toEqual([]);
    expect(state.lastProcessedSlotPackSeq.get(slotPack.slotId)).toBe(2);
  });
});
