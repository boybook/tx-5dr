import { describe, expect, it } from 'vitest';
import type { StrategyMessagePresentationProjection } from '@tx5dr/contracts';
import {
  resolveStrategyMessagePresentationClass,
  type FrameDisplayMessage,
  type FrameGroup,
} from '../FramesTable';
import { resolveFrameRowPresentation } from '../frameRowPresentation';

const projection: StrategyMessagePresentationProjection = {
  revision: 1,
  mode: 'replace-logbook',
  subject: 'sender-callsign',
  partitionBy: 'band',
  eligiblePartitions: ['20M', '40M'],
  defaultClass: 'new',
  classes: {
    field: {
      badges: [{ label: 'contestNewGridField', tone: 'secondary' }],
      row: { tone: 'secondary', background: 'soft', accent: true },
      emphasisWhen: [{ firstTokenIn: ['CQ'] }, { anyTokenIn: ['RR73', 'RRR', '73'] }],
    },
    new: {
      badges: [{ label: 'contestNewCallsign', tone: 'warning' }],
      row: { tone: 'warning', background: 'soft', accent: true },
      emphasisWhen: [{ firstTokenIn: ['CQ'] }, { anyTokenIn: ['RR73', 'RRR', '73'] }],
    },
    worked: { textDecoration: 'line-through', opacity: 'muted' },
  },
  assignments: [{ subject: 'JA1AAA', partition: '20M', classId: 'worked' }],
  noveltyRules: [{ fact: 'grid-field-2', knownValuesByPartition: { '40M': ['PM'] }, classId: 'field' }],
};

function message(text = 'CQ JA1AAA PM95', grid = 'PM95'): FrameDisplayMessage {
  return { utc: '12:00:00', db: -10, dt: 0.1, freq: 1200, message: text, locationGrid: grid };
}

function group(band?: string): FrameGroup {
  return {
    time: '120000', startMs: 0, messages: [], type: 'receive', cycle: 'even',
    frequencyContext: band ? { band, mode: 'FT8' } : undefined,
  };
}

describe('FramesTable strategy message presentation', () => {
  it('uses the historical frame band instead of the current radio band', () => {
    expect(resolveStrategyMessagePresentationClass(message(), group('20m'), projection))
      .toEqual({ textDecoration: 'line-through', opacity: 'muted' });
    expect(resolveStrategyMessagePresentationClass(message(), group('40m'), projection))
      .toEqual({
        badges: [{ label: 'contestNewCallsign', tone: 'warning' }],
        row: { tone: 'warning', background: 'soft', accent: true },
      });
  });

  it('does not guess a partition when old history lacks frequency context', () => {
    expect(resolveStrategyMessagePresentationClass(message(), group(), projection)).toBeUndefined();
  });

  it('preserves portable callsign identity instead of collapsing to the base call', () => {
    expect(resolveStrategyMessagePresentationClass(message('CQ JA1AAA/P PM95'), group('20m'), projection))
      .toEqual({
        badges: [
          { label: 'contestNewCallsign', tone: 'warning' },
          { label: 'contestNewGridField', tone: 'secondary' },
        ],
        row: { tone: 'secondary', background: 'soft', accent: true },
      });
  });

  it('fully replaces logbook background and accent with the strategy result', () => {
    const result = resolveFrameRowPresentation({
      facts: { isTx: false, rawText: 'CQ JA1AAA PM95', callsign: 'JA1AAA', grid: 'PM95', partition: '20M' },
      strategy: projection,
      logbook: {
        enabled: true,
        worked: false,
        isSpecialMessage: true,
        highlight: { label: 'New DXCC', color: '#a855f7' },
      },
    });
    expect(result).toMatchObject({
      source: 'strategy', background: false, accent: false,
      textDecoration: 'line-through', opacity: 'muted',
    });
    expect(result.color).toBeUndefined();
    expect(result.badges).toEqual([]);
  });

  it('preserves the standard logbook presentation when no strategy replaces it', () => {
    const result = resolveFrameRowPresentation({
      facts: { isTx: false, rawText: 'CQ JA1AAA PM95', callsign: 'JA1AAA', grid: 'PM95', partition: '20M' },
      logbook: {
        enabled: true,
        worked: false,
        isSpecialMessage: true,
        highlight: { label: 'New DXCC', color: '#a855f7' },
      },
    });
    expect(result).toMatchObject({
      source: 'logbook', color: '#a855f7', background: true, accent: true,
      badges: [{ label: 'New DXCC', color: '#a855f7' }],
    });
  });

  it('shows novelty tags only when the station is callable and keeps the accent while busy', () => {
    const cq = resolveFrameRowPresentation({
      facts: { isTx: false, rawText: 'CQ JA2BBB OL32', callsign: 'JA2BBB', grid: 'OL32', partition: '40M' },
      strategy: projection,
      logbook: { enabled: true, worked: false, isSpecialMessage: true },
    });
    expect(cq).toMatchObject({ source: 'strategy', background: true, accent: true });
    expect(cq.badges.map((badge) => badge.label)).toEqual([
      'contestNewCallsign', 'contestNewGridField',
    ]);

    const rr73 = resolveFrameRowPresentation({
      facts: { isTx: false, rawText: 'BG5DRB JA2BBB RR73', callsign: 'JA2BBB', grid: 'OL32', partition: '40M' },
      strategy: projection,
      logbook: { enabled: true, worked: false, isSpecialMessage: true },
    });
    expect(rr73).toMatchObject({ background: true, accent: true });
    expect(rr73.badges.map((badge) => badge.label)).toEqual([
      'contestNewCallsign', 'contestNewGridField',
    ]);

    const busy = resolveFrameRowPresentation({
      facts: { isTx: false, rawText: 'JA2BBB K1CCC OL32', callsign: 'JA2BBB', grid: 'OL32', partition: '40M' },
      strategy: projection,
      logbook: { enabled: true, worked: false, isSpecialMessage: false },
    });
    expect(busy).toMatchObject({ source: 'strategy', background: false, accent: true, badges: [] });
  });
});
