import type { CapabilityCategory, CapabilityDescriptor } from '@tx5dr/contracts';

export const CAPABILITY_CATEGORY_ORDER: CapabilityCategory[] = [
  'antenna',
  'rf',
  'audio',
  'operation',
  'system',
];

export type CapabilityPanelEntry =
  | { type: 'compound'; groupId: string; items: CapabilityDescriptor[] }
  | { type: 'single'; item: CapabilityDescriptor };

export type CapabilityPanelGroups = Record<CapabilityCategory, CapabilityPanelEntry[]>;

export function groupCapabilityDescriptors(descriptors: CapabilityDescriptor[]): CapabilityPanelGroups {
  const grouped: CapabilityPanelGroups = {
    antenna: [],
    rf: [],
    audio: [],
    operation: [],
    system: [],
  };

  const processedGroups = new Set<string>();

  for (const descriptor of descriptors) {
    const categoryEntries = grouped[descriptor.category];
    if (!categoryEntries) {
      continue;
    }

    if (descriptor.compoundGroup) {
      if (processedGroups.has(descriptor.compoundGroup)) {
        continue;
      }

      processedGroups.add(descriptor.compoundGroup);
      categoryEntries.push({
        type: 'compound',
        groupId: descriptor.compoundGroup,
        items: descriptors.filter((item) => item.compoundGroup === descriptor.compoundGroup),
      });
      continue;
    }

    categoryEntries.push({
      type: 'single',
      item: descriptor,
    });
  }

  return grouped;
}
