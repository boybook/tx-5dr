/**
 * RadioControlPanel - 电台控制面板 Modal
 *
 * 通过点击 RadioControl 中的电台名称按钮打开。
 * 按 category 分组渲染所有电台可控能力，使用 CapabilityRegistry 查找对应组件。
 */

import React, { useMemo } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
} from '@heroui/react';
import { useTranslation } from 'react-i18next';
import {
  CAPABILITY_CATEGORY_ORDER,
  groupCapabilityDescriptors,
} from '../../../radio-capability/capability-descriptors';
import { getPanelComponent, useCapabilityWriter } from '../../../radio-capability/CapabilityRegistry';
import {
  useCapabilityDescriptors,
  useCapabilityStates,
  useRadioState,
  useProfiles,
} from '../../../store/radioStore';
import type { CapabilityCategory, CapabilityDescriptor } from '@tx5dr/contracts';

interface RadioControlPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * 复合能力卡片（如天调开关+调谐按钮合并显示）
 */
const CompoundCard: React.FC<{
  descriptors: CapabilityDescriptor[];
  onWrite: (id: string, value?: boolean | number | string, action?: boolean) => void;
}> = ({ descriptors, onWrite }) => {
  const capabilityStates = useCapabilityStates();

  return (
    <div className="space-y-3 p-3 rounded-lg border border-divider bg-content2">
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
    <div className="p-3 rounded-lg border border-divider bg-content2">
      <Component
        capabilityId={descriptor.id}
        state={state}
        descriptor={descriptor}
        onWrite={onWrite}
      />
    </div>
  );
};

export const RadioControlPanel: React.FC<RadioControlPanelProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const { state: radioState } = useRadioState();
  const { activeProfile } = useProfiles();
  const capabilityDescriptors = useCapabilityDescriptors();
  const onWrite = useCapabilityWriter();

  // 按 category 分组，同一 compoundGroup 合并
  const groupedCapabilities = useMemo(() => {
    const descriptors = Array.from(capabilityDescriptors.values()).filter((descriptor) => Boolean(getPanelComponent(descriptor.id)));
    return groupCapabilityDescriptors(descriptors);
  }, [capabilityDescriptors]);

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

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-0.5">
          <span className="text-base">{t('radio:capability.panel.title')}</span>
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
            <div className="space-y-5">
              {CAPABILITY_CATEGORY_ORDER.map((cat) => {
                const items = groupedCapabilities[cat];
                if (!items || items.length === 0) return null;

                return (
                  <div key={cat}>
                    <h3 className="text-xs font-semibold text-default-500 uppercase tracking-wide mb-2">
                      {categoryLabels[cat]}
                    </h3>
                    <div className="space-y-2">
                      {items.map((entry) => {
                        if (entry.type === 'compound') {
                          return (
                            <CompoundCard
                              key={entry.groupId}
                              descriptors={entry.items}
                              onWrite={onWrite}
                            />
                          );
                        } else {
                          return (
                            <CapabilityCard
                              key={entry.item.id}
                              descriptor={entry.item}
                              onWrite={onWrite}
                            />
                          );
                        }
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
};
