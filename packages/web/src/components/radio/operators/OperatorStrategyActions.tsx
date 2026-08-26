import * as React from 'react';
import type { StrategyActionDescriptor } from '@tx5dr/contracts';
import {
  Button,
  ButtonGroup,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Tooltip,
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faEllipsis } from '@fortawesome/free-solid-svg-icons';
import { resolvePluginIcon } from '../../plugins/pluginIcons';
import { useTranslation } from 'react-i18next';

interface OperatorStrategyActionsProps {
  actions: readonly StrategyActionDescriptor[];
  resolveLabel: (value: string) => string;
  onInvoke: (action: StrategyActionDescriptor, payload?: unknown) => void;
  onRequestSpectrumPick?: (action: StrategyActionDescriptor) => void;
  compact?: boolean;
}

const COLOR_BY_TONE: Record<NonNullable<StrategyActionDescriptor['tone']>, 'default' | 'primary' | 'success' | 'warning' | 'danger'> = {
  default: 'default',
  primary: 'primary',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
};

export function OperatorStrategyActions({
  actions,
  resolveLabel,
  onInvoke,
  onRequestSpectrumPick,
  compact = false,
}: OperatorStrategyActionsProps) {
  const { t } = useTranslation('radio');
  const [pending, setPending] = React.useState<StrategyActionDescriptor | null>(null);
  const [inputValue, setInputValue] = React.useState('');
  const segmented = actions.filter((action) => action.presentation === 'segmented');
  const visible = actions.filter((action) => action.presentation !== 'menu' && action.presentation !== 'segmented');
  const menu = actions.filter((action) => action.presentation === 'menu');

  const begin = (action: StrategyActionDescriptor) => {
    if (action.disabledReason) return;
    if (action.input || action.confirmation) {
      setPending(action);
      setInputValue(action.input?.value === undefined ? '' : String(action.input.value));
      return;
    }
    onInvoke(action);
  };

  const submitPending = () => {
    if (!pending) return;
    let payload: unknown;
    if (pending.input?.kind === 'text') payload = { value: inputValue };
    if (pending.input?.kind === 'number' || pending.input?.kind === 'audio-frequency') {
      const value = Number(inputValue);
      if (!Number.isFinite(value)) return;
      payload = { value };
    }
    onInvoke(pending, payload);
    setPending(null);
  };

  const renderButton = (action: StrategyActionDescriptor) => {
    const button = (
      <Button
        key={action.id}
        size="sm"
        variant={action.selected ? 'flat' : action.presentation === 'primary' ? 'solid' : 'light'}
        color={COLOR_BY_TONE[action.tone ?? (action.presentation === 'primary' ? 'primary' : 'default')]}
        isDisabled={Boolean(action.disabledReason)}
        className={compact ? 'h-6 min-w-6 px-1.5 text-[10px]' : 'h-7 px-2 text-xs'}
        onPress={() => begin(action)}
        startContent={action.icon ? <FontAwesomeIcon icon={resolvePluginIcon(action.icon)} className="text-[10px]" /> : undefined}
      >
        {resolveLabel(action.label)}
      </Button>
    );
    return action.disabledReason
      ? <Tooltip key={action.id} content={resolveLabel(action.disabledReason)}>{button}</Tooltip>
      : button;
  };

  if (actions.length === 0) return null;
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {segmented.length > 0 && <ButtonGroup size="sm">{segmented.map(renderButton)}</ButtonGroup>}
        {visible.map(renderButton)}
        {menu.length > 0 && (
          <Dropdown>
            <DropdownTrigger>
              <Button isIconOnly size="sm" variant="light" className={compact ? 'h-6 w-6 min-w-6' : 'h-7 w-7 min-w-7'} aria-label={t('operator.strategyActions.more')}>
                <FontAwesomeIcon icon={faEllipsis} />
              </Button>
            </DropdownTrigger>
            <DropdownMenu
              aria-label="Strategy actions"
              disabledKeys={menu.filter((action) => action.disabledReason).map((action) => action.id)}
              onAction={(key) => {
                const action = menu.find((candidate) => candidate.id === String(key));
                if (action) begin(action);
              }}
            >
              {menu.map((action) => (
                <DropdownItem key={action.id} description={action.description ? resolveLabel(action.description) : undefined}>
                  {resolveLabel(action.label)}
                </DropdownItem>
              ))}
            </DropdownMenu>
          </Dropdown>
        )}
      </div>

      <Modal isOpen={Boolean(pending)} onOpenChange={(open) => { if (!open) setPending(null); }} size="sm">
        <ModalContent>
          <ModalHeader>{pending ? resolveLabel(pending.confirmation?.title ?? pending.label) : ''}</ModalHeader>
          <ModalBody>
            {pending?.confirmation?.description && <p className="text-sm text-default-500">{resolveLabel(pending.confirmation.description)}</p>}
            {pending?.previewText && <div className="rounded-md bg-default-100 p-2 font-mono text-sm">{pending.previewText}</div>}
            {pending?.input && (
              <Input
                autoFocus
                type={pending.input.kind === 'text' ? 'text' : 'number'}
                label={pending.input.label ? resolveLabel(pending.input.label) : undefined}
                placeholder={pending.input.kind === 'text' && pending.input.placeholder ? resolveLabel(pending.input.placeholder) : undefined}
                value={inputValue}
                min={pending.input.kind === 'text' ? undefined : pending.input.min}
                max={pending.input.kind === 'text' ? undefined : pending.input.max}
                step={pending.input.kind === 'text' ? undefined : pending.input.step}
                maxLength={pending.input.kind === 'text' ? pending.input.maxLength : undefined}
                onValueChange={setInputValue}
              />
            )}
          </ModalBody>
          <ModalFooter>
            {pending?.input?.kind === 'audio-frequency' && pending.input.spectrumPick && onRequestSpectrumPick && (
              <Button variant="flat" onPress={() => { onRequestSpectrumPick(pending); setPending(null); }}>
                {t('operator.strategyActions.pickSpectrum')}
              </Button>
            )}
            <Button variant="light" onPress={() => setPending(null)}>{t('operator.strategyActions.cancel')}</Button>
            <Button color={COLOR_BY_TONE[pending?.tone ?? 'primary']} onPress={submitPending}>
              {pending ? resolveLabel(pending.confirmation?.confirmLabel ?? pending.label) : ''}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
