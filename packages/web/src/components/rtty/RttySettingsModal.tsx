import React, { useEffect, useRef, useState } from 'react';
import { addToast } from '@heroui/toast';
import {
  Modal, ModalBody, ModalContent, ModalHeader, Select, SelectItem, Slider, Switch, Input,
} from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { resolveRttyAudioTones, type RttyConfig, type RttyConfigPatch } from '@tx5dr/contracts';
import { useRtty } from '../../hooks/useRtty';
import { useCan } from '../../store/authStore';
import { describeRttyError } from './rttyErrors';

export const RTTY_PROFILE_OPTIONS = [
  { key: '45.45/170', baud: 45.45, shiftHz: 170 },
  { key: '50/170', baud: 50, shiftHz: 170 },
  { key: '75/170', baud: 75, shiftHz: 170 },
  { key: '50/425', baud: 50, shiftHz: 425 },
  { key: '50/850', baud: 50, shiftHz: 850 },
] as const;

function profileKey(config: RttyConfig): string {
  return RTTY_PROFILE_OPTIONS.find((option) => option.baud === config.baud && option.shiftHz === config.shiftHz)?.key
    ?? `${config.baud}/${config.shiftHz}`;
}

/**
 * A number field edited as text and committed on Enter, on blur and when the
 * modal closes (Esc / close button), not on every keystroke. Invalid values
 * snap back to the saved one.
 */
function useNumberDraft(saved: number, valid: (value: number) => boolean, commit: (value: number) => void) {
  const [draft, setDraft] = useState(String(saved));
  const dirtyRef = useRef(false);
  useEffect(() => {
    setDraft(String(saved));
    dirtyRef.current = false;
  }, [saved]);
  const flush = () => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    const value = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(value) && valid(value) && value !== saved) {
      commit(value);
    } else {
      setDraft(String(saved));
    }
  };
  return {
    value: draft,
    onValueChange: (value: string) => { dirtyRef.current = true; setDraft(value); },
    onBlur: flush,
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement> & { continuePropagation?: () => void }) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        flush();
        return;
      }
      // HeroUI (react-aria) stops key propagation once a handler is set: let
      // Escape reach the modal so it closes (and commits) as usual.
      event.continuePropagation?.();
    },
    flush,
  };
}

