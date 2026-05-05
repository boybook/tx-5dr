import type { ParsedFT8Message, PluginContext, SlotActivityEvent, SlotInfo, QSORecord } from '@tx5dr/plugin-api';
import { FT8MessageType } from '@tx5dr/plugin-api';
import {
  buildAdifFile,
  buildRawAdifRecord,
  parsedMessageToWsjtDecode,
  qsoRecordToWsjtQsoLogged,
  WsjtMessageType,
  UINT32_MAX,
} from './encoder.js';
import { decodeWsjtMessage, encodeWsjtMessage } from './wsjtx-codec.js';
import { WSJTX_HEARTBEAT_SECONDS, WSJTX_UDP_SCHEMA, type WsjtDecodeMessage, type WsjtMessage, type WsjtStatusMessage } from './wsjtx-types.js';
import { isRemoteMessageAllowed, logRemoteDenied, type RemotePolicySettings } from './remote-policy.js';

export interface UdpTarget {
  host: string;
  port: number;
}

export interface WsjtUdpSettings extends RemotePolicySettings {
  targets: UdpTarget[];
  localPort?: number;
  clientId: string;
  enableType5QsoLogged: boolean;
  enableType12LoggedAdif: boolean;
  enableRawAdif: boolean;
  rawAdifHost: string;
  rawAdifPort: number;
  lowConfidenceThreshold: number;
  maxHighlightRules: number;
}

interface DecodeHistoryEntry {
  message: ParsedFT8Message;
  slotInfo: SlotInfo;
  wsjt: WsjtDecodeMessage;
}

export class WsjtUdpSession {
  private socket: import('@tx5dr/plugin-api').PluginUdpSocket | null = null;
  private settings: WsjtUdpSettings;
  private negotiatedSchemas = new Map<string, number>();
  private decodeHistory: DecodeHistoryEntry[] = [];
  private highlightRules = new Map<string, unknown>();

  constructor(private readonly ctx: PluginContext, settings: WsjtUdpSettings) {
    this.settings = settings;
  }

  async start(): Promise<void> {
    if (!this.ctx.network?.udp) {
      this.ctx.log.warn('WSJT-X UDP disabled: host network UDP API is unavailable');
      return;
    }
    this.socket = this.ctx.network.udp.createSocket({ type: 'udp4', reuseAddr: true, broadcast: true });
    this.socket.onError((error) => this.ctx.log.warn('WSJT-X UDP socket error', { error: error.message }));
    this.socket.onMessage((data, remote) => this.handleDatagram(data, remote).catch((error) => {
      this.ctx.log.warn('WSJT-X UDP datagram handling failed', { error: error instanceof Error ? error.message : String(error) });
    }));
    await this.socket.bind({ port: this.settings.localPort });
    await this.sendHeartbeat();
    await this.sendStatus();
    this.ctx.timers.set('wsjtx-udp-heartbeat', WSJTX_HEARTBEAT_SECONDS * 1000);
  }

  async stop(): Promise<void> {
    await this.sendWsjtMessageToTargets(WsjtMessageType.Close).catch(() => undefined);
    this.ctx.timers.clear('wsjtx-udp-heartbeat');
    await this.socket?.close().catch(() => undefined);
    this.socket = null;
  }

  updateSettings(settings: WsjtUdpSettings): void {
    this.settings = settings;
  }

  async onTimer(timerId: string): Promise<void> {
    if (timerId === 'wsjtx-udp-heartbeat') {
      await this.sendHeartbeat();
    }
  }

  async onSlotStart(slotInfo: SlotInfo, messages: ParsedFT8Message[]): Promise<void> {
    if (messages.length === 0) {
      await this.sendStatus({ decoding: false });
      return;
    }
    for (const message of messages) {
      const decode = parsedMessageToWsjtDecode(message, true, this.settings.lowConfidenceThreshold);
      decode.mode = slotInfo.mode || decode.mode;
      decode.timeMs = msFromSlot(slotInfo);
      this.rememberDecode({ message, slotInfo, wsjt: decode });
      await this.sendWsjtMessageToTargets(WsjtMessageType.Decode, decode);
    }
    await this.sendStatus({ decoding: false });
  }

