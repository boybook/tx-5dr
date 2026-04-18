/**
 * RadioControlPanel - 电台控制面板 Modal
 *
 * 通过点击 RadioControl 中的电台名称按钮打开。
 * 按 category 分组渲染所有电台可控能力，使用 CapabilityRegistry 查找对应组件。
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  Tooltip,
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faRotateRight } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import {
  CAPABILITY_CATEGORY_ORDER,
  type CapabilityCategorySection,
  getVisibleCapabilitySections,
  groupCapabilityDescriptors,
  partitionCapabilityGroupsBySupport,
  splitCapabilitySectionsForColumns,
} from '../../../radio-capability/capability-descriptors';
import { getPanelComponent, useCapabilityWriter, useCapabilityRefresher } from '../../../radio-capability/CapabilityRegistry';
import {
  useCapabilityDescriptors,
  useCapabilityStates,
  useRadioState,
  useProfiles,
} from '../../../store/radioStore';
import type { CapabilityCategory, CapabilityDescriptor } from '@tx5dr/contracts';
import { PowerControlButton } from '../profile/PowerControlButton';

interface RadioControlPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

const MOBILE_MEDIA_QUERY = '(max-width: 767px)';

/**
 * 复合能力卡片（如天调开关+调谐按钮合并显示）
 */
const CompoundCard: React.FC<{
  descriptors: CapabilityDescriptor[];
  onWrite: (id: string, value?: boolean | number | string, action?: boolean) => void;
}> = ({ descriptors, onWrite }) => {
  const capabilityStates = useCapabilityStates();

  return (
    <div className="space-y-3 p-3 rounded-lg border border-default-200 bg-default-50/40">
      {descriptors.map((desc) => {
        const Component = getPanelComponent(desc.id);
        const state = capabilityStates.get(desc.id);
        if (!Component) return null;
        return (
          <Component
            key={desc.id}
            capabilityId={desc.id}
            state={state}
            descriptor={desc}
            onWrite={onWrite}
          />
        );
      })}
    </div>
  );
};

/**
 * 单个能力卡片
 */
const CapabilityCard: React.FC<{
  descriptor: CapabilityDescriptor;
  onWrite: (id: string, value?: boolean | number | string, action?: boolean) => void;
}> = ({ descriptor, onWrite }) => {
  const capabilityStates = useCapabilityStates();
  const Component = getPanelComponent(descriptor.id);
  const state = capabilityStates.get(descriptor.id);

  if (!Component) return null;

  return (
    <div className="p-3 rounded-lg border border-default-200 bg-default-50/40">
      <Component
        capabilityId={descriptor.id}
        state={state}
        descriptor={descriptor}
        onWrite={onWrite}
      />
    </div>
  );
};

const CapabilitySection: React.FC<{
  section: CapabilityCategorySection;
  categoryLabel: string;
  onWrite: (id: string, value?: boolean | number | string, action?: boolean) => void;
}> = ({ section, categoryLabel, onWrite }) => (
  <div>
    <h3 className="text-xs font-semibold text-default-500 uppercase tracking-wide mb-2">
      {categoryLabel}
    </h3>
    <div className="space-y-2">
      {section.items.map((entry) => {
        if (entry.type === 'compound') {
          return (
            <CompoundCard
              key={entry.groupId}
              descriptors={entry.items}
              onWrite={onWrite}
            />
          );
        }

        return (
          <CapabilityCard
            key={entry.item.id}
            descriptor={entry.item}
            onWrite={onWrite}
          />
        );
      })}
    </div>
  </div>
);

