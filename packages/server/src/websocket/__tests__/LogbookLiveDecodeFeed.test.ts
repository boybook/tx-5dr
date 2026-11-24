import EventEmitter from 'eventemitter3';
import { describe, expect, it, vi } from 'vitest';
import { WSMessageType, type FrameMessage, type SlotPack } from '@tx5dr/contracts';

import { LogbookLiveDecodeFeed, buildLiveDecodes, locateLiveStation } from '../LogbookLiveDecodeFeed.js';
import { LogbookWSServer } from '../LogbookWSServer.js';

function frame(message: string, overrides: Partial<FrameMessage> = {}): FrameMessage {
  return { message, snr: -12, dt: 0.1, freq: 1500, confidence: 1, ...overrides } as FrameMessage;
}

function slotPack(frames: FrameMessage[], startMs = 1_700_000_000_000): SlotPack {
  return {
    slotId: `slot-${startMs}`,
    startMs,
    endMs: startMs + 15_000,
    frames,
    stats: { totalDecodes: 1, successfulDecodes: 1, totalFramesBeforeDedup: frames.length, totalFramesAfterDedup: frames.length, lastUpdated: startMs },
    decodeHistory: [],
    frequencyContext: { frequency: 14_074_000, band: '20m', mode: 'FT8' },
  } as SlotPack;
}

describe('locateLiveStation', () => {
  it('uses the locator when there is one', () => {
    expect(locateLiveStation('JA1ABC', 'PM95')).toMatchObject({ precision: 'grid' });
  });

  it('falls back to the DXCC entity centre with east-positive longitude', () => {
    // CTY lists Japan at 138.38 W-positive, i.e. -138.38; the map needs +138.38.
    const japan = locateLiveStation('JA1ABC');
    expect(japan?.precision).toBe('entity');
    expect(japan?.lng).toBeGreaterThan(120);
    const usa = locateLiveStation('W1AW');
    expect(usa?.lng).toBeLessThan(-60);
  });
});

describe('buildLiveDecodes', () => {
  it('keeps heard stations once per slot and leaves out own and transmitted frames', () => {
    const decodes = buildLiveDecodes(slotPack([
      frame('CQ JA1ABC PM95', { snr: -8 }),
      frame('BG5DRB DL1ABC JO62'),
      frame('CQ BG5DRB PM01'),
      frame('CQ VK2JEH QF56', { snr: -999 }),
      frame('JA1ABC BG5DRB -10'),
      frame('CQ JA1ABC PM95', { snr: -5 }),
    ]), new Set(['BG5DRB']));

    expect(decodes.map(decode => decode.callsign).sort()).toEqual(['DL1ABC', 'JA1ABC']);
    const ja = decodes.find(decode => decode.callsign === 'JA1ABC');
    expect(ja).toMatchObject({ messageType: 'cq', snr: -5, location: { precision: 'grid' } });
    const dl = decodes.find(decode => decode.callsign === 'DL1ABC');
    expect(dl).toMatchObject({ messageType: 'call', targetCallsign: 'BG5DRB' });
  });
});

