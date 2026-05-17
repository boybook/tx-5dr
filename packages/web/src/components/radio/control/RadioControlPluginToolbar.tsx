import * as React from 'react';
import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition, IconPack } from '@fortawesome/fontawesome-svg-core';
import { faPuzzlePiece, fas } from '@fortawesome/free-solid-svg-icons';
import { fab } from '@fortawesome/free-brands-svg-icons';
import type {
  PluginPanelDescriptor,
  PluginPanelMetaPayload,
  PluginStatus,
  PluginSystemSnapshot,
  PluginUIPanelContributionGroup,
  PluginUIPageDescriptor,
} from '@tx5dr/contracts';
import { UserRole } from '@tx5dr/contracts';
import { usePluginSnapshot } from '../../../hooks/usePluginSnapshot';
import { usePluginPanelMeta, type PanelMeta } from '../../../hooks/usePluginPanelMeta';
import { useHasMinRole } from '../../../store/authStore';
import { resolvePluginLabel, resolvePluginLabelWithValues, resolvePluginName } from '../../../utils/pluginLocales';
import { PluginIframeHost } from '../../plugins/PluginIframeHost';

const GLOBAL_PLUGIN_OPERATOR_ID = '__global__';
const RADIO_CONTROL_TOOLBAR_SLOT = 'radio-control-toolbar';

const TOOLBAR_BUTTON_CLASS = 'text-default-400 min-w-unit-6 min-w-6 w-6 h-6';
const TOOLBAR_ICON_CLASS = 'text-xs';

const POPOVER_SIZE_CLASS: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'w-64',
  md: 'w-80',
  lg: 'w-[28rem]',
};

const POPOVER_MIN_HEIGHT: Record<'sm' | 'md' | 'lg', number> = {
  sm: 180,
  md: 260,
  lg: 360,
};

const MODAL_SIZE: Record<'sm' | 'md' | 'lg', 'sm' | '2xl' | '4xl'> = {
  sm: 'sm',
  md: '2xl',
  lg: '4xl',
};

const MODAL_MIN_HEIGHT: Record<'sm' | 'md' | 'lg', number> = {
  sm: 260,
  md: 420,
  lg: 560,
};

interface ToolbarIconTooltipProps {
  label: string;
  children: React.ReactNode;
}

const ToolbarIconTooltip: React.FC<ToolbarIconTooltipProps> = ({ label, children }) => (
  <div className="relative flex items-center group/toolbar-tooltip">
    {children}
    <div
      aria-hidden="true"
      className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-content1 px-2 py-1 text-[11px] text-foreground shadow-medium opacity-0 transition-opacity duration-150 group-hover/toolbar-tooltip:opacity-100"
    >
      {label}
    </div>
  </div>
);

export interface RadioControlToolbarEntry {
  key: string;
  pluginName: string;
  pluginDisplayName: string;
  panel: PluginPanelDescriptor;
  page: PluginUIPageDescriptor;
  panelId: string;
  pageId: string;
  resolvedTitle: string;
  icon: string | undefined;
  openMode: 'popover' | 'modal';
  uiSize: 'sm' | 'md' | 'lg';
  pluginGeneration: number;
  initialPanelMeta: PluginPanelMetaPayload[];
  meta: PanelMeta;
}

function toFontAwesomeExportKey(iconName: string): string {
  if (/^fa[A-Z0-9]/.test(iconName)) {
    return iconName;
  }
  const pascal = iconName
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return `fa${pascal}`;
}

function getIconFromPack(pack: IconPack, rawName: string): IconDefinition | null {
  const normalized = rawName.trim();
  if (!normalized) {
    return null;
  }
  const direct = pack[normalized] ?? pack[toFontAwesomeExportKey(normalized)];
  if (direct) {
    return direct;
  }
  const normalizedLower = normalized.toLowerCase();
  return Object.values(pack).find((icon) =>
    icon.iconName.toLowerCase() === normalizedLower
    || icon.iconName.toLowerCase() === normalizedLower.replace(/^fa-/, '')
  ) ?? null;
}