  async onSlotActivity(event: SlotActivityEvent): Promise<void> {
    if (event.source === 'reset') {
      await this.clearDecodes();
      return;
    }
    const sourceSlotInfo = event.slotPack ? slotInfoFromSlotPack(event.slotInfo, event.slotPack) : event.slotInfo;
    const frameByMessage = new Map(event.frames.map((frame) => [frameKey(frame.message, frame.freq, frame.dt), frame]));
    const messages = event.messages.map((message) => {
      const frame = frameByMessage.get(frameKey(message.rawMessage, message.df, message.dt))
        ?? frameByMessage.get(frameKey(message.rawMessage, message.df, undefined))
        ?? event.frames.find((candidate) => candidate.message === message.rawMessage);
      return frame ? ({ ...message, confidence: frame.confidence } as ParsedFT8Message & { confidence: number }) : message;
    });
    await this.onSlotStart(sourceSlotInfo, messages);
  }

  async onQSOComplete(record: QSORecord): Promise<void> {
    const adifFile = buildAdifFile(record);
    if (this.settings.enableType5QsoLogged) {
      await this.sendWsjtMessageToTargets(WsjtMessageType.QSOLogged, qsoRecordToWsjtQsoLogged(record));
    }
    if (this.settings.enableType12LoggedAdif) {
      await this.sendWsjtMessageToTargets(WsjtMessageType.LoggedADIF, { adifText: adifFile });
    }

    if (this.settings.enableRawAdif) {
      await this.socket?.send(buildRawAdifRecord(record), this.settings.rawAdifPort, this.settings.rawAdifHost);
    }
    this.ctx.log.info('WSJT-X UDP QSO broadcast processed', {
      callsign: record.callsign,
      type5: this.settings.enableType5QsoLogged,
      type12: this.settings.enableType12LoggedAdif,
      rawAdif: this.settings.enableRawAdif,
    });
  }

  async clearDecodes(): Promise<void> {
    this.decodeHistory = [];
    await this.sendWsjtMessageToTargets(WsjtMessageType.Clear);
  }

  private async sendHeartbeat(): Promise<void> {
    await this.sendWsjtMessageToTargets(WsjtMessageType.Heartbeat, {
      maxSchema: WSJTX_UDP_SCHEMA,
      version: 'TX-5DR',
      revision: '',
    });
  }

  private async sendStatus(overrides: Partial<WsjtStatusMessage> = {}): Promise<void> {
    const automation = this.ctx.operator.automation;
    const context = automation?.context;
    const status: Partial<WsjtStatusMessage> = {
      dialFrequency: this.ctx.radio.frequency || this.ctx.operator.frequency || 0,
      mode: this.ctx.operator.mode?.name ?? 'FT8',
      dxCall: context?.targetCallsign ?? '',
      report: typeof context?.reportSent === 'number' ? String(context.reportSent) : '',
      txMode: this.ctx.operator.mode?.name ?? 'FT8',
      txEnabled: this.ctx.operator.isTransmitting,
      transmitting: this.ctx.operator.isTransmitting,
      decoding: false,
      rxDf: UINT32_MAX,
      txDf: Math.max(0, Math.trunc(this.ctx.operator.frequency || 0)) || UINT32_MAX,
      deCall: this.ctx.operator.callsign,
      deGrid: this.ctx.operator.grid,
      dxGrid: context?.targetGrid ?? '',
      txWatchdog: false,
      subMode: '',
      fastMode: false,
      specialOperationMode: 0,
      frequencyTolerance: UINT32_MAX,
      trPeriod: this.ctx.operator.mode?.slotMs ? Math.trunc(this.ctx.operator.mode.slotMs / 1000) : UINT32_MAX,
      configurationName: 'TX-5DR',
      txMessage: readTransmitMessage(automation),
      ...overrides,
    };
    await this.sendWsjtMessageToTargets(WsjtMessageType.Status, status);
  }