describe('LogbookWSServer live decodes', () => {
  function setup() {
    const engine = new EventEmitter() as EventEmitter & { operatorManager: unknown };
    engine.operatorManager = {
      getLogManager: () => ({ getOperatorIdsForLogBook: () => ['operator-1'] }),
      getOperator: () => ({ config: { myCallsign: 'BG5DRB' } }),
      getOperatorsStatus: () => [],
    };
    const projectSlotPack = vi.fn(async (pack: SlotPack) => pack);
    const recent = [slotPack([frame('CQ JA1ABC PM95')], 1_700_000_000_000)];
    const feed = new LogbookLiveDecodeFeed({
      projectSlotPack,
      getOperatorCallsigns: () => ['BG5DRB'],
      getActiveSlotPacks: () => recent,
    });
    const server = new LogbookWSServer(engine as never, undefined, feed);
    const socket = () => ({ on: vi.fn(), send: vi.fn(), close: vi.fn() });
    // Live decode messages only; pages also get their operator list on connect.
    const messages = (s: ReturnType<typeof socket>) => s.send.mock.calls
      .map(([raw]) => JSON.parse(raw as string))
      .filter(message => message.type === WSMessageType.LOGBOOK_LIVE_DECODES);
    return { engine, server, projectSlotPack, socket, messages };
  }

  it('sends recent slots on connect, then each new slot analysed once per operator', async () => {
    const { engine, server, projectSlotPack, socket, messages } = setup();
    const first = socket();
    const second = socket();
    const admin = socket();
    server.addConnection(first, { operatorId: 'operator-1' });
    server.addConnection(second, { logBookId: 'logbook-1', authorizedOperatorIds: ['operator-1'] });
    server.addConnection(admin);
    await vi.waitFor(() => expect(messages(second)).toHaveLength(1));
    expect(messages(first)[0]).toMatchObject({ type: WSMessageType.LOGBOOK_LIVE_DECODES, data: { operatorId: 'operator-1' } });

    projectSlotPack.mockClear();
    engine.emit('slotPackUpdated', slotPack([frame('CQ VK2JEH QF56')], 1_700_000_015_000));
    await vi.waitFor(() => expect(messages(second)).toHaveLength(2));

    expect(projectSlotPack).toHaveBeenCalledOnce();
    expect(messages(first)[1].data).toMatchObject({ slotStartMs: 1_700_000_015_000, slotMs: 15_000, band: '20m' });
    expect(messages(first)[1].data.decodes.map((decode: { callsign: string }) => decode.callsign)).toEqual(['VK2JEH']);
    expect(messages(admin)).toEqual([]);
  });
});

describe('LogbookWSServer target selection', () => {
  const selectedFrame = { message: 'CQ JA1ABC PM95', snr: -8, dt: 0.1, freq: 1200, slotStartMs: 1_700_000_010_000 };

  function setup(canManage = true) {
    const engine = new EventEmitter() as EventEmitter & { operatorManager: unknown };
    engine.operatorManager = {
      getLogManager: () => ({ getOperatorIdsForLogBook: () => ['operator-1', 'operator-2'] }),
      getOperator: () => ({ config: { myCallsign: 'BG5DRB' } }),
      getOperatorsStatus: () => [],
    };
    const commands = {
      canManageOperator: vi.fn(() => canManage),
      selectTarget: vi.fn(async () => ({ status: 'called' as const })),
    };
    const server = new LogbookWSServer(engine as never, undefined, undefined, commands);
    const handlers: Record<string, (raw: string) => void> = {};
    const socket = { on: vi.fn((event: string, handler: (raw: string) => void) => { handlers[event] = handler; }), send: vi.fn(), close: vi.fn() };
    const messages = () => socket.send.mock.calls
      .map(([raw]) => JSON.parse(raw as string))
      .filter(message => message.type !== WSMessageType.OPERATORS_LIST);
    const select = (data: object) => handlers.message(JSON.stringify({ type: WSMessageType.LOGBOOK_SELECT_TARGET, data }));
    return { server, socket, commands, messages, select };
  }

  it('announces the command on connect and answers a selection with its outcome', async () => {
    const { server, socket, commands, messages, select } = setup();
    server.addConnection(socket, { logBookId: 'logbook-1', authorizedOperatorIds: ['operator-1'], tokenId: 'token-1' });
    expect(messages()[0]).toMatchObject({
      type: WSMessageType.SERVER_HANDSHAKE_COMPLETE,
      data: { supportedFeatures: ['logbookSelectTarget'] },
    });

    select({ requestId: 'r1', operatorId: 'operator-1', callsign: 'ja1abc', selectedFrame });
    await vi.waitFor(() => expect(messages()).toHaveLength(2));
    expect(commands.canManageOperator).toHaveBeenCalledWith('token-1', 'operator-1');
    expect(commands.selectTarget).toHaveBeenCalledWith('operator-1', 'JA1ABC', selectedFrame);
    expect(messages()[1]).toMatchObject({
      type: WSMessageType.LOGBOOK_SELECT_TARGET_RESULT,
      data: { requestId: 'r1', operatorId: 'operator-1', callsign: 'JA1ABC', status: 'called' },
    });
  });

  it('refuses operators outside the page or without permission, and ignores malformed commands', async () => {
    const outside = setup();
    outside.server.addConnection(outside.socket, { logBookId: 'logbook-1', authorizedOperatorIds: ['operator-1'], tokenId: 't' });
    outside.select({ requestId: 'r1', operatorId: 'operator-2', callsign: 'JA1ABC', selectedFrame });
    await vi.waitFor(() => expect(outside.messages()).toHaveLength(2));
    expect(outside.messages()[1].data).toMatchObject({ status: 'rejected', reason: 'forbidden' });
    expect(outside.commands.selectTarget).not.toHaveBeenCalled();

    const revoked = setup(false);
    revoked.server.addConnection(revoked.socket, { operatorId: 'operator-1', tokenId: 't' });
    revoked.select({ requestId: 'r2', operatorId: 'operator-1', callsign: 'JA1ABC', selectedFrame });
    await vi.waitFor(() => expect(revoked.messages()).toHaveLength(2));
    expect(revoked.messages()[1].data).toMatchObject({ status: 'rejected', reason: 'forbidden', userMessageKey: 'logbook:globe.callForbidden' });
    expect(revoked.commands.selectTarget).not.toHaveBeenCalled();

    revoked.select({ requestId: 'r3', operatorId: 'operator-1' });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(revoked.messages()).toHaveLength(2);
  });

  // Each selection can key the transmitter, so a page cannot stack them.
  it('handles one selection at a time per page and refuses oversized frames', async () => {
    const { server, socket, commands, messages, select } = setup();
    let finish!: () => void;
    commands.selectTarget.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ status: 'called' as const });
    }));
    server.addConnection(socket, { operatorId: 'operator-1', tokenId: 't' });

    select({ requestId: 'r1', operatorId: 'operator-1', callsign: 'JA1ABC', selectedFrame });
    select({ requestId: 'r2', operatorId: 'operator-1', callsign: 'VK2JEH', selectedFrame });
    await vi.waitFor(() => expect(messages()).toHaveLength(2));
    expect(messages()[1].data).toMatchObject({ requestId: 'r2', status: 'rejected', reason: 'busy' });
    finish();
    await vi.waitFor(() => expect(messages()).toHaveLength(3));
    expect(messages()[2].data).toMatchObject({ requestId: 'r1', status: 'called' });
    expect(commands.selectTarget).toHaveBeenCalledOnce();

    select({ requestId: 'r3', operatorId: 'operator-1', callsign: 'JA1ABC', selectedFrame: { ...selectedFrame, message: 'X'.repeat(81) } });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(messages()).toHaveLength(3);
  });
});