export function resolveRadioToolbarIcon(rawIcon: string | undefined): IconDefinition {
  const icon = rawIcon?.trim();
  if (!icon) {
    return faPuzzlePiece;
  }

  const [prefix, ...rest] = icon.split(':');
  const hasPrefix = rest.length > 0;
  const name = hasPrefix ? rest.join(':') : icon;
  const normalizedPrefix = prefix.toLowerCase();

  if (hasPrefix && (normalizedPrefix === 'brand' || normalizedPrefix === 'brands' || normalizedPrefix === 'fab')) {
    return getIconFromPack(fab, name) ?? faPuzzlePiece;
  }
  if (hasPrefix && (normalizedPrefix === 'solid' || normalizedPrefix === 'fas')) {
    return getIconFromPack(fas, name) ?? faPuzzlePiece;
  }

  return getIconFromPack(fas, icon) ?? getIconFromPack(fab, icon) ?? faPuzzlePiece;
}

function pluginMatchesToolbar(plugin: PluginStatus): boolean {
  return plugin.loaded !== false
    && plugin.enabled
    && plugin.type === 'utility'
    && (plugin.instanceScope ?? 'operator') === 'global';
}

function contributionGroupMatchesGlobal(group: PluginUIPanelContributionGroup): boolean {
  if (group.source === 'manifest') {
    return true;
  }
  return group.instanceTarget?.kind === 'global';
}

function getContributionGroupsForPlugin(
  plugin: PluginStatus,
  contributionGroups: PluginUIPanelContributionGroup[],
): PluginUIPanelContributionGroup[] {
  const matchingGroups = contributionGroups.filter((group) =>
    group.pluginName === plugin.name && contributionGroupMatchesGlobal(group)
  );
  const hasManifestGroup = matchingGroups.some((group) => group.source === 'manifest' || group.groupId === 'manifest');
  if (hasManifestGroup || (plugin.panels ?? []).length === 0) {
    return matchingGroups;
  }
  return [
    {
      pluginName: plugin.name,
      groupId: 'manifest',
      source: 'manifest',
      panels: plugin.panels ?? [],
    },
    ...matchingGroups,
  ];
}

function canAccessPage(page: PluginUIPageDescriptor, canAccessOperator: boolean, canAccessAdmin: boolean): boolean {
  return (page.accessScope ?? 'admin') === 'operator'
    ? canAccessOperator
    : canAccessAdmin;
}

export function getRadioControlToolbarEntries(params: {
  plugins: PluginStatus[];
  panelContributions?: PluginSystemSnapshot['panelContributions'];
  getMeta: (pluginName: string, operatorId: string, panelId: string) => PanelMeta;
  canAccessOperator: boolean;
  canAccessAdmin: boolean;
  pluginGeneration: number;
  initialPanelMeta: PluginPanelMetaPayload[];
}): RadioControlToolbarEntry[] {
  const {
    plugins,
    panelContributions = [],
    getMeta,
    canAccessOperator,
    canAccessAdmin,
    pluginGeneration,
    initialPanelMeta,
  } = params;

  return plugins.flatMap((plugin) => {
    if (!pluginMatchesToolbar(plugin)) {
      return [];
    }
    const pageById = new Map((plugin.ui?.pages ?? []).map((page) => [page.id, page]));
    const groups = getContributionGroupsForPlugin(plugin, panelContributions ?? []);
    return groups.flatMap((group) => group.panels.flatMap((panel) => {
      if (
        panel.slot !== RADIO_CONTROL_TOOLBAR_SLOT
        || panel.component !== 'iframe'
        || !panel.pageId
      ) {
        return [];
      }
      const page = pageById.get(panel.pageId);
      if (!page || !canAccessPage(page, canAccessOperator, canAccessAdmin)) {
        return [];
      }

      const meta = getMeta(plugin.name, GLOBAL_PLUGIN_OPERATOR_ID, panel.id);
      if (meta.visible === false) {
        return [];
      }

      const staticTitle = resolvePluginLabel(panel.title, plugin.name);
      const resolvedTitle = meta.title !== undefined && meta.title !== null
        ? resolvePluginLabelWithValues(meta.title, plugin.name, meta.titleValues)
        : staticTitle;
      const pluginDisplayName = resolvePluginName(plugin.name, plugin.name);

      return [{
        key: `${plugin.name}:${group.groupId}:${panel.id}`,
        pluginName: plugin.name,
        pluginDisplayName,
        panel,
        page,
        panelId: panel.id,
        pageId: panel.pageId,
        resolvedTitle: resolvedTitle.trim().length > 0 ? resolvedTitle : pluginDisplayName,
        icon: panel.icon,
        openMode: panel.openMode ?? 'popover',
        uiSize: panel.uiSize ?? 'md',
        pluginGeneration,
        initialPanelMeta,
        meta,
      }];
    }));
  });
}

