/**
 * CW 文本→莫尔斯时序编码器。
 *
 * 将文本字符串转换为精确的键控时序事件序列，
 * 供 CWKeyerManager 按时间轴依次执行硬件键控。
 *
 * 时序标准（ITU 莫尔斯码）：
 *   - 点 (dit) 持续时间   = 1200 / WPM 毫秒
 *   - 划 (dah) 持续时间   = 3 × 点持续时间
 *   - 点划间间隔           = 点持续时间
 *   - 字符间间隔           = 3 × 点持续时间
 *   - 单词间间隔           = 7 × 点持续时间
 */

export interface CWTimingEvent {
  type: 'key-down' | 'key-up';
  /** 距上一个事件执行时刻的延迟（毫秒） */
  afterMs: number;
}

/** 标准 ITU 莫尔斯码表 */
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

/** 常用 prosign 组合码 */
const PROSIGN_MAP: Record<string, string> = {
  '<AR>': '.-.-.',
  '<SK>': '...-.-',
  '<BT>': '-...-',
  '<KN>': '-.--.',
  '<BK>': '-...-.-',
};

/**
 * 将文本转换为 CW 键控时序事件序列。
 *
 * @param text - 原始文本（支持 A-Z, 0-9, 基本标点, prosign 如 <AR> <SK>）
 * @param wpm - 莫尔斯速度（每分钟单词数，5-60）
 * @returns 时序事件数组，按 afterMs 依次执行
 */
export function encodeTextToCWEvents(text: string, wpm: number): CWTimingEvent[] {
  const dotMs = Math.round(1200 / wpm);
  const dashMs = dotMs * 3;
  const intraCharMs = dotMs;
  const interCharMs = dotMs * 3;
  const interWordMs = dotMs * 7;
  const events: CWTimingEvent[] = [];

  let expanded = text.toUpperCase().trim();
  if (!expanded) {
    return events;
  }

  // 展开 prosign
  for (const [prosign, code] of Object.entries(PROSIGN_MAP)) {
    expanded = expanded.replaceAll(prosign, code);
  }

  const words = expanded.split(/\s+/).filter((w) => w.length > 0);

  // 下一字符首个 key-down 需等待的延迟
  let nextCharDelay = 0;

  for (let wi = 0; wi < words.length; wi++) {
    const chars = words[wi];

    for (let ci = 0; ci < chars.length; ci++) {
      const char = chars[ci];
      const code = MORSE_TABLE[char];

      if (!code) {
        continue;
      }

      const symbols = code.split('');

      for (let si = 0; si < symbols.length; si++) {
        const isDash = symbols[si] === '-';
        const duration = isDash ? dashMs : dotMs;

        if (si === 0) {
          // 第一个符号的 key-down：应用字符间延迟
          events.push({ type: 'key-down', afterMs: nextCharDelay });
        } else {
          // 后续符号的 key-down：点划间隔
          events.push({ type: 'key-down', afterMs: intraCharMs });
        }

        // key-up：符号持续时间后释放
        events.push({ type: 'key-up', afterMs: duration });
      }

      // 计算到下一字符的延迟
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
 * 计算文本发送所需总时长（毫秒）
 */
export function calculateCWDuration(text: string, wpm: number): number {
  const events = encodeTextToCWEvents(text, wpm);
  let total = 0;
  for (const e of events) {
    total += e.afterMs;
  }
  return total;
}
