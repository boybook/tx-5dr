import { describe, expect, it } from 'vitest';
import {
  WSJT_LOGGED_ADIF_TYPE,
  WSJT_UDP_MAGIC,
  WSJT_UDP_SCHEMA,
  buildLoggedAdifDatagram,
  encodeQtByteArray,
} from './encoder.js';

describe('qso-udp-broadcast encoder', () => {
  it('builds a WSJT/JTDX LoggedADIF Type 12 datagram', () => {
    const id = 'TX-5DR';
    const adif = '<adif_ver:5>3.1.4\n<programid:5>TX5DR\n<eoh>\n<call:6>N0CALL <eor>';
    const datagram = buildLoggedAdifDatagram(id, adif);

    let offset = 0;
    expect(datagram.readUInt32BE(offset)).toBe(WSJT_UDP_MAGIC);
    offset += 4;
    expect(datagram.readUInt32BE(offset)).toBe(WSJT_UDP_SCHEMA);
    offset += 4;
    expect(datagram.readUInt32BE(offset)).toBe(WSJT_LOGGED_ADIF_TYPE);
    offset += 4;

    const idLength = datagram.readUInt32BE(offset);
    offset += 4;
    expect(idLength).toBe(Buffer.byteLength(id));
    expect(datagram.subarray(offset, offset + idLength).toString('utf8')).toBe(id);
    offset += idLength;

    const adifLength = datagram.readUInt32BE(offset);
    offset += 4;
    expect(adifLength).toBe(Buffer.byteLength(adif));
    expect(datagram.subarray(offset, offset + adifLength).toString('utf8')).toBe(adif);
    offset += adifLength;
    expect(offset).toBe(datagram.length);
  });

  it('encodes Qt QByteArray length as byte count', () => {
    const encoded = encodeQtByteArray('é');
    expect(encoded.readUInt32BE(0)).toBe(2);
    expect(encoded.subarray(4).toString('utf8')).toBe('é');
  });
});