export const RadioControlPanel: React.FC<RadioControlPanelProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const { state: radioState } = useRadioState();
  const { activeProfile } = useProfiles();
  const capabilityDescriptors = useCapabilityDescriptors();
  const onWrite = useCapabilityWriter();
  const { refresh: refreshCapabilities, isRefreshing } = useCapabilityRefresher();
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia(MOBILE_MEDIA_QUERY);

    setIsMobile(mediaQuery.matches);

    const handleChange = (event: MediaQueryListEvent) => {
      setIsMobile(event.matches);
    };

    mediaQuery.addEventListener('change', handleChange);

    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, []);

  const capabilityStates = useCapabilityStates();
  const [showUnsupported, setShowUnsupported] = useState(false);

  // 按 category 分组，同一 compoundGroup 合并
  const groupedCapabilities = useMemo(() => {
    const descriptors = Array.from(capabilityDescriptors.values()).filter((descriptor) => Boolean(getPanelComponent(descriptor.id)));
    return groupCapabilityDescriptors(descriptors);
  }, [capabilityDescriptors]);

  const { supportedGroups, unsupportedGroups } = useMemo(() => {
    const { supported, unsupported } = partitionCapabilityGroupsBySupport(groupedCapabilities, capabilityStates);
    return { supportedGroups: supported, unsupportedGroups: unsupported };
  }, [groupedCapabilities, capabilityStates]);

  const supportedSections = useMemo(
    () => getVisibleCapabilitySections(supportedGroups),
    [supportedGroups],
  );
  const unsupportedSections = useMemo(
    () => getVisibleCapabilitySections(unsupportedGroups),
    [unsupportedGroups],
  );

  const supportedColumns = useMemo(
    () => splitCapabilitySectionsForColumns(supportedSections),
    [supportedSections],
  );
  const unsupportedColumns = useMemo(
    () => splitCapabilitySectionsForColumns(unsupportedSections),
    [unsupportedSections],
  );

  const hasSupported = supportedSections.length > 0;
  const hasUnsupported = unsupportedSections.length > 0;

  const categoryLabels = useMemo(
    () => Object.fromEntries(
      CAPABILITY_CATEGORY_ORDER.map((category) => [
        category,
        t(`radio:capability.panel.${category}`),
      ]),
    ) as Record<CapabilityCategory, string>,
    [t],
  );

  const radioName = activeProfile?.name ?? t('radio:connection.none');
  const isNoRadioMode = radioState.radioConfig?.type === 'none';

  const renderSectionGroup = (
    sections: CapabilityCategorySection[],
    columns: { left: CapabilityCategorySection[]; right: CapabilityCategorySection[] },
  ) => {
    const useDesktopColumns = !isMobile && columns.right.length > 0;
    if (useDesktopColumns) {
      return (
        <div className="grid grid-cols-2 gap-5">
          <div className="space-y-5">
            {columns.left.map((section) => (
              <CapabilitySection
                key={section.category}
                section={section}
                categoryLabel={categoryLabels[section.category]}
                onWrite={onWrite}
              />
            ))}
          </div>
          <div className="space-y-5">
            {columns.right.map((section) => (
              <CapabilitySection
                key={section.category}
                section={section}
                categoryLabel={categoryLabels[section.category]}
                onWrite={onWrite}
              />
            ))}
          </div>
        </div>
      );
    }
    return (
      <div className="space-y-5">
        {sections.map((section) => (
          <CapabilitySection
            key={section.category}
            section={section}
            categoryLabel={categoryLabels[section.category]}
            onWrite={onWrite}
          />
        ))}
      </div>
    );
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size={isMobile ? 'sm' : '3xl'} scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-base">{t('radio:capability.panel.title')}</span>
            <div className="flex items-center">
              {activeProfile && (
                <PowerControlButton profileId={activeProfile.id} compact />
              )}
              <Tooltip content={t('radio:capability.panel.refresh')}>
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  onPress={refreshCapabilities}
                  isLoading={isRefreshing}
                  isDisabled={!radioState.radioConnected || isRefreshing}
                  startContent={isRefreshing ? undefined : <FontAwesomeIcon icon={faRotateRight} className="text-xs" />}
                />
              </Tooltip>
            </div>
          </div>
          <span className="text-xs text-default-400 font-normal">{radioName}</span>
        </ModalHeader>
        <ModalBody className="pb-6">
          {isNoRadioMode ? (
            <p className="text-sm text-default-400 text-center py-4">
              {t('radio:capability.panel.noRadioMode')}
            </p>
          ) : !radioState.radioConnected ? (
            <p className="text-sm text-default-400 text-center py-4">
              {t('radio:capability.panel.notConnected')}
            </p>
          ) : (
            <div className="space-y-6">
              {hasSupported ? (
                renderSectionGroup(supportedSections, supportedColumns)
              ) : (
                <p className="text-sm text-default-400 text-center py-2">
                  {t('radio:capability.panel.noSupported')}
                </p>
              )}
              {hasUnsupported && (
                <div className="border-t border-divider pt-4">
                  <button
                    type="button"
                    onClick={() => setShowUnsupported((prev) => !prev)}
                    className="flex w-full items-center justify-between text-xs font-semibold text-default-500 uppercase tracking-wide hover:text-default-700 transition-colors"
                    aria-expanded={showUnsupported}
                  >
                    <span>{t('radio:capability.panel.unsupportedGroup')}</span>
                    <FontAwesomeIcon
                      icon={faChevronDown}
                      className={`text-xs transition-transform ${showUnsupported ? 'rotate-180' : ''}`}
                    />
                  </button>
                  {showUnsupported && (
                    <div className="mt-3">
                      {renderSectionGroup(unsupportedSections, unsupportedColumns)}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
};
