/**
 * 频率格式化工具。
 *
 * 代码库中频率统一以 Hz（整数）存储，显示时常需转为兆赫兹（MHz）文本。
 * 此前广泛使用 `(hz / 1_000_000).toFixed(3)`，当频率精度高于 1 kHz 时会被截断，
 * 因此改用本工具：小数位不足三位补零到三位，超过三位则保留所有有效位。
 */

/**
 * 将一个已经是 MHz 单位的数值格式化为可读文本。
 *
 * `toFixed(6)` 固定产生 6 位小数（Hz 粒度内的全部有效位），
 * 随后用正则删掉末尾至多 3 个零：4-6 位间的尾随零被清理，
 * 同时保证保留至少 3 位小数。
 *
 * @param mhz 已为 MHz 单位的数值
 * @returns 形如 `145.895` / `145.89525` / `7.000` 的字符串
 */
export function formatMHz(mhz: number): string {
  if (!Number.isFinite(mhz)) {
    return '0.000';
  }

  return mhz.toFixed(6).replace(/0{0,3}$/, '');
}

/**
 * 将 Hz 频率转换为 MHz 可读文本。
 *
 * @param frequencyHz 以 Hz 为单位的频率
 * @returns 形如 `145.895` / `145.89525` / `7.000` 的字符串
 */
export function formatFrequencyMHz(frequencyHz: number): string {
  return formatMHz(frequencyHz / 1_000_000);
}
