import { describe, expect, it, vi } from 'vitest';
import { UserRole, WSMessageType, type CapabilityState } from '@tx5dr/contracts';
import { WSServer } from '../WSServer.js';

function fixture() {
  const flags = { identity: true, handshake: true, control: true, admin: true };
  const radio = { current: {} as object | null };
  const state: CapabilityState = { id: 'rf_power', supported: true, value: 0.7, updatedAt: 10, meta: { limited: true } };
  const manager = { writeCapability: vi.fn(async () => {}), getCurrentConnection: () => radio.current, getCapabilityState: vi.fn(() => state) };
  const connection = { hasResolvedIdentity: () => flags.identity, isHandshakeCompleted: () => flags.handshake,
    isPublicViewer: () => false, canPerform: () => flags.control, hasMinRole: (role: UserRole) => role !== UserRole.ADMIN || flags.admin, send: vi.fn() };
  const server = Object.create(WSServer.prototype) as {
    digitalRadioEngine: unknown; commandHandlers: Record<string, (data: unknown, connectionId: string, requestId?: string) => Promise<void>>;
    getConnection: () => typeof connection; sendToConnection: ReturnType<typeof vi.fn>;
    handleClientCommand(connectionId: string, message: { type: string; data: unknown; id?: string }): Promise<void>;
    handleWriteRadioCapability(connectionId: string, data: unknown, requestId?: string): Promise<void>;
  };
  server.digitalRadioEngine = { getRadioManager: () => manager };
  server.getConnection = () => connection; server.sendToConnection = vi.fn();
  server.commandHandlers = { [WSMessageType.WRITE_RADIO_CAPABILITY]: (data, connectionId, requestId) => server.handleWriteRadioCapability(connectionId, data, requestId) };
  const command = { type: WSMessageType.WRITE_RADIO_CAPABILITY, id: 'request-b', data: { id: 'rf_power', value: 0.9, sessionId: 'session' } };
  return { server, flags, radio, manager, connection, state, command };
}

describe('capability write receipts', () => {
  it('waits for completion and returns only the actual cached state under the original message ID', async () => {
    const { server, manager, state, command } = fixture();
    let complete!: () => void;
    manager.writeCapability.mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
    const pending = server.handleClientCommand('client', command);
    expect(server.sendToConnection).not.toHaveBeenCalled(); expect(manager.getCapabilityState).not.toHaveBeenCalled();
    complete(); await pending;
    expect(manager.writeCapability).toHaveBeenCalledWith('rf_power', 0.9, undefined, 'session');
    expect(manager.getCapabilityState).toHaveBeenCalledWith('rf_power');
    expect(server.sendToConnection).toHaveBeenCalledWith('client', WSMessageType.RADIO_CAPABILITY_CHANGED, state, command.id);
  });
  it('keeps legacy writes without IDs on the original broadcast-only path', async () => {
    const { server, command, manager } = fixture();
    await server.handleClientCommand('client', { type: command.type, data: command.data });
    expect(manager.writeCapability).toHaveBeenCalledOnce(); expect(manager.getCapabilityState).not.toHaveBeenCalled();
    expect(server.sendToConnection).not.toHaveBeenCalled();
  });
  it.each(['identity', 'handshake', 'control'] as const)('correlates %s rejections before dispatch', async flag => {
    const { server, flags, connection, manager, command } = fixture(); flags[flag] = false;
    await server.handleClientCommand('client', command);
    expect(manager.writeCapability).not.toHaveBeenCalled();
    expect(connection.send).toHaveBeenCalledWith(WSMessageType.ERROR, expect.any(Object), command.id);
  });
  it('preserves the IQ sample-rate administrator guard and correlates its rejection', async () => {
    const { server, flags, manager, command } = fixture(); flags.admin = false;
    await server.handleClientCommand('client', { ...command, data: { ...command.data, id: 'tci_iq_sample_rate', value: 192000 } });
    expect(manager.writeCapability).not.toHaveBeenCalled();
    expect(server.sendToConnection).toHaveBeenCalledWith('client', WSMessageType.ERROR, expect.objectContaining({ message: expect.stringContaining('administrator') }), command.id);
  });
  it('does not acknowledge a different radio connection after a delayed write', async () => {
    const { server, radio, manager, command } = fixture();
    manager.writeCapability.mockImplementation(async () => { radio.current = {}; });
    await server.handleClientCommand('client', command);
    expect(manager.getCapabilityState).not.toHaveBeenCalled();
    expect(server.sendToConnection).toHaveBeenCalledWith('client', WSMessageType.ERROR, expect.objectContaining({ message: expect.stringContaining('session changed') }), command.id);
  });
  it('correlates a write failure and does not manufacture a result value', async () => {
    const { server, manager, command } = fixture(); manager.writeCapability.mockRejectedValue(new Error('Rejected by host'));
    await server.handleClientCommand('client', command);
    expect(manager.getCapabilityState).not.toHaveBeenCalled();
    expect(server.sendToConnection).toHaveBeenCalledWith('client', WSMessageType.ERROR, expect.objectContaining({ message: expect.stringContaining('Rejected by host') }), command.id);
  });
});
