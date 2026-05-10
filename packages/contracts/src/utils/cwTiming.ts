/**
 * CW text to Morse timing encoder.
 *
 * Timing follows the ITU/PARIS convention:
 * - dit = 1200 / WPM ms
 * - dah = 3 dits
 * - intra-character gap = 1 dit
 * - character gap = 3 dits
 * - word gap = 7 dits
 */
export interface CWTimingEvent {
  type: 'key-down' | 'key-up';
  /** Delay from the previous event, in milliseconds. */
  afterMs: number;
}

const DOT_UNITS = {
  dit: 1,
  dah: 3,
  intraChar: 1,
  interChar: 3,
  interWord: 7,
} as const;

const MORSE_TABLE: Record<string, string> = {
  A: '.-',    B: '-...',  C: '-.-.',  D: '-..',
  E: '.',     F: '..-.',  G: '--.',   H: '....',
  I: '..',    J: '.---',  K: '-.-',   L: '.-..',
  M: '--',    N: '-.',    O: '---',   P: '.--.',
  Q: '--.-',  R: '.-.',   S: '...',   T: '-',
  U: '..-',   V: '...-',  W: '.--',   X: '-..-',
  Y: '-.--',  Z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--',
  '4': '....-', '5': '.....', '6': '-....', '7': '--...',
  '8': '---..', '9': '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', '/': '-..-.',
  '@': '.--.-.', '=': '-...-', '-': '-....-', '+': '.-.-.',
  ':': '---...', ';': '-.-.-.', '\'': '.----.', '"': '.-..-.',
  '!': '-.-.--', '&': '.-...', '(': '-.--.', ')': '-.--.-',
  '_': '..--.-', '$': '...-..-',
};

const PROSIGN_MAP: Record<string, string> = {
  '<AR>': '.-.-.',
  '<SK>': '...-.-',
  '<BT>': '-...-',
  '<KN>': '-.--.',
  '<BK>': '-...-.-',
};

/**
 * Encodes supported CW text into a sequence of timing events.
 */
export function encodeTextToCWEvents(text: string, wpm: number): CWTimingEvent[] {
  const safeWpm = Math.max(5, Math.min(60, Math.round(Number(wpm) || 20)));
  const dotMs = Math.round(1200 / safeWpm);
  const dashMs = dotMs * DOT_UNITS.dah;
  const intraCharMs = dotMs * DOT_UNITS.intraChar;
  const interCharMs = dotMs * DOT_UNITS.interChar;
  const interWordMs = dotMs * DOT_UNITS.interWord;
  const events: CWTimingEvent[] = [];

  let expanded = text.toUpperCase().trim();
  if (!expanded) {
    return events;
  }

  for (const [prosign, code] of Object.entries(PROSIGN_MAP)) {
    expanded = expanded.replaceAll(prosign, code);
  }

  const words = expanded.split(/\s+/).filter((word) => word.length > 0);
  let nextCharDelay = 0;

  for (let wi = 0; wi < words.length; wi += 1) {
    const chars = words[wi];

    for (let ci = 0; ci < chars.length; ci += 1) {
      const char = chars[ci];
      const code = MORSE_TABLE[char];

      if (!code) {
        continue;
      }

      const symbols = code.split('');

      for (let si = 0; si < symbols.length; si += 1) {
        const duration = symbols[si] === '-' ? dashMs : dotMs;

        events.push({
          type: 'key-down',
          afterMs: si === 0 ? nextCharDelay : intraCharMs,
        });
        events.push({ type: 'key-up', afterMs: duration });
      }

      if (ci < chars.length - 1) {
        nextCharDelay = interCharMs;
      } else {
        nextCharDelay = wi < words.length - 1 ? interWordMs : 0;
      }
    }
  }

  return events;
}

/**
 * Estimates total CW message duration from the first key-down to the final key-up.
 * Uses the PARIS timing base from Hamlib: dot milliseconds = 1200 / WPM.
 */
export function estimateCWMessageDurationMs(text: string, wpm: number): number {
  const safeWpm = Math.max(5, Math.min(60, Math.round(Number(wpm) || 20)));
  const dotUnits = countCWMessageDotUnits(text);
  if (dotUnits <= 0) {
    return 0;
  }
  return Math.ceil(dotUnits * (1200 / safeWpm));
}

function countCWMessageDotUnits(text: string): number {
  let expanded = text.toUpperCase().trim();
  if (!expanded) {
    return 0;
  }

  for (const [prosign, code] of Object.entries(PROSIGN_MAP)) {
    expanded = expanded.replaceAll(prosign, code);
  }

  const words = expanded.split(/\s+/).filter((word) => word.length > 0);
  let nextCharDelayUnits = 0;
  let totalUnits = 0;

  for (let wi = 0; wi < words.length; wi += 1) {
    const chars = words[wi];

    for (let ci = 0; ci < chars.length; ci += 1) {
      const char = chars[ci];
      const code = MORSE_TABLE[char];

      if (!code) {
        continue;
      }

      const symbols = code.split('');

      for (let si = 0; si < symbols.length; si += 1) {
        totalUnits += si === 0 ? nextCharDelayUnits : DOT_UNITS.intraChar;
        totalUnits += symbols[si] === '-' ? DOT_UNITS.dah : DOT_UNITS.dit;
      }

      if (ci < chars.length - 1) {
        nextCharDelayUnits = DOT_UNITS.interChar;
      } else {
        nextCharDelayUnits = wi < words.length - 1 ? DOT_UNITS.interWord : 0;
      }
    }
  }

  return totalUnits;
}
