export const WSJTX_UDP_MAGIC = 0xadbccbda;
export const WSJTX_UDP_SCHEMA = 3;
export const WSJTX_HEARTBEAT_SECONDS = 15;
export const UINT32_MAX = 0xffffffff;

export enum WsjtMessageType {
  Heartbeat = 0,
  Status = 1,
  Decode = 2,
  Clear = 3,
  Reply = 4,
  QSOLogged = 5,
  Close = 6,
  Replay = 7,
  HaltTx = 8,
  FreeText = 9,
  WSPRDecode = 10,
  Location = 11,
  LoggedADIF = 12,
  HighlightCallsign = 13,
  SwitchConfiguration = 14,
  Configure = 15,
  AnnotationInfo = 16,
}

export interface WsjtHeader {
  magic: number;
  schema: number;
  type: WsjtMessageType | number;
  id: string;
}

export interface WsjtColor {
  valid: boolean;
  red?: number;
  green?: number;
  blue?: number;
  alpha?: number;
}

export type WsjtMessage =
  | ({ kind: 'heartbeat'; maxSchema: number; version: string; revision: string } & WsjtHeader)
  | ({ kind: 'status' } & WsjtStatusMessage & WsjtHeader)
  | ({ kind: 'decode' } & WsjtDecodeMessage & WsjtHeader)
  | ({ kind: 'clear'; window?: number } & WsjtHeader)
  | ({ kind: 'reply' } & WsjtReplyMessage & WsjtHeader)
  | ({ kind: 'qso-logged' } & WsjtQsoLoggedMessage & WsjtHeader)
  | ({ kind: 'close' } & WsjtHeader)
  | ({ kind: 'replay' } & WsjtHeader)
  | ({ kind: 'halt-tx'; autoTxOnly: boolean } & WsjtHeader)
  | ({ kind: 'free-text'; text: string; send: boolean } & WsjtHeader)
  | ({ kind: 'wspr-decode' } & WsjtWsprDecodeMessage & WsjtHeader)
  | ({ kind: 'location'; location: string } & WsjtHeader)
  | ({ kind: 'logged-adif'; adifText: string } & WsjtHeader)
  | ({ kind: 'highlight-callsign'; callsign: string; backgroundColor: WsjtColor; foregroundColor: WsjtColor; highlightLast: boolean } & WsjtHeader)
  | ({ kind: 'switch-configuration'; configurationName: string } & WsjtHeader)
  | ({ kind: 'configure' } & WsjtConfigureMessage & WsjtHeader)
  | ({ kind: 'annotation-info'; dxCall: string; sortOrderProvided: boolean; sortOrder: number } & WsjtHeader)
  | ({ kind: 'unknown'; rawPayload: Uint8Array } & WsjtHeader);

export interface WsjtStatusMessage {
  dialFrequency: number;
  mode: string;
  dxCall: string;
  report: string;
  txMode: string;
  txEnabled: boolean;
  transmitting: boolean;
  decoding: boolean;
  rxDf: number;
  txDf: number;
  deCall: string;
  deGrid: string;
  dxGrid: string;
  txWatchdog: boolean;
  subMode: string;
  fastMode: boolean;
  specialOperationMode: number;
  frequencyTolerance: number;
  trPeriod: number;
  configurationName: string;
  txMessage: string;
}

export interface WsjtDecodeMessage {
  isNew: boolean;
  timeMs: number;
  snr: number;
  deltaTime: number;
  deltaFrequency: number;
  mode: string;
  message: string;
  lowConfidence: boolean;
  offAir: boolean;
}

export interface WsjtReplyMessage extends Omit<WsjtDecodeMessage, 'isNew' | 'offAir'> {
  modifiers: number;
}

export interface WsjtQsoLoggedMessage {
  timeOff: number;
  dxCall: string;
  dxGrid: string;
  txFrequency: number;
  mode: string;
  reportSent: string;
  reportReceived: string;
  txPower: string;
  comments: string;
  name: string;
  timeOn: number;
  operatorCall: string;
  myCall: string;
  myGrid: string;
  exchangeSent: string;
  exchangeReceived: string;
  adifPropagationMode: string;
  satellite: string;
  satMode: string;
  freqRx: string;
}

export interface WsjtWsprDecodeMessage {
  isNew: boolean;
  timeMs: number;
  snr: number;
  deltaTime: number;
  frequency: number;
  drift: number;
  callsign: string;
  grid: string;
  power: number;
  offAir: boolean;
}

export interface WsjtConfigureMessage {
  mode: string;
  frequencyTolerance: number;
  submode: string;
  fastMode: boolean;
  trPeriod: number;
  rxDf: number;
  dxCall: string;
  dxGrid: string;
  generateMessages: boolean;
}
