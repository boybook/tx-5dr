import { describe, expect, it } from 'vitest';
import { FT8MessageParser } from '@tx5dr/core';
import type { ParsedFT8Message } from '@tx5dr/plugin-api';
import {
  deriveWWDigiTransmission,
  initializeWWDigiProtocolContext,
  reduceWWDigiInbound,
  reduceWWDigiPhysicalSuccess,
  setWWDigiProtocolPhase,
} from './WWDigiProtocolContext.js';

const config = { myCallsign: 'BH5HIE', myGrid: 'PM00', modeName: 'FT8' as const };

function parsed(rawMessage: string, timestamp = 1_000): ParsedFT8Message {
  return {
    rawMessage,
    timestamp,
    snr: -14,
    dt: -0.4,
    df: 396,
    slotId: `slot-${timestamp}`,
    message: FT8MessageParser.parseMessage(rawMessage),
  };
}

describe('WW Digi protocol context', () => {
  it('rehydrates a directed R-grid at RR73 instead of restarting with grid', () => {
    const context = initializeWWDigiProtocolContext({
      callsign: 'LZ2INP',
      audioFrequencyHz: 1_022,
      now: 1_000,
      lastMessageRaw: 'BH5HIE LZ2INP R KN34',
      targetGrid: 'KN34',
    }, config);

    expect(context.phase).toBe('send-rr73');
    expect(deriveWWDigiTransmission(context, config)).toBe('LZ2INP BH5HIE RR73');
  });

  it('advances a retained grid transmission when a late R-grid arrives', () => {
    let context = initializeWWDigiProtocolContext({
      callsign: 'LZ2INP', audioFrequencyHz: 1_022, now: 1_000,
    }, config);
    context = reduceWWDigiPhysicalSuccess(
      context,
      deriveWWDigiTransmission(context, config),
      2_000,
    ).context;

    const reduced = reduceWWDigiInbound(context, parsed('BH5HIE LZ2INP R KN34'), config);

    expect(reduced.completed).toBe(false);
    expect(reduced.context.phase).toBe('send-rr73');
    expect(reduced.context.targetGrid).toBe('KN34');
    expect(deriveWWDigiTransmission(reduced.context, config)).toBe('LZ2INP BH5HIE RR73');
  });

  it.each(['RR73', 'RRR', '73'])('accepts a directed %s without requiring prior phase evidence', (suffix) => {
    const context = initializeWWDigiProtocolContext({
      callsign: 'LZ2INP', audioFrequencyHz: 1_022, now: 1_000,
    }, config);

    const reduced = reduceWWDigiInbound(context, parsed(`BH5HIE LZ2INP ${suffix}`, 3_000), config);

    expect(reduced.completed).toBe(true);
    expect(reduced.context.completedAt).toBe(3_000);
  });

  it('completes only when a locally selected final acknowledgement reaches physical success', () => {
    const context = initializeWWDigiProtocolContext({
      callsign: 'LZ2INP', audioFrequencyHz: 1_022, now: 1_000,
    }, config);

    expect(reduceWWDigiPhysicalSuccess(context, 'LZ2INP BH5HIE PM00', 2_000).completed).toBe(false);
    const finalContext = setWWDigiProtocolPhase(context, 'send-rr73');
    expect(reduceWWDigiPhysicalSuccess(finalContext, 'LZ2INP BH5HIE RR73', 3_000).completed).toBe(true);
  });

  it('ignores messages from the target to another station', () => {
    const context = initializeWWDigiProtocolContext({
      callsign: 'LZ2INP', audioFrequencyHz: 1_022, now: 1_000,
    }, config);

    const reduced = reduceWWDigiInbound(context, parsed('JA1AAA LZ2INP R KN34'), config);

    expect(reduced.changed).toBe(false);
    expect(reduced.context).toEqual(context);
  });
});
