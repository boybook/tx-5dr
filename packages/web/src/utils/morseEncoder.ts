/**
 * Client-side Morse code encoder.
 *
 * Converts plain text into a timed schedule of tone/silence events
 * suitable for driving a Web Audio API sidetone oscillator.
 *
 * Timing follows the PARIS standard:
 *   unit_ms = 1200 / wpm
 *   dit  = 1 unit
 *   dah  = 3 units
 *   intra-character gap = 1 unit
 *   inter-character gap = 3 units
 *   word gap            = 7 units
 */

const MORSE_TABLE: Record<string, string> = {
  A: '.-',   B: '-...', C: '-.-.', D: '-..',  E: '.',
  F: '..-.', G: '--.',  H: '....', I: '..',   J: '.---',
  K: '-.-',  L: '.-..', M: '--',   N: '-.',   O: '---',
  P: '.--.', Q: '--.-', R: '.-.',  S: '...',  T: '-',
  U: '..-',  V: '...-', W: '.--',  X: '-..-', Y: '-.--',
  Z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-',
  '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', '/': '-..-.',
  '=': '-...-',  ':': '---...', ';': '-.-.-.', '-': '-....-',
  "'": '.----.', '(': '-.--.',  ')': '-.--.-', '&': '.-...',
  '_': '..--.-', '"': '.-..-.', '@': '.--.-.',
  // Prosigns — keep as-is so users can embed them literally
  '<SK>': '...-.-', '<AR>': '.-.-.', '<BT>': '-...-',
  '<KN>': '-.--.', '<BK>': '-...-.-', '<CL>': '-.-..-..',
};

export interface MorseTimingEvent {
  /** true = key-down tone, false = silence */
  tone: boolean;
  /** Duration in milliseconds */
  durationMs: number;
}

function encodeChar(char: string, ditMs: number): MorseTimingEvent[] | null {
  const code = MORSE_TABLE[char];
  if (!code) return null;

  const events: MorseTimingEvent[] = [];
  for (let i = 0; i < code.length; i++) {
    const symbol = code[i];
    events.push({
      tone: true,
      durationMs: symbol === '.' ? ditMs : 3 * ditMs,
    });
    // Gap after this symbol
    if (i < code.length - 1) {
      events.push({ tone: false, durationMs: ditMs }); // intra-char
    } else {
      events.push({ tone: false, durationMs: 3 * ditMs }); // inter-char
    }
  }
  return events;
}

/**
 * Encode text into a schedule of timed tone/silence events.
 *
 * @param text  The plain-text message (already placeholder-resolved).
 * @param wpm   Words per minute (5-60).
 * @returns     Array of { tone, durationMs } events.
 */
export function encodeMorseSchedule(text: string, wpm: number): MorseTimingEvent[] {
  const ditMs = Math.round(1200 / Math.max(5, Math.min(60, wpm)));
  const upper = text.toUpperCase();

  // Fast path: expand known prosigns then split
  const expanded = upper
    .replace(/<SK>/g, '\x00')
    .replace(/<AR>/g, '\x01')
    .replace(/<BT>/g, '\x02')
    .replace(/<KN>/g, '\x03')
    .replace(/<BK>/g, '\x04')
    .replace(/<CL>/g, '\x05');

  // Collect events per character
  const charEvents: Array<MorseTimingEvent[] | null> = [];
  for (let i = 0; i < expanded.length; i++) {
    let ch = expanded[i];
    // Remap prosign placeholders
    if (ch === '\x00') ch = '<SK>';
    else if (ch === '\x01') ch = '<AR>';
    else if (ch === '\x02') ch = '<BT>';
    else if (ch === '\x03') ch = '<KN>';
    else if (ch === '\x04') ch = '<BK>';
    else if (ch === '\x05') ch = '<CL>';

    if (ch === ' ') {
      charEvents.push(null); // word boundary sentinel
    } else {
      charEvents.push(encodeChar(ch, ditMs));
    }
  }

  // Flatten into a single schedule, merging silences
  const schedule: MorseTimingEvent[] = [];

  for (let i = 0; i < charEvents.length; i++) {
    const evts = charEvents[i];
    if (evts === null) {
      // Word gap: the previous char already added 3-unit inter-char silence.
      // Add 4 more units to reach the 7-unit word gap.
      if (schedule.length > 0) {
        const last = schedule[schedule.length - 1];
        if (!last.tone) {
          last.durationMs += 4 * ditMs;
        } else {
          schedule.push({ tone: false, durationMs: 7 * ditMs });
        }
      }
      continue;
    }
    if (!evts || evts.length === 0) continue;

    // Append events, merging consecutive silences
    for (const evt of evts) {
      if (schedule.length > 0 && !evt.tone) {
        const last = schedule[schedule.length - 1];
        if (!last.tone) {
          last.durationMs += evt.durationMs;
          continue;
        }
      }
      schedule.push({ ...evt });
    }
  }

  return schedule;
}

/**
 * Estimate total playback duration in milliseconds.
 */
export function estimateMorseDuration(text: string, wpm: number): number {
  const schedule = encodeMorseSchedule(text, wpm);
  return schedule.reduce((sum, e) => sum + e.durationMs, 0);
}
