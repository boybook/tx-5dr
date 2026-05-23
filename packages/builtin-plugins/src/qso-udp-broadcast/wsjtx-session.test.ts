import { describe, expect, it, vi } from 'vitest';
import {
  createMockContext,
  createMockNetworkControl,
  createMockParsedMessage,
  createMockSlotInfo,
  type MockNetworkControl,
} from '@tx5dr/plugin-api/testing';
import type { QSORecord } from '@tx5dr/plugin-api';
import { decodeWsjtMessage, encodeWsjtMessage } from './wsjtx-codec.js';
import { WsjtMessageType } from './wsjtx-types.js';
import { WsjtUdpSession, type WsjtUdpSettings } from './wsjtx-session.js';

function settings(overrides: Partial<WsjtUdpSettings> = {}): WsjtUdpSettings {
  return {
    targets: [{ host: '127.0.0.1', port: 2237 }],
    clientId: 'TX-5DR:test',
    enableType5QsoLogged: true,
    enableType12LoggedAdif: true,
    enableRawAdif: true,
    rawAdifHost: '127.0.0.1',
    rawAdifPort: 2333,
    lowConfidenceThreshold: 0.8,
    maxHighlightRules: 100,
    allowReplyRequests: false,
    allowHaltTxRequests: false,
    allowFreeTextRequests: false,
    allowLocationRequests: false,
    allowConfigureRequests: false,
    allowCloseRequests: false,
    allowSwitchConfigurationRequests: false,
    ...overrides,
  };
}

