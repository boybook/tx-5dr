import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { MockTciServer } from 'tci-client-node/testing';
import { buildStreamFrame, TciSampleType, TciStreamType } from 'tci-client-node';
import { CapabilityListSchema, CapabilityStateSchema, WSMessageType } from '@tx5dr/contracts';
import { TciConnection } from '../../packages/server/src/radio/connections/TciConnection.js';
import { RadioCapabilityManager } from '../../packages/server/src/radio/RadioCapabilityManager.js';
import { WSServer } from '../../packages/server/src/websocket/WSServer.js';
import { TciAudioAdapter } from '../../packages/server/src/audio/TciAudioAdapter.js';
import { initialRadioState, radioReducer } from '../../packages/web/src/store/radio/reducers';
import { buildCapabilityGroupPayload } from '../../packages/web/src/radio-capability/group-values';

describe('built TCI library to application control and audio flow', () => {
  it('round-trips an atomic Web group and native Line Out through the existing owners', async () => {
    const radio = new MockTciServer({ echoUnknown: false, startupCommands: [
      'PROTOCOL:ExpertSDR3,2.0;', 'DEVICE:SunSDR2DX;', 'TRX_COUNT:2;', 'CHANNEL_COUNT:2;',
      'VFO:0,0,7074000;', 'MODULATION:0,LSB;', 'MODULATIONS_LIST:USB,LSB,DIGU;',
      'TRX:0,false;', 'DRIVE:0,30;', 'RX_FILTER_BAND:0,-2900,-70;', 'MON_ENABLE:false;', 'READY;',
    ] });
    radio.onCommand(({ command, socket }) => {
      if (command.name === 'mon_enable' && command.args.length === 1) { socket.send(`MON_ENABLE:${command.args[0]};`); return true; }
      return false;
    });
    await radio.start();
    const connection = new TciConnection();
    const manager = new RadioCapabilityManager();
    let browser = initialRadioState;
    const engine = Object.assign(new EventEmitter(), {
      getNtpCalibrationService: () => new EventEmitter(), getRadioManager: () => manager,
    });
    const ws = Object.create(WSServer.prototype) as {
      digitalRadioEngine: unknown;
      spectrumCoordinator: EventEmitter;
      spectrumSessionCoordinator: EventEmitter;
      broadcast(type: WSMessageType, data: unknown): void;
      broadcastTextMessage: ReturnType<typeof vi.fn>;
      sendToConnection: ReturnType<typeof vi.fn>;
      getConnection: () => unknown;
      commandHandlers: Record<string, (data: unknown, id: string) => Promise<void>>;
      setupEngineEventListeners(): void;
      handleClientCommand(id: string, message: { type: string; data: unknown }): Promise<void>;
      handleWriteRadioCapabilityGroup(id: string, data: unknown): Promise<void>;
    };
    ws.digitalRadioEngine = engine;
    ws.spectrumCoordinator = new EventEmitter(); ws.spectrumSessionCoordinator = new EventEmitter();
    ws.broadcast = (type: WSMessageType, data: unknown) => {
      const decoded = JSON.parse(JSON.stringify(data));
      if (type === WSMessageType.RADIO_CAPABILITY_LIST) browser = radioReducer(browser, { type: 'setCapabilityList', payload: CapabilityListSchema.parse(decoded) });
      if (type === WSMessageType.RADIO_CAPABILITY_CHANGED) browser = radioReducer(browser, { type: 'updateCapabilityState', payload: CapabilityStateSchema.parse(decoded) });
    };
    ws.broadcastTextMessage = vi.fn();
    ws.setupEngineEventListeners();
    manager.on('capabilityList', (data) => engine.emit('radioCapabilityList', data));
    manager.on('capabilityChanged', (data) => engine.emit('radioCapabilityChanged', data));
    ws.sendToConnection = vi.fn();
    ws.getConnection = () => ({ hasResolvedIdentity: () => true, isHandshakeCompleted: () => true,
      isPublicViewer: () => false, canPerform: () => true, send: vi.fn() });
    ws.commandHandlers = { [WSMessageType.WRITE_RADIO_CAPABILITY_GROUP]: (data: unknown, id: string) => ws.handleWriteRadioCapabilityGroup(id, data) };
    let audio: TciAudioAdapter | undefined;
    try {
      const url = new URL(radio.url());
      await connection.connect({ type: 'tci', tci: { host: url.hostname, port: Number(url.port), receiver: 0, trx: 0, vfo: 0, dialect: 'auto', audioSampleRate: 12000 } });
      await manager.onConnected(connection);
      const descriptors = [...browser.capabilityDescriptors.values()].filter((d) => d.writeGroup?.id === 'rx_filter_band');
      expect(descriptors).toHaveLength(2);
      const payload = buildCapabilityGroupPayload(descriptors, { rx_filter_low: -3200, rx_filter_high: -100 });
      await ws.handleClientCommand('browser', { type: WSMessageType.WRITE_RADIO_CAPABILITY_GROUP, data: payload });
      expect(ws.sendToConnection).not.toHaveBeenCalled();
      expect(browser.capabilityStates.get('rx_filter_low')?.value).toBe(-3200);
      expect(browser.capabilityStates.get('rx_filter_high')?.value).toBe(-100);
      expect(await connection.getTciRxFilterBand()).toEqual([-3200, -100]);
      expect(radio.receivedCommands.filter((c) => c.name === 'rx_filter_band' && c.args.length === 3)).toHaveLength(1);

      audio = new TciAudioAdapter(connection);
      const received = new Promise<{ samples: Float32Array; rate: number | undefined }>((resolve) => {
        audio!.once('audioData', (samples, meta) => resolve({ samples, rate: meta?.sampleRate }));
      });
      audio.startReceiving();
      await connection.startLineOutStream();
      radio.broadcastBinary(buildStreamFrame({ receiver: 0, sampleRate: 48000, sampleType: TciSampleType.FLOAT32,
        streamType: TciStreamType.LINEOUT_STREAM, channels: 2, samples: new Float32Array([0.123456, 0.234567, -0.123456, -0.234567]) }));
      const frame = await received;
      expect(frame.rate).toBe(48000);
      expect(frame.samples).toBeInstanceOf(Float32Array);
      expect(frame.samples[0]).toBeCloseTo((0.123456 + 0.234567) / 2, 7);
      expect(frame.samples[1]).toBeCloseTo(-(0.123456 + 0.234567) / 2, 7);
      manager.onDisconnected();
      expect(browser.capabilityStates.size).toBe(0);
    } finally {
      audio?.stopReceiving(); manager.onDisconnected();
      await connection.disconnect('integration test'); await radio.stop(); engine.removeAllListeners();
    }
  });
});
