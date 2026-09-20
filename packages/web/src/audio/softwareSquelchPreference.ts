/**
 * 监听软件静噪偏好。
 *
 * 语音模式下监听面板会用静噪状态(DCD)对监听输出做静音门:
 * - auto: 仅在 FM 类模式(WFM/FM/NFM 等)启用静噪门;SSB/AM/CW 等模式下
 *   hamlib DCD 不可靠(SSB 无载波时几乎恒为 closed),不启用
 * - on: 所有模式都启用静噪门
 * - off: 完全禁用静噪门
 */
export type SoftwareSquelchPreference = 'auto' | 'on' | 'off';

export const SOFTWARE_SQUELCH_PREFERENCES: readonly SoftwareSquelchPreference[] = ['auto', 'on', 'off'];
export const DEFAULT_SOFTWARE_SQUELCH_PREFERENCE: SoftwareSquelchPreference = 'auto';
export const SOFTWARE_SQUELCH_STORAGE_KEY = 'tx5dr.monitor.softwareSquelchPreference';

export function normalizeSoftwareSquelchPreference(value: unknown): SoftwareSquelchPreference {
  return SOFTWARE_SQUELCH_PREFERENCES.includes(value as SoftwareSquelchPreference)
    ? (value as SoftwareSquelchPreference)
    : DEFAULT_SOFTWARE_SQUELCH_PREFERENCE;
}

export function loadSoftwareSquelchPreference(): SoftwareSquelchPreference {
  try {
    const raw = window.localStorage.getItem(SOFTWARE_SQUELCH_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_SOFTWARE_SQUELCH_PREFERENCE;
    }
    return normalizeSoftwareSquelchPreference(JSON.parse(raw));
  } catch {
    return DEFAULT_SOFTWARE_SQUELCH_PREFERENCE;
  }
}

export function saveSoftwareSquelchPreference(preference: SoftwareSquelchPreference): void {
  try {
    window.localStorage.setItem(SOFTWARE_SQUELCH_STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // LocalStorage may be unavailable (private mode/quota); the preference stays in-memory only.
  }
}

/**
 * 判断电台模式是否为 FM 类(WFM/FM/NFM/PKTFM 等)。
 * hamlib 模式字符串大小写不定,统一按大写比较。
 */
export function isFmLikeRadioMode(radioMode: string | null | undefined): boolean {
  if (!radioMode) {
    return false;
  }
  const normalized = radioMode.trim().toUpperCase();
  return normalized.length > 0 && normalized.endsWith('FM');
}

/**
 * 静噪门在当前偏好与电台模式下是否生效。
 */
export function isSoftwareSquelchEffective(
  preference: SoftwareSquelchPreference,
  radioMode: string | null | undefined,
): boolean {
  if (preference === 'on') {
    return true;
  }
  if (preference === 'off') {
    return false;
  }
  return isFmLikeRadioMode(radioMode);
}