  private async handleDatagram(data: Uint8Array, remote: import('@tx5dr/plugin-api').PluginUdpRemoteInfo): Promise<void> {
    let message: WsjtMessage;
    try {
      message = decodeWsjtMessage(data);
    } catch (error) {
      this.ctx.log.warn('Invalid WSJT-X UDP datagram ignored', { remote, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const key = `${remote.address}:${remote.port}`;
    if (message.kind === 'heartbeat') {
      const negotiated = Math.min(message.maxSchema || 2, WSJTX_UDP_SCHEMA);
      this.negotiatedSchemas.set(key, negotiated);
      const matchingTarget = this.settings.targets.find((target) => target.port === remote.port && (target.host === remote.address || isLoopbackAlias(target.host, remote.address)));
      if (matchingTarget) this.negotiatedSchemas.set(targetKey(matchingTarget), negotiated);
      this.ctx.log.debug('WSJT-X UDP heartbeat received', { remote, id: message.id, version: message.version, revision: message.revision });
      return;
    }
    if (message.kind === 'unknown') {
      this.ctx.log.debug('Unknown WSJT-X UDP message ignored', { remote, id: message.id, type: message.type });
      return;
    }

    if (!isRemoteMessageAllowed(message, this.settings)) {
      logRemoteDenied(this.ctx, message);
      return;
    }

    switch (message.kind) {
      case 'clear':
        this.decodeHistory = [];
        this.ctx.operator.clearDecodes(message.window);
        break;
      case 'replay':
        await this.replayDecodes();
        break;
      case 'reply':
        this.handleReply(message);
        break;
      case 'halt-tx':
        this.ctx.operator.haltTransmission({ autoOnly: message.autoTxOnly });
        break;
      case 'free-text':
        if (message.send) this.ctx.operator.sendFreeText(message.text || undefined);
        else this.ctx.operator.setFreeText(message.text);
        break;
      case 'location':
        this.ctx.operator.setTemporaryLocation(message.location);
        break;
      case 'highlight-callsign':
        this.handleHighlight(message);
        break;
      case 'switch-configuration':
        this.ctx.log.warn('WSJT-X UDP SwitchConfiguration is parsed but unsupported by TX-5DR host', { configurationName: message.configurationName });
        break;
      case 'configure':
        this.ctx.log.info('WSJT-X UDP Configure received; applying supported fields only', { mode: message.mode, rxDf: message.rxDf, dxCall: message.dxCall, dxGrid: message.dxGrid, generateMessages: message.generateMessages });
        if (message.dxCall) this.ctx.operator.call(message.dxCall);
        break;
      case 'close':
        this.ctx.log.warn('WSJT-X UDP Close request received; closing only the plugin UDP session');
        await this.stop();
        break;
      case 'annotation-info':
        this.ctx.store.operator.set(`annotation:${message.dxCall.toUpperCase()}`, {
          sortOrderProvided: message.sortOrderProvided,
          sortOrder: message.sortOrder,
          updatedAt: Date.now(),
        });
        break;
      default:
        this.ctx.log.debug('WSJT-X UDP message ignored', { kind: message.kind, type: message.type });
    }
  }

  private handleReply(message: Extract<WsjtMessage, { kind: 'reply' }>): void {
    const match = this.decodeHistory.find((entry) => isDecodeMatch(entry.wsjt, message));
    if (!match) {
      this.ctx.log.warn('WSJT-X UDP Reply ignored: no matching decode in history', { message: message.message });
      return;
    }
    const type = match.message.message.type;
    const isCqLike = type === FT8MessageType.CQ || match.message.rawMessage.toUpperCase().startsWith('QRZ ');
    if (!isCqLike) {
      this.ctx.log.warn('WSJT-X UDP Reply ignored: matched decode is not CQ/QRZ', { message: message.message, type });
      return;
    }
    if (message.modifiers) {
      this.ctx.log.info('WSJT-X UDP Reply modifiers noted; TX-5DR currently applies normal reply behavior', { modifiers: message.modifiers });
    }
    const callsign = 'senderCallsign' in match.message.message ? match.message.message.senderCallsign : undefined;
    if (callsign) {
      this.ctx.operator.replyToDecode({
        callsign,
        lastMessage: {
          message: { snr: match.wsjt.snr, dt: match.wsjt.deltaTime, freq: match.wsjt.deltaFrequency, message: match.wsjt.message, confidence: match.wsjt.lowConfidence ? 0.5 : 1 },
          slotInfo: match.slotInfo,
        },
        modifiers: message.modifiers,
      });
    }
  }

  private handleHighlight(message: Extract<WsjtMessage, { kind: 'highlight-callsign' }>): void {
    if (message.callsign === 'CLEARALL!') {
      this.highlightRules.clear();
    } else if (this.highlightRules.size >= this.settings.maxHighlightRules && !this.highlightRules.has(message.callsign)) {
      this.ctx.log.warn('WSJT-X UDP highlight ignored: maxHighlightRules reached', { maxHighlightRules: this.settings.maxHighlightRules });
      return;
    } else {
      this.highlightRules.set(message.callsign, message);
    }
    this.ctx.operator.highlightCallsign({
      callsign: message.callsign,
      background: colorToCss(message.backgroundColor),
      foreground: colorToCss(message.foregroundColor),
      lastOnly: message.highlightLast,
    });
  }

  private async replayDecodes(): Promise<void> {
    for (const entry of this.decodeHistory) {
      await this.sendWsjtMessageToTargets(WsjtMessageType.Decode, { ...entry.wsjt, isNew: false });
    }
    await this.sendStatus();
  }

  private rememberDecode(entry: DecodeHistoryEntry): void {
    this.decodeHistory.push(entry);
    if (this.decodeHistory.length > 500) this.decodeHistory.splice(0, this.decodeHistory.length - 500);
  }

  private async sendWsjtMessageToTargets(type: WsjtMessageType, payload: object = {}): Promise<void> {
    if (!this.socket) return;
    await Promise.all(this.settings.targets.map((target) => {
      const schema = this.negotiatedSchemas.get(targetKey(target)) ?? WSJTX_UDP_SCHEMA;
      const datagram = encodeWsjtMessage(type, this.clientId(), payload, schema);
      return this.socket!.send(datagram, target.port, target.host).catch((error) => {
        this.ctx.log.warn('WSJT-X UDP send failed', { target, error: error instanceof Error ? error.message : String(error) });
      });
    }));
  }

  private clientId(): string {
    return this.settings.clientId.replace('{operatorId}', this.ctx.operator.id);
  }
}

function readTransmitMessage(snapshot: import('@tx5dr/plugin-api').StrategyRuntimeSnapshot | null): string {
  if (!snapshot?.slots) return '';
  return snapshot.slots.TX1 ?? snapshot.slots.TX2 ?? snapshot.slots.TX3 ?? snapshot.slots.TX4 ?? snapshot.slots.TX5 ?? snapshot.slots.TX6 ?? '';
}

function msFromSlot(slotInfo: SlotInfo): number {
  const epoch = Number.isFinite(slotInfo.startMs) ? slotInfo.startMs : slotInfo.utcSeconds * 1000;
  return ((Math.trunc(epoch) % 86_400_000) + 86_400_000) % 86_400_000;
}

function isDecodeMatch(left: WsjtDecodeMessage, right: Omit<WsjtDecodeMessage, 'isNew' | 'offAir'>): boolean {
  return left.timeMs === right.timeMs
    && left.snr === right.snr
    && Math.abs(left.deltaTime - right.deltaTime) < 0.000001
    && left.deltaFrequency === right.deltaFrequency
    && left.mode === right.mode
    && left.message === right.message
    && left.lowConfidence === right.lowConfidence;
}

function colorToCss(color: import('./wsjtx-types.js').WsjtColor): string | null {
  if (!color.valid) return null;
  const alpha = Math.max(0, Math.min(255, color.alpha ?? 255)) / 255;
  return `rgba(${color.red ?? 0}, ${color.green ?? 0}, ${color.blue ?? 0}, ${alpha.toFixed(3)})`;
}

function targetKey(target: UdpTarget): string {
  return `${target.host}:${target.port}`;
}

function isLoopbackAlias(host: string, address: string): boolean {
  const normalizedHost = host.toLowerCase();
  return (normalizedHost === 'localhost' || normalizedHost === '127.0.0.1') && (address === '127.0.0.1' || address === '::1');
}

function frameKey(message: string, frequency: number, dt?: number): string {
  return `${message}|${Math.trunc(frequency)}|${typeof dt === 'number' ? dt.toFixed(3) : ''}`;
}

function slotInfoFromSlotPack(currentSlotInfo: SlotInfo, slotPack: NonNullable<SlotActivityEvent['slotPack']>): SlotInfo {
  const packDurationMs = slotPack.endMs - slotPack.startMs;
  const slotMs = Number.isFinite(packDurationMs) && packDurationMs > 0
    ? packDurationMs
    : currentSlotInfo.mode === 'FT4' ? 7500 : 15000;
  return {
    ...currentSlotInfo,
    id: slotPack.slotId,
    startMs: slotPack.startMs,
    utcSeconds: Math.floor(slotPack.startMs / 1000),
    cycleNumber: Math.floor(slotPack.startMs / slotMs) % 2,
  };
}
