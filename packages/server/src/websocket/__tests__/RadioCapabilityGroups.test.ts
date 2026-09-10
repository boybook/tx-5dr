import { describe, expect, it, vi } from 'vitest';
import { UserRole, WSMessageType, type AppAction, type AppSubject } from '@tx5dr/contracts';
import { buildAbility } from '../../auth/ability.js';
import { WSServer } from '../WSServer.js';

describe('WebSocket parameter groups', () => {
  it('enforces identity, handshake, RadioControl permission and the group decoder', async () => {
    const write = vi.fn(async () => undefined);
    let identity = false;
    let handshake = true;
    let ability = buildAbility({ role: UserRole.VIEWER });
    const connection = { hasResolvedIdentity: () => identity, isHandshakeCompleted: () => handshake,
      isPublicViewer: () => false, canPerform: (action: AppAction, subject: AppSubject) => ability.can(action, subject), send: vi.fn() };
    const server = Object.create(WSServer.prototype) as {
      digitalRadioEngine: unknown;
      commandHandlers: Record<string, (data: unknown, id: string) => Promise<void>>;
      getConnection: () => typeof connection;
      sendToConnection: ReturnType<typeof vi.fn>;
      handleClientCommand(id: string, message: { type: string; data: unknown }): Promise<void>;
      handleWriteRadioCapabilityGroup(id: string, data: unknown): Promise<void>;
    };
    server.digitalRadioEngine = { getRadioManager: () => ({ writeCapabilityGroup: write }) };
    server.getConnection = () => connection;
    server.sendToConnection = vi.fn();
    server.commandHandlers = { [WSMessageType.WRITE_RADIO_CAPABILITY_GROUP]: (data, id) => server.handleWriteRadioCapabilityGroup(id, data) };
    const data = { groupId: 'rx_filter_band', sessionId: 'session', values: { rx_filter_low: 30, rx_filter_high: 2700 } };
    const message = { type: WSMessageType.WRITE_RADIO_CAPABILITY_GROUP, data };
    await server.handleClientCommand('client', message);
    expect(connection.send).toHaveBeenLastCalledWith(WSMessageType.ERROR, expect.objectContaining({ code: 'UNAUTHORIZED' }));
    identity = true;
    await server.handleClientCommand('client', message);
    expect(connection.send).toHaveBeenLastCalledWith(WSMessageType.ERROR, expect.objectContaining({ code: 'FORBIDDEN' }));
    ability = buildAbility({ role: UserRole.ADMIN }); handshake = false;
    await server.handleClientCommand('client', message);
    expect(write).not.toHaveBeenCalled();
    handshake = true;
    await server.handleClientCommand('client', message);
    expect(write).toHaveBeenCalledWith('rx_filter_band', data.values, 'session');
    write.mockClear();
    await server.handleClientCommand('client', { ...message, data: { ...data, receiver: 1 } });
    expect(write).not.toHaveBeenCalled();
    expect(server.sendToConnection).toHaveBeenCalledWith('client', WSMessageType.ERROR, expect.anything());
  });
});
