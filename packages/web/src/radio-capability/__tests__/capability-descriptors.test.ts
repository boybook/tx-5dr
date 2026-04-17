import { describe, expect, it } from 'vitest';
import type { CapabilityDescriptor } from '@tx5dr/contracts';

import {
  getCapabilityCategoryWeight,
  getVisibleCapabilitySections,
  groupCapabilityDescriptors,
  splitCapabilitySectionsForColumns,
} from '../capability-descriptors';

function createDescriptor(
  id: string,
  category: CapabilityDescriptor['category'],
  compoundGroup?: string,
): CapabilityDescriptor {
  return {
    id,
    category,
    valueType: compoundGroup ? 'action' : 'boolean',
    readable: true,
    writable: true,
    updateMode: 'none',
    labelI18nKey: `radio:capability.${id}.label`,
    hasSurfaceControl: false,
    ...(compoundGroup ? { compoundGroup, compoundRole: id.endsWith('switch') ? 'switch' : 'action' } : {}),
  };
}

describe('capability descriptor layout helpers', () => {
  it('splits the current default desktop layout after audio for a balanced two-column view', () => {
    const grouped = groupCapabilityDescriptors([
      createDescriptor('tuner_switch', 'antenna', 'tuner'),
      createDescriptor('tuner_tune', 'antenna', 'tuner'),
      createDescriptor('rf_power', 'rf'),
      createDescriptor('nb', 'rf'),
      createDescriptor('nr', 'rf'),
      createDescriptor('af_gain', 'audio'),
      createDescriptor('sql', 'audio'),
      createDescriptor('mic_gain', 'audio'),
      createDescriptor('vox', 'audio'),
      createDescriptor('rit_offset', 'operation'),
      createDescriptor('xit_offset', 'operation'),
      createDescriptor('tuning_step', 'operation'),
      createDescriptor('repeater_shift', 'operation'),
      createDescriptor('repeater_offset', 'operation'),
      createDescriptor('ctcss_tone', 'operation'),
      createDescriptor('dcs_code', 'operation'),
      createDescriptor('lock_mode', 'system'),
      createDescriptor('mute', 'system'),
    ]);

    const sections = getVisibleCapabilitySections(grouped);
    const columns = splitCapabilitySectionsForColumns(sections);

    expect(columns.left.map((section) => section.category)).toEqual(['antenna', 'rf', 'audio']);
    expect(columns.right.map((section) => section.category)).toEqual(['operation', 'system']);
  });

  it('keeps a single visible category in one column', () => {
    const grouped = groupCapabilityDescriptors([
      createDescriptor('rf_power', 'rf'),
      createDescriptor('nb', 'rf'),
    ]);

    const sections = getVisibleCapabilitySections(grouped);
    const columns = splitCapabilitySectionsForColumns(sections);

    expect(columns.left.map((section) => section.category)).toEqual(['rf']);
    expect(columns.right).toEqual([]);
  });

  it('counts a compound group as one panel entry when estimating column weight', () => {
    const grouped = groupCapabilityDescriptors([
      createDescriptor('tuner_switch', 'antenna', 'tuner'),
      createDescriptor('tuner_tune', 'antenna', 'tuner'),
    ]);

    const sections = getVisibleCapabilitySections(grouped);

    expect(sections).toHaveLength(1);
    expect(sections[0].items).toHaveLength(1);
    expect(getCapabilityCategoryWeight(sections[0].items)).toBe(2);
  });
});
