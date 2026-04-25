import type { QSORecord } from '@tx5dr/plugin-api';
import { convertQSOToADIF, generateADIFFile } from '@tx5dr/plugin-api';

export const WSJT_UDP_MAGIC = 0xadbccbda;
export const WSJT_UDP_SCHEMA = 3;
export const WSJT_LOGGED_ADIF_TYPE = 12;

function writeUInt32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

export function encodeQtByteArray(value: string): Buffer {
  const payload = Buffer.from(value, 'utf8');
  return Buffer.concat([writeUInt32(payload.length), payload]);
}

export function buildLoggedAdifDatagram(clientId: string, adifText: string): Buffer {
  return Buffer.concat([
    writeUInt32(WSJT_UDP_MAGIC),
    writeUInt32(WSJT_UDP_SCHEMA),
    writeUInt32(WSJT_LOGGED_ADIF_TYPE),
    encodeQtByteArray(clientId),
    encodeQtByteArray(adifText),
  ]);
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
