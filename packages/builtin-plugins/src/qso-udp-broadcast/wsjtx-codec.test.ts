import { describe, expect, it } from 'vitest';
import { WsjtCodecError, decodeWsjtMessage, encodeWsjtMessage } from './wsjtx-codec.js';
import { WSJTX_UDP_MAGIC, WSJTX_UDP_SCHEMA, WsjtMessageType, UINT32_MAX } from './wsjtx-types.js';

const id = 'TX-5DR:test';

describe('WSJT-X UDP codec', () => {
  it('round-trips every known WSJT-X UDP message type', () => {
    const cases: Array<[WsjtMessageType, Record<string, unknown>, string]> = [
      [WsjtMessageType.Heartbeat, { maxSchema: 3, version: 'TX-5DR', revision: 'abc123' }, 'heartbeat'],
      [WsjtMessageType.Status, {
        dialFrequency: 14_074_000,
        mode: 'FT8',
        dxCall: 'K1ABC',
        report: '-10',
        txMode: 'FT8',
        txEnabled: true,
        transmitting: false,
        decoding: true,
        rxDf: 500,
        txDf: 1500,
        deCall: 'W1AW',
        deGrid: 'FN31',
        dxGrid: 'FN42',
        txWatchdog: false,
        subMode: '',
        fastMode: false,
        specialOperationMode: 0,
        frequencyTolerance: UINT32_MAX,
        trPeriod: 15,
        configurationName: 'TX-5DR',
        txMessage: 'W1AW K1ABC -10',
      }, 'status'],
      [WsjtMessageType.Decode, { isNew: true, timeMs: 45_000, snr: -12, deltaTime: 0.2, deltaFrequency: 1200, mode: 'FT8', message: 'CQ K1ABC FN42', lowConfidence: false, offAir: false }, 'decode'],
      [WsjtMessageType.Clear, { window: 2 }, 'clear'],
      [WsjtMessageType.Reply, { timeMs: 45_000, snr: -12, deltaTime: 0.2, deltaFrequency: 1200, mode: 'FT8', message: 'CQ K1ABC FN42', lowConfidence: false, modifiers: 0x04 }, 'reply'],
      [WsjtMessageType.QSOLogged, { timeOff: 1_700_000_060_000, dxCall: 'K1ABC', dxGrid: 'FN42', txFrequency: 14_074_000, mode: 'FT8', reportSent: '-10', reportReceived: '-08', txPower: '', comments: 'TU', name: '', timeOn: 1_700_000_000_000, operatorCall: 'W1AW', myCall: 'W1AW', myGrid: 'FN31', exchangeSent: '', exchangeReceived: '', adifPropagationMode: '', satellite: '', satMode: '', freqRx: '' }, 'qso-logged'],
      [WsjtMessageType.Close, {}, 'close'],
      [WsjtMessageType.Replay, {}, 'replay'],
      [WsjtMessageType.HaltTx, { autoTxOnly: true }, 'halt-tx'],
      [WsjtMessageType.FreeText, { text: 'TNX 73', send: true }, 'free-text'],
      [WsjtMessageType.WSPRDecode, { isNew: true, timeMs: 60_000, snr: -20, deltaTime: 1.1, frequency: 14_095_600, drift: 1, callsign: 'K1ABC', grid: 'FN42', power: 37, offAir: false }, 'wspr-decode'],
      [WsjtMessageType.Location, { location: 'FN31' }, 'location'],
      [WsjtMessageType.LoggedADIF, { adifText: '<adif_ver:5>3.1.0<eoh><call:5>K1ABC<eor>' }, 'logged-adif'],
      [WsjtMessageType.HighlightCallsign, { callsign: 'K1ABC', backgroundColor: { valid: true, red: 255, green: 0, blue: 0, alpha: 255 }, foregroundColor: { valid: false }, highlightLast: true }, 'highlight-callsign'],
      [WsjtMessageType.SwitchConfiguration, { configurationName: 'Portable' }, 'switch-configuration'],
      [WsjtMessageType.Configure, { mode: 'FT8', frequencyTolerance: UINT32_MAX, submode: '', fastMode: false, trPeriod: 15, rxDf: 1200, dxCall: 'K1ABC', dxGrid: 'FN42', generateMessages: true }, 'configure'],
      [WsjtMessageType.AnnotationInfo, { dxCall: 'K1ABC', sortOrderProvided: true, sortOrder: 42 }, 'annotation-info'],
    ];

    for (const [type, payload, kind] of cases) {
      const encoded = encodeWsjtMessage(type, id, payload);
      expect(encoded.readUInt32BE(0)).toBe(WSJTX_UDP_MAGIC);
      expect(encoded.readUInt32BE(4)).toBe(WSJTX_UDP_SCHEMA);
      expect(encoded.readUInt32BE(8)).toBe(type);
      expect(decodeWsjtMessage(encoded).kind).toBe(kind);
    }
  });

  it('ignores tail fields on known message types and preserves unknown types', () => {
    const decode = encodeWsjtMessage(WsjtMessageType.Decode, id, {
      isNew: true,
      timeMs: 1,
      snr: -1,
      deltaTime: 0,
      deltaFrequency: 100,
      mode: 'FT8',
      message: 'CQ K1ABC FN42',
      lowConfidence: false,
      offAir: false,
    });
    const withTail = Buffer.concat([decode, Buffer.from([1, 2, 3, 4])]);
    expect(decodeWsjtMessage(withTail).kind).toBe('decode');

    const unknown = Buffer.from(decode);
    unknown.writeUInt32BE(99, 8);
    const parsed = decodeWsjtMessage(unknown);
    expect(parsed.kind).toBe('unknown');
    expect(parsed.type).toBe(99);
  });

  it('uses Qt-compatible QColor stream shape and rejects newer schemas', () => {
    const encoded = encodeWsjtMessage(WsjtMessageType.HighlightCallsign, id, {
      callsign: 'K1ABC',
      backgroundColor: { valid: true, red: 255, green: 128, blue: 0, alpha: 64 },
      foregroundColor: { valid: false },
      highlightLast: false,
    });
    const parsed = decodeWsjtMessage(encoded);
    expect(parsed.kind).toBe('highlight-callsign');
    if (parsed.kind === 'highlight-callsign') {
      expect(parsed.backgroundColor).toMatchObject({ valid: true, red: 255, green: 128, blue: 0, alpha: 64 });
      expect(parsed.foregroundColor).toEqual({ valid: false });
    }

    const futureSchema = Buffer.from(encoded);
    futureSchema.writeUInt32BE(WSJTX_UDP_SCHEMA + 1, 4);
    expect(() => decodeWsjtMessage(futureSchema)).toThrow(WsjtCodecError);
  });
});
