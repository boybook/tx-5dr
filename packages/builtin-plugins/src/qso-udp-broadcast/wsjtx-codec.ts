import {
  UINT32_MAX,
  WSJTX_UDP_MAGIC,
  WSJTX_UDP_SCHEMA,
  WsjtMessageType,
  type WsjtColor,
  type WsjtConfigureMessage,
  type WsjtDecodeMessage,
  type WsjtHeader,
  type WsjtMessage,
  type WsjtQsoLoggedMessage,
  type WsjtReplyMessage,
  type WsjtStatusMessage,
  type WsjtWsprDecodeMessage,
} from './wsjtx-types.js';

const UNIX_EPOCH_JULIAN_DAY = 2440588;
const MS_PER_DAY = 86_400_000;
const QCOLOR_SPEC_INVALID = 0;
const QCOLOR_SPEC_RGB = 1;
const QCOLOR_COMPONENT_SCALE = 257;

export class WsjtCodecError extends Error {}

class Writer {
  private chunks: Buffer[] = [];

  toBuffer(): Buffer { return Buffer.concat(this.chunks); }
  u8(value: number): void { const b = Buffer.allocUnsafe(1); b.writeUInt8(value & 0xff, 0); this.chunks.push(b); }
  bool(value: boolean): void { this.u8(value ? 1 : 0); }
  u16(value: number): void { const b = Buffer.allocUnsafe(2); b.writeUInt16BE(value & 0xffff, 0); this.chunks.push(b); }
  i32(value: number): void { const b = Buffer.allocUnsafe(4); b.writeInt32BE(value | 0, 0); this.chunks.push(b); }
  u32(value: number): void { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(value >>> 0, 0); this.chunks.push(b); }
  i64(value: number): void { const b = Buffer.allocUnsafe(8); b.writeBigInt64BE(BigInt(Math.trunc(value)), 0); this.chunks.push(b); }
  u64(value: number): void { const b = Buffer.allocUnsafe(8); b.writeBigUInt64BE(BigInt(Math.max(0, Math.trunc(value))), 0); this.chunks.push(b); }
  f64(value: number): void { const b = Buffer.allocUnsafe(8); b.writeDoubleBE(value, 0); this.chunks.push(b); }
  bytes(value: string): void { const payload = Buffer.from(value, 'utf8'); this.u32(payload.length); this.chunks.push(payload); }
  qtime(ms: number): void { this.u32(Math.max(0, Math.min(MS_PER_DAY - 1, Math.trunc(ms)))); }
  qdatetime(epochMs: number): void {
    const date = Number.isFinite(epochMs) ? Math.trunc(epochMs) : Date.now();
    const days = Math.floor(date / MS_PER_DAY);
    const ms = ((date % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
    this.i64(UNIX_EPOCH_JULIAN_DAY + days);
    this.qtime(ms);
    this.u8(1); // Qt::UTC
  }
  color(color: WsjtColor): void {
    if (!color.valid) {
      this.u8(QCOLOR_SPEC_INVALID);
      this.u16(0xffff); // QColor() invalid alpha value for Qt 5 streams.
      this.u16(0);
      this.u16(0);
      this.u16(0);
      this.u16(0);
      return;
    }
    this.u8(QCOLOR_SPEC_RGB);
    this.u16(colorByteToQt(color.alpha ?? 255));
    this.u16(colorByteToQt(color.red ?? 0));
    this.u16(colorByteToQt(color.green ?? 0));
    this.u16(colorByteToQt(color.blue ?? 0));
    this.u16(0);
  }
}

class Reader {
  constructor(private readonly buffer: Buffer, private offset = 0) {}
  remaining(): number { return this.buffer.length - this.offset; }
  rest(): Uint8Array { const out = this.buffer.subarray(this.offset); this.offset = this.buffer.length; return new Uint8Array(out); }
  private need(size: number): void { if (this.remaining() < size) throw new WsjtCodecError('UDP datagram ended before all required fields were read'); }
  u8(): number { this.need(1); const v = this.buffer.readUInt8(this.offset); this.offset += 1; return v; }
  bool(): boolean { return this.u8() !== 0; }
  u16(): number { this.need(2); const v = this.buffer.readUInt16BE(this.offset); this.offset += 2; return v; }
  i32(): number { this.need(4); const v = this.buffer.readInt32BE(this.offset); this.offset += 4; return v; }
  u32(): number { this.need(4); const v = this.buffer.readUInt32BE(this.offset); this.offset += 4; return v; }
  i64(): number { this.need(8); const v = Number(this.buffer.readBigInt64BE(this.offset)); this.offset += 8; return v; }
  u64(): number { this.need(8); const v = Number(this.buffer.readBigUInt64BE(this.offset)); this.offset += 8; return v; }
  f64(): number { this.need(8); const v = this.buffer.readDoubleBE(this.offset); this.offset += 8; return v; }
  bytes(): string { const len = this.u32(); if (len === UINT32_MAX) return ''; this.need(len); const v = this.buffer.subarray(this.offset, this.offset + len).toString('utf8'); this.offset += len; return v; }
  qtime(): number { return this.u32(); }
  qdatetime(): number {
    const julianDay = this.i64();
    const timeMs = this.qtime();
    const timeSpec = this.u8();
    let offsetSeconds = 0;
    if (timeSpec === 2 && this.remaining() >= 4) offsetSeconds = this.i32();
    const days = julianDay - UNIX_EPOCH_JULIAN_DAY;
    return days * MS_PER_DAY + timeMs - offsetSeconds * 1000;
  }
  color(): WsjtColor {
    if (this.remaining() < 11) return { valid: false };
    const spec = this.u8();
    const alpha = qtColorToByte(this.u16());
    const red = qtColorToByte(this.u16());
    const green = qtColorToByte(this.u16());
    const blue = qtColorToByte(this.u16());
    this.u16(); // QColor pad / fifth color component.
    return spec === QCOLOR_SPEC_INVALID ? { valid: false } : { valid: true, alpha, red, green, blue };
  }
}

function colorByteToQt(value: number): number {
  return Math.max(0, Math.min(255, Math.trunc(value))) * QCOLOR_COMPONENT_SCALE;
}

function qtColorToByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value / QCOLOR_COMPONENT_SCALE)));
}

