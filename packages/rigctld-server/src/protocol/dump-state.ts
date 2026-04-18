import type { RigctldIdentity } from '../types.js';

/**
 * Build the body of a `\dump_state` response.
 *
 * Format is the fixed multi-line protocol used by rigctld — reverse-engineered
 * from Hamlib's public `dumpcaps` docs and real `rigctld -m 2` captures. The
 * payload is consumed by N1MM / WSJT-X / fldigi to discover rig capabilities;
 * getting it wrong makes those clients reject the connection.
 *
 * Protocol version 0 (pre-Hamlib 3). Keep it minimal and self-consistent:
 *   line 1:  protocol version
 *   line 2:  rig model number
 *   line 3:  ITU region
 *   lines:   rx frequency ranges (5 integers, terminated by all-zero row)
 *   lines:   tx frequency ranges (same shape)
 *   lines:   tuning steps (mode_bitmap, step_hz), terminated by 0 0
 *   lines:   filter sizes (mode_bitmap, width_hz), terminated by 0 0
 *   line:    max_rit, max_xit, max_ifshift
 *   line:    announces bitmap
 *   line:    preamps (space-separated dB values, 0-terminated)
 *   line:    attenuators (same)
 *   line:    has_get_func, has_set_func (bitmaps)
 *   line:    has_get_level, has_set_level
 *   line:    has_get_parm, has_set_parm
 */
export function buildDumpState(identity: RigctldIdentity): string {
  const lines: string[] = [];

  // Protocol version. rigctld currently emits 0.
  lines.push('0');
  // Rig model.
  lines.push(String(identity.rigModel));
  // ITU region. We advertise region 2 (Americas); most logger software ignores
  // this but expects *some* number.
  lines.push('2');

  // RX ranges: startHz endHz modes lowPower highPower vfo ant
  // We advertise HF + 6m as a single wide range for all modes.
  // modes bitmap: AM|CW|USB|LSB|RTTY|FM|CWR|RTTYR|PKTUSB|PKTLSB|PKTFM = 0x1FF0B = 130827 (approximate Hamlib RIG_MODE_* bitmap)
  const MODE_BITMAP_ALL = '0x1ff';
  lines.push(`100000 60000000 ${MODE_BITMAP_ALL} -1 -1 0x3 0x0`);
  // Terminator row.
  lines.push('0 0 0 0 0 0 0');

  // TX ranges (same shape). TX low/high power in mW: 5000..100000.
  lines.push(`1800000 54000000 ${MODE_BITMAP_ALL} 5000 100000 0x3 0x0`);
  lines.push('0 0 0 0 0 0 0');

  // Tuning steps: mode_bitmap, step_hz.
  lines.push(`${MODE_BITMAP_ALL} 1`);
  lines.push(`${MODE_BITMAP_ALL} 10`);
  lines.push(`${MODE_BITMAP_ALL} 100`);
  lines.push(`${MODE_BITMAP_ALL} 1000`);
  lines.push('0 0');

  // Filter sizes: mode_bitmap, width_hz.
  lines.push(`${MODE_BITMAP_ALL} 2400`);
  lines.push(`${MODE_BITMAP_ALL} 500`);
  lines.push(`${MODE_BITMAP_ALL} 3000`);
  lines.push('0 0');

  // max_rit, max_xit, max_ifshift.
  lines.push('9999');
  lines.push('9999');
  lines.push('0');

  // announces bitmap.
  lines.push('0');

  // Preamps & attenuators (dB values, 0-terminated).
  lines.push('0');
  lines.push('20');

  // has_get_func / has_set_func (bitmaps). We don't implement any — 0/0.
  lines.push('0x0');
  lines.push('0x0');

  // has_get_level / has_set_level. 0x20000020 = RIG_LEVEL_AF | RIG_LEVEL_RFPOWER
  // (rough mapping — embedders can override). We use a conservative value that
  // at minimum advertises AF, SQL, RFPOWER read+write.
  const LEVEL_MASK = '0x4000002f';
  lines.push(LEVEL_MASK);
  lines.push(LEVEL_MASK);

  // has_get_parm / has_set_parm.
  lines.push('0x0');
  lines.push('0x0');

  // Trailing newline-terminated block; encodeResponse will add the RPRT.
  return lines.map((l) => `${l}\n`).join('');
}
