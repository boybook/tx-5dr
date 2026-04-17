import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Tooltip,
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPowerOff, faMoon, faPlay, faSpinner } from '@fortawesome/free-solid-svg-icons';
import { addToast } from '@heroui/toast';
import { api } from '@tx5dr/core';
import { RadioConnectionStatus } from '@tx5dr/contracts';
import type { RadioPowerStateEvent, RadioPowerSupportInfo, RadioPowerTarget } from '@tx5dr/contracts';
import { useCan } from '../../../store/authStore';
import { useConnection, useRadioConnectionState, useProfiles } from '../../../store/radioStore';
import { useWSEvent } from '../../../hooks/useWSEvent';
import { createLogger } from '../../../utils/logger';

const logger = createLogger('PowerControlButton');

interface PowerControlButtonProps {
  profileId: string;
  /** 紧凑模式（Profile 卡片上的图标按钮）*/
  compact?: boolean;
  /** 开机成功后的回调（例如用于关闭 Profile 弹窗） */
  onPowerOnSuccess?: () => void;
}

const TARGET_ICON: Record<'operate' | 'standby' | 'off', typeof faPlay> = {
  operate: faPlay,
  standby: faMoon,
  off: faPowerOff,
};

export function PowerControlButton({ profileId, compact, onPowerOnSuccess }: PowerControlButtonProps) {
  const { t } = useTranslation('radio');
  const connection = useConnection();
  const { activeProfileId } = useProfiles();
  const radioConnection = useRadioConnectionState();
  const canPower = useCan('execute', 'RadioPower');

  const [support, setSupport] = useState<RadioPowerSupportInfo | null>(null);
  const [loadingSupport, setLoadingSupport] = useState(false);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<RadioPowerStateEvent | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<RadioPowerTarget | null>(null);
  const activeRequest = useRef(false);
  const lastTargetRef = useRef<RadioPowerTarget | null>(null);

  const isActive = activeProfileId === profileId;
  const isConnected =
    isActive && radioConnection.radioConnectionStatus === RadioConnectionStatus.CONNECTED;

  useEffect(() => {
    let cancelled = false;
    setLoadingSupport(true);
    api
      .getRadioPowerSupport(profileId)
      .then((info) => {
        if (!cancelled) setSupport(info);
      })
      .catch((error) => {
        logger.warn('Failed to fetch power support info', error);
      })
      .finally(() => {
        if (!cancelled) setLoadingSupport(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  useWSEvent(connection.state.radioService, 'radioPowerState' as any, (event: RadioPowerStateEvent) => {
    if (event.profileId && event.profileId !== profileId) return;
    setProgress(event);
    if (event.state === 'awake' && lastTargetRef.current === 'on') {
      onPowerOnSuccess?.();
    }
    if (event.state === 'awake' || event.state === 'off' || event.state === 'failed') {
      setPending(false);
      activeRequest.current = false;
      lastTargetRef.current = null;
    }
  });

  const triggerPower = useCallback(
    async (state: RadioPowerTarget) => {
      if (activeRequest.current) return;
      activeRequest.current = true;
      lastTargetRef.current = state;
      setPending(true);
      try {
        await api.setRadioPower({ profileId, state, autoEngine: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addToast({ title: t('power.error.timeout'), description: message, color: 'danger', timeout: 5000 });
        setPending(false);
        activeRequest.current = false;
        lastTargetRef.current = null;
      }
    },
    [profileId, t]
  );

  const unsupportedReason = useMemo(() => {
    if (!support) return null;
    if (support.reason === 'model-unsupported') return t('power.unsupported.modelUnsupported');
    if (support.reason === 'network-mode-no-wake') return t('power.unsupported.networkMode');
    if (support.reason === 'none-mode') return t('power.unsupported.noneMode');
    return null;
  }, [support, t]);

  const stateLabel = useMemo(() => {
    if (!progress) return null;
    switch (progress.state) {
      case 'waking':
        return t('power.state.waking');
      case 'awake':
        return t('power.state.awake');
      case 'shutting_down':
        return t('power.state.shuttingDown');
      case 'entering_standby':
        return t('power.state.enteringStandby');
      case 'off':
        return t('power.state.off');
      case 'failed':
        return t('power.state.failed');
      default:
        return null;
    }
  }, [progress, t]);

  const confirmText = useMemo(() => {
    if (!pendingConfirm) return null;
    if (pendingConfirm === 'off') return t('power.off.confirm');
    if (pendingConfirm === 'standby') return t('power.standby.confirm');
    return null;
  }, [pendingConfirm, t]);

  const handleConfirmProceed = useCallback(() => {
    const target = pendingConfirm;
    setPendingConfirm(null);
    if (target) void triggerPower(target);
  }, [pendingConfirm, triggerPower]);

  const handleSelect = useCallback(
    (target: RadioPowerTarget) => {
      if (target === 'off' || target === 'standby') {
        setPendingConfirm(target);
        return;
      }
      void triggerPower(target);
    },
    [triggerPower]
  );

  if (loadingSupport || !support) {
    return compact ? null : <span className="text-xs text-default-400">…</span>;
  }

  if (support.reason === 'none-mode') return null;
  if (!support.canPowerOn && !support.canPowerOff) {
    return compact ? null : (
      <Tooltip content={unsupportedReason} placement="top">
        <Button size="sm" isIconOnly variant="light" isDisabled>
          <FontAwesomeIcon icon={faPowerOff} className="text-default-300" />
        </Button>
      </Tooltip>
    );
  }

  // 未连接：开机按钮
  if (!isConnected) {
    const disabled = !canPower || !support.canPowerOn || pending;
    const tooltip = !support.canPowerOn
      ? unsupportedReason
      : pending && stateLabel
      ? stateLabel
      : t('power.on.description');
    const button = (
      <Button
        size={compact ? 'sm' : 'md'}
        isIconOnly={compact}
        color="success"
        variant={compact ? 'light' : 'flat'}
        isDisabled={disabled}
        isLoading={pending}
        onPress={() => {
          if (!support.canPowerOn) return;
          void triggerPower('on');
        }}
        startContent={!compact && !pending ? <FontAwesomeIcon icon={faPlay} fixedWidth /> : undefined}
        aria-label={t('power.on.label')}
      >
        {compact ? (
          pending ? (
            <FontAwesomeIcon icon={faSpinner} spin fixedWidth />
          ) : (
            <FontAwesomeIcon icon={faPlay} fixedWidth />
          )
        ) : (
          t('power.on.label')
        )}
      </Button>
    );
    return tooltip ? <Tooltip content={tooltip} placement="top">{button}</Tooltip> : button;
  }

  // 已连接：Select 下拉
  const supportedStates = support.supportedStates.length > 0
    ? support.supportedStates
    : (['off'] as Array<'operate' | 'standby' | 'off'>);

  // 紧凑模式（卡片右上角）：图标按钮触发 Dropdown 菜单，显示三个平级选项
  if (compact) {
    const disabled = !canPower || pending;
    return (
      <>
        <Dropdown placement="bottom-end">
          <DropdownTrigger>
            <Button
              size="sm"
              isIconOnly
              color="warning"
              variant="light"
              isDisabled={disabled}
              isLoading={pending}
              aria-label={t('power.dropdownLabel')}
            >
              <FontAwesomeIcon icon={faPowerOff} fixedWidth />
            </Button>
          </DropdownTrigger>
          <DropdownMenu
            aria-label={t('power.dropdownLabel')}
            onAction={(key) => handleSelect(String(key) as RadioPowerTarget)}
            classNames={{ base: 'max-w-[210px]' }}
            bottomContent={
              <p className="px-2 py-1.5 text-xs text-default-500 border-t border-divider whitespace-normal leading-snug">
                {t('power.compatibilityNote')}
              </p>
            }
          >
            {supportedStates.map((state) => (
              <DropdownItem
                key={state}
                color={state === 'off' ? 'danger' : undefined}
                startContent={<FontAwesomeIcon icon={TARGET_ICON[state]} fixedWidth className="w-4" />}
              >
                {t(`power.${state}.label`)}
              </DropdownItem>
            ))}
          </DropdownMenu>
        </Dropdown>
        <PowerConfirmModal
          target={pendingConfirm}
          text={confirmText}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={handleConfirmProceed}
          t={t}
        />
      </>
    );
  }

  // 非紧凑模式（编辑弹窗内）：平铺按钮组，定位为"测试触发"
  const disabled = !canPower || pending;
  return (
    <div className="flex flex-col gap-2 w-full">
      <div className="flex items-center gap-2 flex-wrap">
        {supportedStates.map((state) => (
          <Button
            key={state}
            size="sm"
            variant="flat"
            color={state === 'off' ? 'danger' : state === 'standby' ? 'warning' : 'default'}
            isDisabled={disabled}
            isLoading={pending && lastTargetRef.current === state}
            onPress={() => handleSelect(state)}
            startContent={<FontAwesomeIcon icon={TARGET_ICON[state]} fixedWidth className="w-4" />}
          >
            {t(`power.${state}.label`)}
          </Button>
        ))}
      </div>
      <p className="text-xs text-default-500 leading-snug">{t('power.compatibilityNote')}</p>
      <PowerConfirmModal
        target={pendingConfirm}
        text={confirmText}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={handleConfirmProceed}
        t={t}
      />
    </div>
  );
}

interface PowerConfirmModalProps {
  target: RadioPowerTarget | null;
  text: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}

function PowerConfirmModal({ target, text, onCancel, onConfirm, t }: PowerConfirmModalProps) {
  return (
    <Modal isOpen={target !== null} onClose={onCancel} size="sm" placement="center">
      <ModalContent>
        <ModalHeader>{t('power.confirmTitle')}</ModalHeader>
        <ModalBody>
          <p className="text-sm text-default-700">{text}</p>
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onCancel}>
            {t('common:button.cancel')}
          </Button>
          <Button color="danger" onPress={onConfirm}>
            {t('common:button.confirm')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