export function msSinceUtcMidnight(epochMs: number): number {
  return ((Math.trunc(epochMs) % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
}

function writeHeader(writer: Writer, type: WsjtMessageType, id: string, schema = WSJTX_UDP_SCHEMA): void {
  writer.u32(WSJTX_UDP_MAGIC);
  writer.u32(Math.min(schema, WSJTX_UDP_SCHEMA));
  writer.u32(type);
  writer.bytes(id);
}

export function encodeWsjtMessage(type: WsjtMessageType, id: string, payload: object = {}, schema = WSJTX_UDP_SCHEMA): Buffer {
  const w = new Writer();
  const genericPayload = payload as Record<string, unknown>;
  writeHeader(w, type, id, schema);
  switch (type) {
    case WsjtMessageType.Heartbeat:
      w.u32((genericPayload.maxSchema as number | undefined) ?? WSJTX_UDP_SCHEMA);
      w.bytes(String(genericPayload.version ?? 'TX-5DR'));
      w.bytes(String(genericPayload.revision ?? ''));
      break;
    case WsjtMessageType.Status: {
      const p = payload as Partial<WsjtStatusMessage>;
      w.u64(p.dialFrequency ?? 0); w.bytes(p.mode ?? ''); w.bytes(p.dxCall ?? ''); w.bytes(p.report ?? ''); w.bytes(p.txMode ?? '');
      w.bool(p.txEnabled ?? false); w.bool(p.transmitting ?? false); w.bool(p.decoding ?? false); w.u32(p.rxDf ?? UINT32_MAX); w.u32(p.txDf ?? UINT32_MAX);
      w.bytes(p.deCall ?? ''); w.bytes(p.deGrid ?? ''); w.bytes(p.dxGrid ?? ''); w.bool(p.txWatchdog ?? false); w.bytes(p.subMode ?? '');
      w.bool(p.fastMode ?? false); w.u8(p.specialOperationMode ?? 0); w.u32(p.frequencyTolerance ?? UINT32_MAX); w.u32(p.trPeriod ?? UINT32_MAX); w.bytes(p.configurationName ?? ''); w.bytes(p.txMessage ?? '');
      break;
    }
    case WsjtMessageType.Decode: {
      const p = payload as Partial<WsjtDecodeMessage>;
      w.bool(p.isNew ?? true); w.qtime(p.timeMs ?? 0); w.i32(p.snr ?? 0); w.f64(p.deltaTime ?? 0); w.u32(p.deltaFrequency ?? 0); w.bytes(p.mode ?? ''); w.bytes(p.message ?? ''); w.bool(p.lowConfidence ?? false); w.bool(p.offAir ?? false);
      break;
    }
    case WsjtMessageType.Clear:
      if (typeof genericPayload.window === 'number') w.u8(genericPayload.window);
      break;
    case WsjtMessageType.Reply: {
      const p = payload as Partial<WsjtReplyMessage>;
      w.qtime(p.timeMs ?? 0); w.i32(p.snr ?? 0); w.f64(p.deltaTime ?? 0); w.u32(p.deltaFrequency ?? 0); w.bytes(p.mode ?? ''); w.bytes(p.message ?? ''); w.bool(p.lowConfidence ?? false); w.u8(p.modifiers ?? 0);
      break;
    }
    case WsjtMessageType.QSOLogged: {
      const p = payload as Partial<WsjtQsoLoggedMessage>;
      w.qdatetime(p.timeOff ?? Date.now()); w.bytes(p.dxCall ?? ''); w.bytes(p.dxGrid ?? ''); w.u64(p.txFrequency ?? 0); w.bytes(p.mode ?? ''); w.bytes(p.reportSent ?? ''); w.bytes(p.reportReceived ?? ''); w.bytes(p.txPower ?? ''); w.bytes(p.comments ?? ''); w.bytes(p.name ?? ''); w.qdatetime(p.timeOn ?? Date.now()); w.bytes(p.operatorCall ?? ''); w.bytes(p.myCall ?? ''); w.bytes(p.myGrid ?? ''); w.bytes(p.exchangeSent ?? ''); w.bytes(p.exchangeReceived ?? ''); w.bytes(p.adifPropagationMode ?? ''); w.bytes(p.satellite ?? ''); w.bytes(p.satMode ?? ''); w.bytes(p.freqRx ?? '');
      break;
    }
    case WsjtMessageType.Close:
    case WsjtMessageType.Replay:
      break;
    case WsjtMessageType.HaltTx:
      w.bool(Boolean(genericPayload.autoTxOnly));
      break;
    case WsjtMessageType.FreeText:
      w.bytes(String(genericPayload.text ?? '')); w.bool((genericPayload.send as boolean | undefined) ?? true);
      break;
    case WsjtMessageType.WSPRDecode: {
      const p = payload as Partial<WsjtWsprDecodeMessage>;
      w.bool(p.isNew ?? true); w.qtime(p.timeMs ?? 0); w.i32(p.snr ?? 0); w.f64(p.deltaTime ?? 0); w.u64(p.frequency ?? 0); w.i32(p.drift ?? 0); w.bytes(p.callsign ?? ''); w.bytes(p.grid ?? ''); w.i32(p.power ?? 0); w.bool(p.offAir ?? false);
      break;
    }
    case WsjtMessageType.Location:
      w.bytes(String(genericPayload.location ?? ''));
      break;
    case WsjtMessageType.LoggedADIF:
      w.bytes(String(genericPayload.adifText ?? ''));
      break;
    case WsjtMessageType.HighlightCallsign:
      w.bytes(String(genericPayload.callsign ?? '')); w.color((genericPayload.backgroundColor as WsjtColor | undefined) ?? { valid: false }); w.color((genericPayload.foregroundColor as WsjtColor | undefined) ?? { valid: false }); w.bool(Boolean(genericPayload.highlightLast));
      break;
    case WsjtMessageType.SwitchConfiguration:
      w.bytes(String(genericPayload.configurationName ?? ''));
      break;
    case WsjtMessageType.Configure: {
      const p = payload as Partial<WsjtConfigureMessage>;
      w.bytes(p.mode ?? ''); w.u32(p.frequencyTolerance ?? UINT32_MAX); w.bytes(p.submode ?? ''); w.bool(p.fastMode ?? false); w.u32(p.trPeriod ?? UINT32_MAX); w.u32(p.rxDf ?? UINT32_MAX); w.bytes(p.dxCall ?? ''); w.bytes(p.dxGrid ?? ''); w.bool(p.generateMessages ?? false);
      break;
    }
    case WsjtMessageType.AnnotationInfo:
      w.bytes(String(genericPayload.dxCall ?? '')); w.bool(Boolean(genericPayload.sortOrderProvided)); w.u32((genericPayload.sortOrder as number | undefined) ?? UINT32_MAX);
      break;
  }
  return w.toBuffer();
}

export function decodeWsjtMessage(data: Uint8Array): WsjtMessage {
  const r = new Reader(Buffer.from(data));
  const magic = r.u32();
  if (magic !== WSJTX_UDP_MAGIC) throw new WsjtCodecError('Invalid WSJT-X UDP magic');
  const schema = r.u32();
  if (schema > WSJTX_UDP_SCHEMA) throw new WsjtCodecError(`Unsupported WSJT-X UDP schema: ${schema}`);
  const type = r.u32();
  const id = r.bytes();
  const header: WsjtHeader = { magic, schema, type, id };
  switch (type) {
    case WsjtMessageType.Heartbeat: return { ...header, kind: 'heartbeat', maxSchema: r.remaining() >= 4 ? r.u32() : 2, version: r.remaining() ? r.bytes() : '', revision: r.remaining() ? r.bytes() : '' };
    case WsjtMessageType.Status: return { ...header, kind: 'status', dialFrequency: r.u64(), mode: r.bytes(), dxCall: r.bytes(), report: r.bytes(), txMode: r.bytes(), txEnabled: r.bool(), transmitting: r.bool(), decoding: r.bool(), rxDf: r.u32(), txDf: r.u32(), deCall: r.bytes(), deGrid: r.bytes(), dxGrid: r.bytes(), txWatchdog: r.bool(), subMode: r.bytes(), fastMode: r.bool(), specialOperationMode: r.u8(), frequencyTolerance: r.u32(), trPeriod: r.u32(), configurationName: r.bytes(), txMessage: r.bytes() };
    case WsjtMessageType.Decode: return { ...header, kind: 'decode', isNew: r.bool(), timeMs: r.qtime(), snr: r.i32(), deltaTime: r.f64(), deltaFrequency: r.u32(), mode: r.bytes(), message: r.bytes(), lowConfidence: r.bool(), offAir: r.bool() };
    case WsjtMessageType.Clear: return { ...header, kind: 'clear', window: r.remaining() ? r.u8() : undefined };
    case WsjtMessageType.Reply: return { ...header, kind: 'reply', timeMs: r.qtime(), snr: r.i32(), deltaTime: r.f64(), deltaFrequency: r.u32(), mode: r.bytes(), message: r.bytes(), lowConfidence: r.bool(), modifiers: r.u8() };
    case WsjtMessageType.QSOLogged: return { ...header, kind: 'qso-logged', timeOff: r.qdatetime(), dxCall: r.bytes(), dxGrid: r.bytes(), txFrequency: r.u64(), mode: r.bytes(), reportSent: r.bytes(), reportReceived: r.bytes(), txPower: r.bytes(), comments: r.bytes(), name: r.bytes(), timeOn: r.qdatetime(), operatorCall: r.bytes(), myCall: r.bytes(), myGrid: r.bytes(), exchangeSent: r.bytes(), exchangeReceived: r.bytes(), adifPropagationMode: r.bytes(), satellite: r.remaining() ? r.bytes() : '', satMode: r.remaining() ? r.bytes() : '', freqRx: r.remaining() ? r.bytes() : '' };
    case WsjtMessageType.Close: return { ...header, kind: 'close' };
    case WsjtMessageType.Replay: return { ...header, kind: 'replay' };
    case WsjtMessageType.HaltTx: return { ...header, kind: 'halt-tx', autoTxOnly: r.bool() };
    case WsjtMessageType.FreeText: return { ...header, kind: 'free-text', text: r.bytes(), send: r.bool() };
    case WsjtMessageType.WSPRDecode: return { ...header, kind: 'wspr-decode', isNew: r.bool(), timeMs: r.qtime(), snr: r.i32(), deltaTime: r.f64(), frequency: r.u64(), drift: r.i32(), callsign: r.bytes(), grid: r.bytes(), power: r.i32(), offAir: r.bool() };
    case WsjtMessageType.Location: return { ...header, kind: 'location', location: r.bytes() };
    case WsjtMessageType.LoggedADIF: return { ...header, kind: 'logged-adif', adifText: r.bytes() };
    case WsjtMessageType.HighlightCallsign: return { ...header, kind: 'highlight-callsign', callsign: r.bytes(), backgroundColor: r.color(), foregroundColor: r.color(), highlightLast: r.bool() };
    case WsjtMessageType.SwitchConfiguration: return { ...header, kind: 'switch-configuration', configurationName: r.bytes() };
    case WsjtMessageType.Configure: return { ...header, kind: 'configure', mode: r.bytes(), frequencyTolerance: r.u32(), submode: r.bytes(), fastMode: r.bool(), trPeriod: r.u32(), rxDf: r.u32(), dxCall: r.bytes(), dxGrid: r.bytes(), generateMessages: r.bool() };
    case WsjtMessageType.AnnotationInfo: return { ...header, kind: 'annotation-info', dxCall: r.bytes(), sortOrderProvided: r.bool(), sortOrder: r.u32() };
    default: return { ...header, kind: 'unknown', rawPayload: r.rest() };
  }
}

export function encodeQtByteArray(value: string): Buffer {
  const w = new Writer();
  w.bytes(value);
  return w.toBuffer();
}
