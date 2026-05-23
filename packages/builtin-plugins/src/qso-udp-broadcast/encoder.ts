import type { QSORecord } from '@tx5dr/plugin-api';
import { convertQSOToADIF, generateADIFFile, resolveQsoComment } from '@tx5dr/plugin-api';
import { encodeQtByteArray, encodeWsjtMessage, msSinceUtcMidnight } from './wsjtx-codec.js';
import { WSJTX_UDP_MAGIC, WSJTX_UDP_SCHEMA, WsjtMessageType, UINT32_MAX, type WsjtDecodeMessage, type WsjtQsoLoggedMessage, type WsjtStatusMessage } from './wsjtx-types.js';

export const WSJT_UDP_MAGIC = WSJTX_UDP_MAGIC;
export const WSJT_UDP_SCHEMA = WSJTX_UDP_SCHEMA;
export const WSJT_LOGGED_ADIF_TYPE = WsjtMessageType.LoggedADIF;
export { encodeQtByteArray };

export function buildLoggedAdifDatagram(clientId: string, adifText: string): Buffer {
  return encodeWsjtMessage(WsjtMessageType.LoggedADIF, clientId, { adifText });
}

export function buildQsoLoggedDatagram(clientId: string, record: QSORecord): Buffer {
  return encodeWsjtMessage(WsjtMessageType.QSOLogged, clientId, qsoRecordToWsjtQsoLogged(record));
}

export function buildStatusDatagram(clientId: string, status: Partial<WsjtStatusMessage>): Buffer {
  return encodeWsjtMessage(WsjtMessageType.Status, clientId, status);
}

export function buildDecodeDatagram(clientId: string, decode: WsjtDecodeMessage): Buffer {
  return encodeWsjtMessage(WsjtMessageType.Decode, clientId, decode);
}

export function buildHeartbeatDatagram(clientId: string, version: string, revision = ''): Buffer {
  return encodeWsjtMessage(WsjtMessageType.Heartbeat, clientId, {
    maxSchema: WSJTX_UDP_SCHEMA,
    version,
    revision,
  });
}

export function buildCloseDatagram(clientId: string): Buffer {
  return encodeWsjtMessage(WsjtMessageType.Close, clientId);
}

export function buildClearDatagram(clientId: string): Buffer {
  return encodeWsjtMessage(WsjtMessageType.Clear, clientId);
}

export function buildAdifFile(record: QSORecord): string {
  return generateADIFFile([record], {
    programId: 'TX5DR',
    programVersion: '1.0',
    includeStationCallsign: true,
  });
}

export function buildRawAdifRecord(record: QSORecord): string {
  return convertQSOToADIF(record, {
    includeStationCallsign: true,
    includeMyGrid: true,
  });
}

export function qsoRecordToWsjtQsoLogged(record: QSORecord): WsjtQsoLoggedMessage {
  const timeOn = Number.isFinite(record.startTime) ? record.startTime : Date.now();
  const timeOff = Number.isFinite(record.endTime ?? NaN) ? record.endTime! : timeOn;
  return {
    timeOff,
    dxCall: record.callsign,
    dxGrid: record.grid ?? '',
    txFrequency: record.frequency,
    mode: record.mode,
    reportSent: record.reportSent ?? '',
    reportReceived: record.reportReceived ?? '',
    txPower: '',
    comments: resolveQsoComment(record) ?? '',
    name: '',
    timeOn,
    operatorCall: record.myCallsign ?? '',
    myCall: record.myCallsign ?? '',
    myGrid: record.myGrid ?? '',
    exchangeSent: '',
    exchangeReceived: '',
    adifPropagationMode: '',
    satellite: '',
    satMode: '',
    freqRx: '',
  };
}

export function parsedMessageToWsjtDecode(message: import('@tx5dr/plugin-api').ParsedFT8Message, isNew: boolean, lowConfidenceThreshold: number): WsjtDecodeMessage {
  const maybeConfidence = (message as unknown as { confidence?: unknown }).confidence;
  const confidence = typeof maybeConfidence === 'number'
    ? maybeConfidence
    : undefined;
  return {
    isNew,
    timeMs: msSinceUtcMidnight(message.timestamp),
    snr: Math.trunc(message.snr),
    deltaTime: message.dt,
    deltaFrequency: Math.max(0, Math.trunc(message.df)),
    mode: typeof message.rawMessage === 'string' ? inferModeFromSlot(message.slotId) : 'FT8',
    message: message.rawMessage,
    lowConfidence: typeof confidence === 'number' ? confidence < lowConfidenceThreshold : false,
    offAir: false,
  };
}

function inferModeFromSlot(slotId: string): string {
  const upper = slotId.toUpperCase();
  if (upper.includes('FT4')) return 'FT4';
  return 'FT8';
}

export { UINT32_MAX, WsjtMessageType };