describe('LogbookWSServer revoked tokens', () => {
  // Regression: the live stream kept flowing to pages whose token had been
  // revoked, since the token was only checked at connect time.
  it('closes pages whose token is no longer valid when the next slot arrives', async () => {
    const engine = new EventEmitter() as EventEmitter & { operatorManager: unknown };
    engine.operatorManager = {
      getLogManager: () => ({ getOperatorIdsForLogBook: () => ['operator-1'] }),
      getOperator: () => ({ config: { myCallsign: 'BG5DRB' } }),
      getOperatorsStatus: () => [],
    };
    const feed = new LogbookLiveDecodeFeed({
      projectSlotPack: async (pack: SlotPack) => pack,
      getOperatorCallsigns: () => ['BG5DRB'],
      getActiveSlotPacks: () => [],
    });
    const valid = new Set(['kept', 'revoked']);
    const server = new LogbookWSServer(engine as never, undefined, feed, undefined, tokenId => valid.has(tokenId));
    const socket = () => ({ on: vi.fn(), send: vi.fn(), close: vi.fn() });
    const kept = socket();
    const revoked = socket();
    const authOff = socket();
    server.addConnection(kept, { operatorId: 'operator-1', tokenId: 'kept' });
    server.addConnection(revoked, { operatorId: 'operator-1', tokenId: 'revoked' });
    server.addConnection(authOff, { operatorId: 'operator-1' });
    const liveCount = (s: ReturnType<typeof socket>) => s.send.mock.calls
      .filter(([raw]) => JSON.parse(raw as string).type === WSMessageType.LOGBOOK_LIVE_DECODES).length;

    valid.delete('revoked');
    engine.emit('slotPackUpdated', slotPack([frame('CQ VK2JEH QF56')], 1_700_000_015_000));
    await vi.waitFor(() => expect(liveCount(kept)).toBe(1));

    expect(revoked.close).toHaveBeenCalledWith(4001, 'Token expired');
    expect(liveCount(revoked)).toBe(0);
    expect(liveCount(authOff)).toBe(1);
    expect(kept.close).not.toHaveBeenCalled();
  });
});
