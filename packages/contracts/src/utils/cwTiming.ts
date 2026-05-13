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

export interface CWKeyStateSegment {
  /** true when the key/tone is closed, false for silence/open key. */
  keyDown: boolean;
  /** Segment duration in milliseconds. */
  durationMs: number;
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
  '<CL>': '-.-..-..',
};

const PROSIGN_TOKENS = Object.keys(PROSIGN_MAP).sort((a, b) => b.length - a.length);

/**
 * Encodes supported CW text into a sequence of timing events.
 */
export function encodeTextToCWEvents(text: string, wpm: number): CWTimingEvent[] {
  const events: CWTimingEvent[] = [];
  let nextEventDelayMs = 0;

  for (const segment of encodeTextToCWKeyStateSegments(text, wpm)) {
    if (!segment.keyDown) {
      nextEventDelayMs += segment.durationMs;
      continue;
    }

    events.push({ type: 'key-down', afterMs: nextEventDelayMs });
    events.push({ type: 'key-up', afterMs: segment.durationMs });
    nextEventDelayMs = 0;
  }

  return events;
}

/**
 * Encodes supported CW text into key-down/silence duration segments.
 * This is the shared adapter input for browser sidetone and other local keying outputs.
 */
export function encodeTextToCWKeyStateSegments(text: string, wpm: number): CWKeyStateSegment[] {
  const dotMs = getRoundedDotMs(wpm);
  const tokenizedWords = tokenizeText(text);
  const segments: CWKeyStateSegment[] = [];
  let firstToken = true;

  for (const word of tokenizedWords) {
    for (let ti = 0; ti < word.length; ti += 1) {
      if (!firstToken) {
        appendSegment(segments, false, (ti === 0 ? DOT_UNITS.interWord : DOT_UNITS.interChar) * dotMs);
      }

      appendCodeSegments(segments, word[ti], dotMs);
      firstToken = false;
    }
  }

  return segments;
}

/**
 * Estimates total CW message duration from the first key-down to the final key-up.
 * Uses the PARIS timing base from Hamlib: dot milliseconds = 1200 / WPM.
 */
export function estimateCWMessageDurationMs(text: string, wpm: number): number {
  const safeWpm = getSafeWpm(wpm);
  const dotUnits = countCWMessageDotUnits(text);
  if (dotUnits <= 0) {
    return 0;
  }
  return Math.ceil(dotUnits * (1200 / safeWpm));
}

function appendCodeSegments(segments: CWKeyStateSegment[], code: string, dotMs: number): void {
  for (let si = 0; si < code.length; si += 1) {
    if (si > 0) {
      appendSegment(segments, false, DOT_UNITS.intraChar * dotMs);
    }
    appendSegment(segments, true, (code[si] === '-' ? DOT_UNITS.dah : DOT_UNITS.dit) * dotMs);
  }
}

function appendSegment(segments: CWKeyStateSegment[], keyDown: boolean, durationMs: number): void {
  if (durationMs <= 0) {
    return;
  }
  const previous = segments[segments.length - 1];
  if (previous?.keyDown === keyDown) {
    previous.durationMs += durationMs;
    return;
  }
  segments.push({ keyDown, durationMs });
}

function countCWMessageDotUnits(text: string): number {
  const tokenizedWords = tokenizeText(text);
  let firstToken = true;
  let totalUnits = 0;

  for (const word of tokenizedWords) {
    for (let ti = 0; ti < word.length; ti += 1) {
      if (!firstToken) {
        totalUnits += ti === 0 ? DOT_UNITS.interWord : DOT_UNITS.interChar;
      }

      const code = word[ti];
      for (let si = 0; si < code.length; si += 1) {
        totalUnits += si === 0 ? 0 : DOT_UNITS.intraChar;
        totalUnits += code[si] === '-' ? DOT_UNITS.dah : DOT_UNITS.dit;
      }
      firstToken = false;
    }
  }

  return totalUnits;
}

function tokenizeText(text: string): string[][] {
  const normalized = text.toUpperCase().trim();
  if (!normalized) {
    return [];
  }

  return normalized
    .split(/\s+/)
    .map(tokenizeWord)
    .filter((word) => word.length > 0);
}

function tokenizeWord(word: string): string[] {
  const codes: string[] = [];
  let index = 0;

  while (index < word.length) {
    const prosign = PROSIGN_TOKENS.find((token) => word.startsWith(token, index));
    if (prosign) {
      codes.push(PROSIGN_MAP[prosign]);
      index += prosign.length;
      continue;
    }

    const code = MORSE_TABLE[word[index]];
    if (code) {
      codes.push(code);
    }
    index += 1;
  }

  return codes;
}

function getRoundedDotMs(wpm: number): number {
  return Math.round(1200 / getSafeWpm(wpm));
}

function getSafeWpm(wpm: number): number {
  return Math.max(5, Math.min(60, Math.round(Number(wpm) || 20)));
}
