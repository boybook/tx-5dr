import { promises as fs } from 'fs';
import { getDataFilePath } from '../utils/app-paths.js';
import { MessagePanelStore, type MessagePanelPreset } from '../keyboard/MessagePanelStore.js';

/**
 * Default RTTY macros. `{RX}` ends the transmission after the text, so a macro
 * pressed while idle keys up, sends and returns to receive.
 */
export const DEFAULT_RTTY_MESSAGE_SLOTS: MessagePanelPreset[] = [
  // Running: CQ (repeatable), exchange, thanks.
  { label: 'CQ', text: 'CQ CQ CQ DE {MYCALL} {MYCALL} {MYCALL} K {RX}', repeatIntervalSec: 8 },
  // Search and pounce: call a station, then send the report back.
  { label: 'CALL', text: '{HISCALL} DE {MYCALL} {MYCALL} K {RX}', repeatIntervalSec: 5 },
  { label: 'EXCH', text: '{HISCALL} UR {TRST} {TRST} DE {MYCALL} K {RX}', repeatIntervalSec: 5 },
  { label: 'R EXCH', text: '{HISCALL} R TU UR {TRST} {TRST} DE {MYCALL} K {RX}', repeatIntervalSec: 5 },
  { label: 'TU', text: '{HISCALL} TU 73 DE {MYCALL} SK {RX}', repeatIntervalSec: 5 },
  // No {RX}: keeps transmitting so it can be chained with typing or other macros.
  { label: 'MYCALL', text: '{MYCALL} {MYCALL} ', repeatIntervalSec: 5 },
  { label: 'AGN?', text: '{HISCALL} AGN? AGN? K {RX}', repeatIntervalSec: 5 },
  { label: 'QRZ?', text: 'QRZ? DE {MYCALL} K {RX}', repeatIntervalSec: 5 },
];

export function createRttyMessagePanels(getRootDir?: () => Promise<string>): MessagePanelStore {
  let rootDir: string | null = null;
  return new MessagePanelStore({
    getRootDir: getRootDir ?? (async () => {
      if (!rootDir) {
        rootDir = await getDataFilePath('rtty-keyer');
        await fs.mkdir(rootDir, { recursive: true });
      }
      return rootDir;
    }),
    presets: DEFAULT_RTTY_MESSAGE_SLOTS,
    fallbackLabel: (index) => `RTTY${index}`,
    modeLabel: 'RTTY',
  });
}
