/**
 * 电台能力静态描述符
 *
 * 这些描述符是前端副本，不通过网络传输。
 * 运行时状态（supported/value）由 radioCapabilityList WS 事件同步。
 */

import type { CapabilityDescriptor } from '@tx5dr/contracts';

export const CAPABILITY_DESCRIPTORS: CapabilityDescriptor[] = [
  // ===== 天线/天调 =====
  {
    id: 'tuner_switch',
    category: 'antenna',
    valueType: 'boolean',
    readable: true,
    writable: true,
    updateMode: 'polling',
    pollIntervalMs: 5000,
    compoundGroup: 'tuner',
    compoundRole: 'switch',
    labelI18nKey: 'radio:capability.tuner_switch.label',
    descriptionI18nKey: 'radio:capability.tuner_switch.description',
    hasSurfaceControl: true,
    surfaceGroup: 'tuner',
  },
  {
    id: 'tuner_tune',
    category: 'antenna',
    valueType: 'action',
    readable: false,
    writable: true,
    updateMode: 'none',
    compoundGroup: 'tuner',
    compoundRole: 'action',
    labelI18nKey: 'radio:capability.tuner_tune.label',
    descriptionI18nKey: 'radio:capability.tuner_tune.description',
    hasSurfaceControl: true,
    surfaceGroup: 'tuner',
  },

  // ===== 射频 =====
  {
    id: 'rf_power',
    category: 'rf',
    valueType: 'number',
    range: { min: 0, max: 1, step: 0.01 },
    readable: true,
    writable: true,
    updateMode: 'polling',
    pollIntervalMs: 10000,
    labelI18nKey: 'radio:capability.rf_power.label',
    descriptionI18nKey: 'radio:capability.rf_power.description',
    hasSurfaceControl: false,
  },

  // ===== 音频 =====
  {
    id: 'af_gain',
    category: 'audio',
    valueType: 'number',
    range: { min: 0, max: 1, step: 0.01 },
    readable: true,
    writable: true,
    updateMode: 'polling',
    pollIntervalMs: 10000,
    labelI18nKey: 'radio:capability.af_gain.label',
    descriptionI18nKey: 'radio:capability.af_gain.description',
    hasSurfaceControl: false,
  },
  {
    id: 'sql',
    category: 'audio',
    valueType: 'number',
    range: { min: 0, max: 1, step: 0.01 },
    readable: true,
    writable: true,
    updateMode: 'polling',
    pollIntervalMs: 10000,
    labelI18nKey: 'radio:capability.sql.label',
    descriptionI18nKey: 'radio:capability.sql.description',
    hasSurfaceControl: false,
  },
  {
    id: 'mic_gain',
    category: 'audio',
    valueType: 'number',
    range: { min: 0, max: 1, step: 0.01 },
    readable: true,
    writable: true,
    updateMode: 'polling',
    pollIntervalMs: 10000,
    labelI18nKey: 'radio:capability.mic_gain.label',
    descriptionI18nKey: 'radio:capability.mic_gain.description',
    hasSurfaceControl: false,
  },
  {
    id: 'nb',
    category: 'rf',
    valueType: 'number',
    range: { min: 0, max: 1, step: 0.01 },
    readable: true,
    writable: true,
    updateMode: 'polling',
    pollIntervalMs: 10000,
    labelI18nKey: 'radio:capability.nb.label',
    descriptionI18nKey: 'radio:capability.nb.description',
    hasSurfaceControl: false,
  },
  {
    id: 'nr',
    category: 'rf',
    valueType: 'number',
    range: { min: 0, max: 1, step: 0.01 },
    readable: true,
    writable: true,
    updateMode: 'polling',
    pollIntervalMs: 10000,
    labelI18nKey: 'radio:capability.nr.label',
    descriptionI18nKey: 'radio:capability.nr.description',
    hasSurfaceControl: false,
  },
];

/**
 * 按 ID 快速查找描述符
 */
export const CAPABILITY_DESCRIPTOR_MAP: Map<string, CapabilityDescriptor> = new Map(
  CAPABILITY_DESCRIPTORS.map((d) => [d.id, d])
);

/**
 * 按 compoundGroup 分组的描述符
 */
export function getCapabilityGroup(groupId: string): CapabilityDescriptor[] {
  return CAPABILITY_DESCRIPTORS.filter((d) => d.compoundGroup === groupId);
}

/**
 * 有 surface 控件的描述符（按 surfaceGroup 分组）
 */
export function getSurfaceGroups(): Map<string, CapabilityDescriptor[]> {
  const groups = new Map<string, CapabilityDescriptor[]>();
  for (const desc of CAPABILITY_DESCRIPTORS) {
    if (!desc.hasSurfaceControl) continue;
    const key = desc.surfaceGroup ?? desc.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(desc);
  }
  return groups;
}