function sentBuffer(network: MockNetworkControl, index: number): Buffer {
  const data = network._sockets[0]._sent[index].data;
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

describe('WSJT-X UDP session', () => {
  it('sends initial heartbeat/status and registers heartbeat timer', async () => {
    const network = createMockNetworkControl();
    const ctx = createMockContext({ network });
    const session = new WsjtUdpSession(ctx, settings());

    await session.start();

    expect(network._sockets).toHaveLength(1);
    expect(network._sockets[0]._binds[0]).toEqual({ port: undefined });
    expect(ctx.timers._active.get('wsjtx-udp-heartbeat')).toBe(15_000);
    expect(decodeWsjtMessage(sentBuffer(network, 0)).kind).toBe('heartbeat');
    expect(decodeWsjtMessage(sentBuffer(network, 1)).kind).toBe('status');
  });

  it('negotiates schema from server heartbeat per target', async () => {
    const network = createMockNetworkControl();
    const ctx = createMockContext({ network });
    const session = new WsjtUdpSession(ctx, settings());
    await session.start();

    await network._sockets[0]._emitMessage(
      encodeWsjtMessage(WsjtMessageType.Heartbeat, 'server', { maxSchema: 2, version: 'server', revision: '' }),
      { address: '127.0.0.1', port: 2237 },
    );
    network._sockets[0]._sent.length = 0;

    await session.onTimer('wsjtx-udp-heartbeat');

    expect(sentBuffer(network, 0).readUInt32BE(4)).toBe(2);
    expect(decodeWsjtMessage(sentBuffer(network, 0)).kind).toBe('heartbeat');
  });

  it('broadcasts decodes with raw frame confidence and replays them as old decodes', async () => {
    const network = createMockNetworkControl();
    const ctx = createMockContext({ network });
    const session = new WsjtUdpSession(ctx, settings());
    await session.start();
    network._sockets[0]._sent.length = 0;

    await session.onSlotActivity({
      slotInfo: createMockSlotInfo({ startMs: 30_000 }),
      slotPack: null,
      frames: [{ snr: -12, dt: 0.2, freq: 1400, message: 'CQ TEST W1AW FN31', confidence: 0.5 }],
      messages: [createMockParsedMessage({ snr: -12, dt: 0.2, df: 1400, rawMessage: 'CQ TEST W1AW FN31' })],
      source: 'live',
    });

    const liveDecode = decodeWsjtMessage(sentBuffer(network, 0));
    expect(liveDecode.kind).toBe('decode');
    if (liveDecode.kind === 'decode') {
      expect(liveDecode.isNew).toBe(true);
      expect(liveDecode.lowConfidence).toBe(true);
    }

    network._sockets[0]._sent.length = 0;
    await network._sockets[0]._emitMessage(encodeWsjtMessage(WsjtMessageType.Replay, 'server'), { address: '127.0.0.1', port: 2237 });

    const replayDecode = decodeWsjtMessage(sentBuffer(network, 0));
    expect(replayDecode.kind).toBe('decode');
    if (replayDecode.kind === 'decode') expect(replayDecode.isNew).toBe(false);
    expect(decodeWsjtMessage(sentBuffer(network, 1)).kind).toBe('status');
  });

  it('keeps risky inbound commands denied until explicitly enabled', async () => {
    const haltTransmission = vi.fn();
    const network = createMockNetworkControl();
    const ctx = createMockContext({ network, operator: { haltTransmission } });
    const session = new WsjtUdpSession(ctx, settings());
    await session.start();

    await network._sockets[0]._emitMessage(
      encodeWsjtMessage(WsjtMessageType.HaltTx, 'server', { autoTxOnly: false }),
      { address: '127.0.0.1', port: 2237 },
    );

    expect(haltTransmission).not.toHaveBeenCalled();
  });

  it('maps allowed FreeText requests to operator control', async () => {
    const sendFreeText = vi.fn();
    const network = createMockNetworkControl();
    const ctx = createMockContext({ network, operator: { sendFreeText } });
    const session = new WsjtUdpSession(ctx, settings({ allowFreeTextRequests: true }));
    await session.start();

    await network._sockets[0]._emitMessage(
      encodeWsjtMessage(WsjtMessageType.FreeText, 'server', { text: 'TNX 73', send: true }),
      { address: '127.0.0.1', port: 2237 },
    );

    expect(sendFreeText).toHaveBeenCalledWith('TNX 73');
  });

  it('uses the decoded slotPack cycle when handling remote Reply requests', async () => {
    const replyToDecode = vi.fn();
    const network = createMockNetworkControl();
    const ctx = createMockContext({ network, operator: { replyToDecode } });
    const session = new WsjtUdpSession(ctx, settings({ allowReplyRequests: true }));
    await session.start();

    const decodedSlot = createMockSlotInfo({ id: 'slot-15000', startMs: 15_000, utcSeconds: 15, cycleNumber: 1 });
    await session.onSlotActivity({
      slotInfo: createMockSlotInfo({ id: 'slot-30000', startMs: 30_000, utcSeconds: 30, cycleNumber: 0 }),
      slotPack: {
        slotId: decodedSlot.id,
        startMs: decodedSlot.startMs,
        endMs: 30_000,
        frames: [{ snr: -12, dt: 0.2, freq: 1400, message: 'CQ TEST W1AW FN31', confidence: 0.9 }],
        stats: {
          totalDecodes: 1,
          successfulDecodes: 1,
          totalFramesBeforeDedup: 1,
          totalFramesAfterDedup: 1,
          lastUpdated: 30_000,
        },
        decodeHistory: [],
      },
      frames: [{ snr: -12, dt: 0.2, freq: 1400, message: 'CQ TEST W1AW FN31', confidence: 0.9 }],
      messages: [createMockParsedMessage({ snr: -12, dt: 0.2, df: 1400, rawMessage: 'CQ TEST W1AW FN31', timestamp: 15_000, slotId: decodedSlot.id })],
      source: 'live',
    });

    await network._sockets[0]._emitMessage(
      encodeWsjtMessage(WsjtMessageType.Reply, 'server', {
        timeMs: 15_000,
        snr: -12,
        deltaTime: 0.2,
        deltaFrequency: 1400,
        mode: 'FT8',
        message: 'CQ TEST W1AW FN31',
        lowConfidence: false,
        modifiers: 0,
      }),
      { address: '127.0.0.1', port: 2237 },
    );

    expect(replyToDecode).toHaveBeenCalledTimes(1);
    expect(replyToDecode.mock.calls[0][0].lastMessage.slotInfo).toMatchObject({
      id: 'slot-15000',
      startMs: 15_000,
      cycleNumber: 1,
    });
  });

  it('sends Clear then Status with the new dial frequency on frequency changes', async () => {
    const network = createMockNetworkControl();
    const ctx = createMockContext({
      network,
      radio: { frequency: 14_074_000 },
    });
    const session = new WsjtUdpSession(ctx, settings());
    await session.start();
    network._sockets[0]._sent.length = 0;

    await session.onFrequencyChange({
      frequency: 7_074_000,
      mode: 'FT8',
      band: '40m',
      description: '40m FT8',
      radioConnected: true,
      source: 'program',
    });

    const clear = decodeWsjtMessage(sentBuffer(network, 0));
    const status = decodeWsjtMessage(sentBuffer(network, 1));
    expect(clear.kind).toBe('clear');
    expect(status.kind).toBe('status');
    if (status.kind === 'status') {
      expect(status.dialFrequency).toBe(7_074_000);
      expect(status.mode).toBe('FT8');
      expect(status.txMode).toBe('FT8');
    }
  });

  it('clears old decode history and deduplicates repeated frequency changes', async () => {
    const network = createMockNetworkControl();
    const ctx = createMockContext({ network });
    const session = new WsjtUdpSession(ctx, settings());
    await session.start();
    network._sockets[0]._sent.length = 0;

    await session.onSlotActivity({
      slotInfo: createMockSlotInfo({ startMs: 30_000 }),
      slotPack: null,
      frames: [{ snr: -12, dt: 0.2, freq: 1400, message: 'CQ TEST W1AW FN31', confidence: 0.9 }],
      messages: [createMockParsedMessage({ snr: -12, dt: 0.2, df: 1400, rawMessage: 'CQ TEST W1AW FN31' })],
      source: 'live',
    });

    await session.onFrequencyChange({
      frequency: 7_074_000,
      mode: 'FT8',
      band: '40m',
      description: '40m FT8',
      radioConnected: true,
      source: 'program',
    });
    const sendCountAfterFirstChange = network._sockets[0]._sent.length;

    await session.onFrequencyChange({
      frequency: 7_074_000,
      mode: 'FT8',
      band: '40m',
      description: '40m FT8',
      radioConnected: true,
      source: 'program',
    });
    expect(network._sockets[0]._sent).toHaveLength(sendCountAfterFirstChange);

    network._sockets[0]._sent.length = 0;
    await network._sockets[0]._emitMessage(encodeWsjtMessage(WsjtMessageType.Replay, 'server'), { address: '127.0.0.1', port: 2237 });

    expect(network._sockets[0]._sent).toHaveLength(1);
    expect(decodeWsjtMessage(sentBuffer(network, 0)).kind).toBe('status');
  });

  it('sends Type 5, Type 12 and legacy raw ADIF on QSO completion', async () => {
    const network = createMockNetworkControl();
    const ctx = createMockContext({ network });
    const session = new WsjtUdpSession(ctx, settings());
    await session.start();
    network._sockets[0]._sent.length = 0;

    const record: QSORecord = {
      id: 'qso-1',
      callsign: 'K1ABC',
      grid: 'FN42',
      frequency: 14_074_000,
      mode: 'FT8',
      startTime: 1_700_000_000_000,
      endTime: 1_700_000_060_000,
      reportSent: '-10',
      reportReceived: '-08',
      messageHistory: [],
      myCallsign: 'W1AW',
      myGrid: 'FN31',
    };

    await session.onQSOComplete(record);

    const qsoLogged = decodeWsjtMessage(sentBuffer(network, 0));
    const loggedAdif = decodeWsjtMessage(sentBuffer(network, 1));

    expect(qsoLogged.kind).toBe('qso-logged');
    expect(qsoLogged).toMatchObject({
      comments: 'FT8  Sent: -10  Rcvd: -08',
    });
    expect(loggedAdif.kind).toBe('logged-adif');
    expect(loggedAdif).toMatchObject({
      adifText: expect.stringContaining('<comment:25>FT8  Sent: -10  Rcvd: -08'),
    });
    expect(network._sockets[0]._sent[2]).toMatchObject({ host: '127.0.0.1', port: 2333 });
  });
});