const RadioControlToolbarButton: React.FC<{ entry: RadioControlToolbarEntry }> = ({ entry }) => {
  const [isModalOpen, setIsModalOpen] = React.useState(false);
  const icon = resolveRadioToolbarIcon(entry.icon);
  const commonButton = (
    <Button
      isIconOnly
      variant="light"
      size="sm"
      className={TOOLBAR_BUTTON_CLASS}
      aria-label={entry.resolvedTitle}
      onPress={entry.openMode === 'modal' ? () => setIsModalOpen(true) : undefined}
    >
      <FontAwesomeIcon icon={icon} className={TOOLBAR_ICON_CLASS} />
    </Button>
  );

  if (entry.openMode === 'modal') {
    return (
      <>
        <ToolbarIconTooltip label={entry.resolvedTitle}>
          {commonButton}
        </ToolbarIconTooltip>
        <Modal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          size={MODAL_SIZE[entry.uiSize]}
          scrollBehavior="inside"
        >
          <ModalContent>
            <ModalHeader className="flex flex-col gap-0.5">
              <span>{entry.resolvedTitle}</span>
              <span className="text-xs font-normal text-default-400">{entry.pluginDisplayName}</span>
            </ModalHeader>
            <ModalBody className="p-0 overflow-hidden">
              <PluginIframeHost
                key={`${entry.pluginName}:${entry.pageId}:${entry.pluginGeneration}:modal`}
                pluginName={entry.pluginName}
                pageId={entry.pageId}
                params={{ panelId: entry.panelId, ...(entry.panel.params ?? {}) }}
                minHeight={MODAL_MIN_HEIGHT[entry.uiSize]}
                className="w-full"
              />
            </ModalBody>
          </ModalContent>
        </Modal>
      </>
    );
  }

  return (
    <ToolbarIconTooltip label={entry.resolvedTitle}>
      <Popover placement="bottom-start">
        <PopoverTrigger>
          {commonButton}
        </PopoverTrigger>
        <PopoverContent className={`max-w-[calc(100vw-2rem)] p-0 overflow-hidden ${POPOVER_SIZE_CLASS[entry.uiSize]}`}>
          <PluginIframeHost
            key={`${entry.pluginName}:${entry.pageId}:${entry.pluginGeneration}:popover`}
            pluginName={entry.pluginName}
            pageId={entry.pageId}
            params={{ panelId: entry.panelId, ...(entry.panel.params ?? {}) }}
            minHeight={POPOVER_MIN_HEIGHT[entry.uiSize]}
            className="w-full"
          />
        </PopoverContent>
      </Popover>
    </ToolbarIconTooltip>
  );
};

export const RadioControlPluginToolbar: React.FC = () => {
  const pluginSnapshot = usePluginSnapshot();
  const getMeta = usePluginPanelMeta(pluginSnapshot.panelMeta);
  const canAccessOperator = useHasMinRole(UserRole.OPERATOR);
  const canAccessAdmin = useHasMinRole(UserRole.ADMIN);

  const entries = React.useMemo(() => getRadioControlToolbarEntries({
    plugins: pluginSnapshot.plugins,
    panelContributions: pluginSnapshot.panelContributions,
    getMeta,
    canAccessOperator,
    canAccessAdmin,
    pluginGeneration: pluginSnapshot.generation,
    initialPanelMeta: pluginSnapshot.panelMeta ?? [],
  }), [
    canAccessAdmin,
    canAccessOperator,
    getMeta,
    pluginSnapshot.generation,
    pluginSnapshot.panelContributions,
    pluginSnapshot.panelMeta,
    pluginSnapshot.plugins,
  ]);

  if (entries.length === 0) {
    return null;
  }

  return (
    <>
      {entries.map((entry) => (
        <RadioControlToolbarButton key={entry.key} entry={entry} />
      ))}
    </>
  );
};
