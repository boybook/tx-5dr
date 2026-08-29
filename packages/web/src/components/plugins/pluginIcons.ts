import type { IconDefinition, IconPack } from '@fortawesome/fontawesome-svg-core';
import { faPuzzlePiece, fas } from '@fortawesome/free-solid-svg-icons';
import { fab } from '@fortawesome/free-brands-svg-icons';

function toFontAwesomeExportKey(iconName: string): string {
  if (/^fa[A-Z0-9]/.test(iconName)) return iconName;
  const pascal = iconName
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return `fa${pascal}`;
}

function getIconFromPack(pack: IconPack, rawName: string): IconDefinition | null {
  const normalized = rawName.trim();
  if (!normalized) return null;
  const direct = pack[normalized] ?? pack[toFontAwesomeExportKey(normalized)];
  if (direct) return direct;
  const normalizedLower = normalized.toLowerCase();
  return Object.values(pack).find((icon) =>
    icon.iconName.toLowerCase() === normalizedLower
    || icon.iconName.toLowerCase() === normalizedLower.replace(/^fa-/, '')
  ) ?? null;
}

export function resolvePluginIcon(rawIcon: string | undefined): IconDefinition {
  const icon = rawIcon?.trim();
  if (!icon) return faPuzzlePiece;

  const [prefix, ...rest] = icon.split(':');
  const hasPrefix = rest.length > 0;
  const name = hasPrefix ? rest.join(':') : icon;
  const normalizedPrefix = prefix.toLowerCase();

  if (hasPrefix && ['brand', 'brands', 'fab'].includes(normalizedPrefix)) {
    return getIconFromPack(fab, name) ?? faPuzzlePiece;
  }
  if (hasPrefix && ['solid', 'fas'].includes(normalizedPrefix)) {
    return getIconFromPack(fas, name) ?? faPuzzlePiece;
  }
  return getIconFromPack(fas, icon) ?? getIconFromPack(fab, icon) ?? faPuzzlePiece;
}