interface RttySettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const RttySettingsModal: React.FC<RttySettingsModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation('radio');
  const { config, txStatus, updateConfig } = useRtty();
  const canConfigure = useCan('update', 'RttyDecoderConfig');
  // Sliders move locally while dragging and save on release.
  const [squelch, setSquelch] = useState(config?.squelch ?? 0);
  const [scannerChannels, setScannerChannels] = useState(config?.scannerChannels ?? 6);
  useEffect(() => {
    if (!config) return;
    setSquelch(config.squelch);
    setScannerChannels(config.scannerChannels);
  }, [config]);
  const save = (patch: RttyConfigPatch) => {
    updateConfig(patch).catch((error: unknown) => {
      addToast({ title: t('rtty.settings.saveFailed', 'Could not change RTTY settings'), description: describeRttyError(error, t), color: 'danger' });
    });
  };
  const centerDraft = useNumberDraft(
    config?.centerHz ?? 0,
    (value) => value >= 300 && value <= 3000,
    (value) => save({ centerHz: Math.round(value) }),
  );
  const maxDraft = useNumberDraft(
    config?.maxTransmitSeconds ?? 0,
    (value) => Number.isInteger(value) && value >= 10 && value <= 1800,
    (value) => save({ maxTransmitSeconds: value }),
  );
  if (!config) return null;
  const tones = resolveRttyAudioTones(config);
  const handleClose = () => {
    centerDraft.flush();
    maxDraft.flush();
    onClose();
  };
  const disabled = !canConfigure;
  // Tones, shift and sideband cannot change mid-transmission (the server refuses).
  const signalDisabled = disabled || (txStatus?.active ?? false);

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="md" placement="center" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="text-base">{t('rtty.settings.title', 'RTTY settings')}</ModalHeader>
        <ModalBody className="gap-4 pb-6">
          <section className="flex flex-col gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-default-500">{t('rtty.settings.signal', 'Signal')}</h3>
            <Select
              size="sm"
              label={t('rtty.settings.profile', 'Speed / shift')}
              selectedKeys={[profileKey(config)]}
              isDisabled={signalDisabled}
              disallowEmptySelection
              onSelectionChange={(keys) => {
                if (keys === 'all') return;
                const option = RTTY_PROFILE_OPTIONS.find((item) => item.key === Array.from(keys)[0]);
                if (option) save({ baud: option.baud, shiftHz: option.shiftHz });
              }}
            >
              {RTTY_PROFILE_OPTIONS.map((option) => (
                <SelectItem key={option.key} textValue={`${option.baud} Bd / ${option.shiftHz} Hz`}>
                  {`${option.baud} Bd / ${option.shiftHz} Hz`}
                </SelectItem>
              ))}
            </Select>
            <div className="grid grid-cols-2 gap-3">
              <Select
                size="sm"
                label={t('rtty.settings.sideband', 'Radio sideband')}
                description={t('rtty.settings.sidebandHint', 'LSB is the amateur convention')}
                selectedKeys={[config.sideband]}
                isDisabled={signalDisabled}
                disallowEmptySelection
                onSelectionChange={(keys) => {
                  if (keys === 'all') return;
                  const value = Array.from(keys)[0];
                  if (value === 'lsb' || value === 'usb') save({ sideband: value });
                }}
              >
                <SelectItem key="lsb">LSB-D</SelectItem>
                <SelectItem key="usb">USB-D</SelectItem>
              </Select>
              <Input
                size="sm"
                type="number"
                label={t('rtty.settings.center', 'Audio centre (Hz)')}
                description={t('rtty.settings.tones', 'Mark {{mark}} · Space {{space}}', { mark: Math.round(tones.markHz), space: Math.round(tones.spaceHz) })}
                min={300}
                max={3000}
                value={centerDraft.value}
                onValueChange={centerDraft.onValueChange}
                onBlur={centerDraft.onBlur}
                onKeyDown={centerDraft.onKeyDown}
                isDisabled={signalDisabled}
              />
            </div>
            <Switch size="sm" isSelected={config.reverse} isDisabled={signalDisabled} onValueChange={(reverse) => save({ reverse })}>
              {t('rtty.settings.reverse', 'Reverse mark/space (REV)')}
            </Switch>
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-default-500">{t('rtty.settings.receive', 'Receive')}</h3>
            <Slider
              size="sm"
              label={t('rtty.settings.squelch', 'Squelch')}
              minValue={0}
              maxValue={0.8}
              step={0.05}
              value={squelch}
              isDisabled={disabled}
              onChange={(value) => setSquelch(Array.isArray(value) ? value[0]! : value)}
              onChangeEnd={(value) => save({ squelch: Array.isArray(value) ? value[0]! : value })}
              getValue={(value) => (Array.isArray(value) ? value[0]! : value) === 0 ? t('rtty.settings.squelchOff', 'Off') : String(Array.isArray(value) ? value[0] : value)}
            />
            <div className="grid grid-cols-2 gap-2">
              <Switch size="sm" isSelected={config.afc} isDisabled={disabled} onValueChange={(afc) => save({ afc })}>AFC</Switch>
              <Switch size="sm" isSelected={config.autoReverse} isDisabled={disabled} onValueChange={(autoReverse) => save({ autoReverse })}>
                {t('rtty.settings.autoReverse', 'Auto reverse')}
              </Switch>
              <Switch size="sm" isSelected={config.usos} isDisabled={disabled} onValueChange={(usos) => save({ usos })}>
                {t('rtty.settings.usos', 'Unshift on space')}
              </Switch>
              <Switch size="sm" isSelected={config.noiseBlanker} isDisabled={disabled} onValueChange={(noiseBlanker) => save({ noiseBlanker })}>
                {t('rtty.settings.noiseBlanker', 'Noise blanker')}
              </Switch>
            </div>
            <Select
              size="sm"
              label={t('rtty.settings.characterSet', 'Figures character set')}
              selectedKeys={[config.characterSet]}
              isDisabled={signalDisabled}
              disallowEmptySelection
              onSelectionChange={(keys) => {
                if (keys === 'all') return;
                const value = Array.from(keys)[0];
                if (value === 'usTty' || value === 'ita2') save({ characterSet: value });
              }}
            >
              <SelectItem key="usTty">US-TTY</SelectItem>
              <SelectItem key="ita2">ITA2</SelectItem>
            </Select>
            <div className="flex flex-col gap-2 rounded-lg bg-content2 p-3">
              <Switch size="sm" isSelected={config.scanner} isDisabled={disabled} onValueChange={(scanner) => save({ scanner })}>
                {t('rtty.settings.scanner', 'Signal browser')}
              </Switch>
              <p className="text-[11px] text-default-500">
                {t('rtty.settings.scannerHint', 'Finds and decodes other RTTY signals across the passband.')}
              </p>
              <Slider
                size="sm"
                label={t('rtty.settings.scannerChannels', 'Signals decoded at once')}
                minValue={1}
                maxValue={12}
                step={1}
                value={scannerChannels}
                isDisabled={disabled || !config.scanner}
                onChange={(value) => setScannerChannels(Array.isArray(value) ? value[0]! : value)}
                onChangeEnd={(value) => save({ scannerChannels: Array.isArray(value) ? value[0]! : value })}
              />
              <p className="text-[11px] text-default-500">
                {t('rtty.settings.scannerChannelsHint', 'More signals use more CPU.')}
              </p>
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-default-500">{t('rtty.settings.transmit', 'Transmit')}</h3>
            <div className="grid grid-cols-2 gap-3">
              <Select
                size="sm"
                label={t('rtty.settings.idle', 'While idle')}
                selectedKeys={[config.idle]}
                isDisabled={signalDisabled}
                disallowEmptySelection
                onSelectionChange={(keys) => {
                  if (keys === 'all') return;
                  const value = Array.from(keys)[0];
                  if (value === 'diddle' || value === 'mark') save({ idle: value });
                }}
              >
                <SelectItem key="diddle">{t('rtty.settings.idleDiddle', 'Diddle (LTRS)')}</SelectItem>
                <SelectItem key="mark">{t('rtty.settings.idleMark', 'Mark carrier')}</SelectItem>
              </Select>
              <Input
                size="sm"
                type="number"
                label={t('rtty.settings.maxTransmit', 'Max transmission (s)')}
                min={10}
                max={1800}
                value={maxDraft.value}
                onValueChange={maxDraft.onValueChange}
                onBlur={maxDraft.onBlur}
                onKeyDown={maxDraft.onKeyDown}
                isDisabled={disabled}
              />
            </div>
          </section>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
};
