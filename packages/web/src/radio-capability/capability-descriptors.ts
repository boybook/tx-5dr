import type { CapabilityCategory, CapabilityDescriptor, CapabilityState } from '@tx5dr/contracts';

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
export interface CapabilityCategorySection {
  category: CapabilityCategory;
  items: CapabilityPanelEntry[];
  weight: number;
}

export interface CapabilityPanelColumns {
  left: CapabilityCategorySection[];
  right: CapabilityCategorySection[];
}

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

export function getCapabilityCategoryWeight(items: CapabilityPanelEntry[]): number {
  return items.length + 1;
}

export function getVisibleCapabilitySections(
  groups: CapabilityPanelGroups,
  categoryOrder: CapabilityCategory[] = CAPABILITY_CATEGORY_ORDER,
): CapabilityCategorySection[] {
  return categoryOrder.flatMap((category) => {
    const items = groups[category];
    if (!items || items.length === 0) {
      return [];
    }

    return [{
      category,
      items,
      weight: getCapabilityCategoryWeight(items),
    }];
  });
}
export function isCapabilityEntrySupported(
  entry: CapabilityPanelEntry,
  states: Map<string, CapabilityState>,
): boolean {
  if (entry.type === 'single') {
    return states.get(entry.item.id)?.supported ?? false;
  }
  return entry.items.some((item) => states.get(item.id)?.supported ?? false);
}

export function partitionCapabilityGroupsBySupport(
  groups: CapabilityPanelGroups,
  states: Map<string, CapabilityState>,
): { supported: CapabilityPanelGroups; unsupported: CapabilityPanelGroups } {
  const supported: CapabilityPanelGroups = {
    antenna: [],
    rf: [],
    audio: [],
    operation: [],
    system: [],
  };
  const unsupported: CapabilityPanelGroups = {
    antenna: [],
    rf: [],
    audio: [],
    operation: [],
    system: [],
  };

  for (const category of CAPABILITY_CATEGORY_ORDER) {
    for (const entry of groups[category]) {
      if (isCapabilityEntrySupported(entry, states)) {
        supported[category].push(entry);
      } else {
        unsupported[category].push(entry);
      }
    }
  }

  return { supported, unsupported };
}

export function splitCapabilitySectionsForColumns(
  sections: CapabilityCategorySection[],
): CapabilityPanelColumns {
  if (sections.length <= 1) {
    return {
      left: sections,
      right: [],
    };
  }

  const totalWeight = sections.reduce((sum, section) => sum + section.weight, 0);
  let bestSplitIndex = 1;
  let bestDiff = Number.POSITIVE_INFINITY;
  let leftWeight = 0;

  for (let index = 0; index < sections.length - 1; index += 1) {
    leftWeight += sections[index].weight;
    const rightWeight = totalWeight - leftWeight;
    const diff = Math.abs(leftWeight - rightWeight);

    if (diff < bestDiff) {
      bestDiff = diff;
      bestSplitIndex = index + 1;
    }
  }

  return {
    left: sections.slice(0, bestSplitIndex),
    right: sections.slice(bestSplitIndex),
  };
}
