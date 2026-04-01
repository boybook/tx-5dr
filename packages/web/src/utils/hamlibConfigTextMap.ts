import hamlibConfigTextZhMap from './hamlibConfigTextZhMap.json';

type HamlibConfigTextZhMap = {
  labels: Record<string, string>;
  tooltips: Record<string, string>;
};

const typedHamlibConfigTextZhMap = hamlibConfigTextZhMap as HamlibConfigTextZhMap;

export const HAMLIB_CONFIG_LABEL_ZH_MAP = typedHamlibConfigTextZhMap.labels;

export const HAMLIB_CONFIG_TOOLTIP_ZH_MAP = typedHamlibConfigTextZhMap.tooltips;

export function localizeHamlibConfigText(
  text: string | undefined,
  kind: 'label' | 'tooltip',
  language?: string,
): string | undefined {
  if (!text) {
    return text;
  }

  if (!language?.toLowerCase().startsWith('zh')) {
    return text;
  }

  const translations = kind === 'label' ? HAMLIB_CONFIG_LABEL_ZH_MAP : HAMLIB_CONFIG_TOOLTIP_ZH_MAP;
  return translations[text] ?? text;
}
