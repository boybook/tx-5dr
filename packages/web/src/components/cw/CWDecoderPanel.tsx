import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Chip,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Switch,
  Tooltip,
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBroom, faGear, faMicrochip, faSatelliteDish, faUserTag } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import { useCWDecoder } from '../../hooks/useCWDecoder';
import { setCWQSOHisCallsign } from '../../store/cwQsoDraftStore';
import { useCan } from '../../store/authStore';
import { openExternal } from '../../utils/openExternal';

const CALLSIGN_RE = /\b(?:[A-Z]{1,2}\d[A-Z0-9]{1,4}|[A-Z0-9]{1,3}\d[A-Z]{1,4})\b/i;
const DEFAULT_MODEL_SIZES = ['tiny', 'small'] as const;
const GPU_RUNTIME_BACKEND = 'coreml';

interface DecoderSettingsDraft {
  backend: string;
  modelSize: string;
  runtimeBackend: string;
}

interface BackendAttribution {
  name: string;
  sourceUrl: string;
  license: string;
}

const BACKEND_ATTRIBUTIONS: Record<string, BackendAttribution> = {
  'deepcw-onnx': {
    name: 'DeepCW / web-deep-cw-decoder',
    sourceUrl: 'https://github.com/e04/web-deep-cw-decoder',
    license: 'GPL-3.0',
  },
};

function extractCallsign(text: string): string | null {
  const match = text.toUpperCase().match(CALLSIGN_RE);
  return match?.[0] ?? null;
}

function stringList(value: unknown, fallback: readonly string[]): string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : [...fallback];
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getBackendLabel(backend: { id?: string; label?: string; name?: unknown } | null | undefined): string {
  return backend?.label ?? (typeof backend?.name === 'string' ? backend.name : undefined) ?? backend?.id ?? '';
}

function getBackendAttribution(backendId: string, backend: Record<string, unknown> | null | undefined): BackendAttribution | null {
  const descriptorUrl = readString(backend?.sourceUrl) ?? readString(backend?.projectUrl);
  if (descriptorUrl) {
    return {
      name: readString(backend?.attributionName) ?? getBackendLabel(backend) ?? backendId,
      sourceUrl: descriptorUrl,
      license: readString(backend?.license) ?? 'Open source',
    };
  }
  return BACKEND_ATTRIBUTIONS[backendId] ?? null;
}

function makeSettingsDraft(backend: string, modelSize: string, runtimeBackend: string): DecoderSettingsDraft {
  return { backend, modelSize, runtimeBackend };
}

export function CWDecoderPanel() {
  const { t } = useTranslation('radio');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<DecoderSettingsDraft | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const canControlDecoder = useCan('execute', 'CWDecoder');
  const canConfigureDecoder = useCan('update', 'CWDecoderConfig');
  const {
    config,
    backends,
    effectiveBackend,
    status,
    pendingText,
    confirmedText,
    confirmedSegments,
    loading,
    error,
    start,
    stop,
    updateConfig,
    clearTranscript,
  } = useCWDecoder();

  const backendId = status.backend ?? config?.backend ?? effectiveBackend?.id ?? '';
  const modelSize = String(config?.modelSize ?? config?.model ?? status.model ?? effectiveBackend?.model ?? 'tiny');
  const runtimeBackend = String(config?.runtimeBackend ?? config?.runtime ?? status.runtime ?? effectiveBackend?.runtime ?? 'cpu');
  const model = (status.model ?? modelSize) || t('cw.decoder.modelUnknown', 'default');
  const runtime = (status.runtime ?? runtimeBackend) || t('cw.decoder.runtimeUnknown', 'auto');
  const isEnabled = status.enabled || status.running || status.state === 'starting';
  const showDecoderDetails = isEnabled || status.state === 'stopping';
  const statusColor = status.state === 'error'
    ? 'danger'
    : status.running
      ? 'success'
      : status.state === 'starting' || status.state === 'stopping'
        ? 'warning'
        : 'default';
  const callsign = useMemo(() => extractCallsign(confirmedText), [confirmedText]);
  const hasTranscript = Boolean(confirmedText || pendingText);
  const renderedPendingText = pendingText && confirmedText ? ` ${pendingText}` : pendingText;
  const draft = settingsDraft ?? makeSettingsDraft(backendId, modelSize, runtimeBackend);
  const draftBackend = backends.find(item => item.id === draft.backend) ?? effectiveBackend;
  const draftBackendLabel = getBackendLabel(draftBackend) || draft.backend || t('cw.decoder.backendUnknown', 'backend');
  const draftAttribution = getBackendAttribution(draft.backend, draftBackend);
  const modelSizeOptions = stringList(draftBackend?.modelSizes, DEFAULT_MODEL_SIZES);
  const normalizedDraftModelSize = modelSizeOptions.includes(draft.modelSize) ? draft.modelSize : modelSizeOptions[0] ?? draft.modelSize;
  const isGpuRuntime = draft.runtimeBackend !== 'cpu';
  const settingsChanged = draft.backend !== backendId
    || normalizedDraftModelSize !== modelSize
    || draft.runtimeBackend !== runtimeBackend;

  useEffect(() => {
    if (!settingsOpen) return;
    setSettingsDraft(makeSettingsDraft(backendId, modelSize, runtimeBackend));
  }, [backendId, modelSize, runtimeBackend, settingsOpen]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    transcript.scrollTop = transcript.scrollHeight;
  }, [confirmedText, pendingText, showDecoderDetails]);

  const handleEnabledChange = (enabled: boolean) => {
    if (!canControlDecoder) return;
    if (enabled) {
      void start();
    } else {
      void stop();
    }
  };

  const handleBackendChange = (key: React.Key) => {
    if (!canConfigureDecoder) return;
    const nextBackendId = String(key);
    const nextBackend = backends.find(item => item.id === nextBackendId);
    const nextModelSizes = stringList(nextBackend?.modelSizes, DEFAULT_MODEL_SIZES);
    setSettingsDraft(prev => {
      const current = prev ?? makeSettingsDraft(backendId, modelSize, runtimeBackend);
      return {
        ...current,
        backend: nextBackendId,
        modelSize: nextModelSizes.includes(current.modelSize) ? current.modelSize : nextModelSizes[0] ?? current.modelSize,
      };
    });
  };

  const handleModelSizeChange = (key: React.Key) => {
    if (!canConfigureDecoder) return;
    setSettingsDraft(prev => ({
      ...(prev ?? makeSettingsDraft(backendId, modelSize, runtimeBackend)),
      modelSize: String(key),
    }));
  };

  const handleGpuModeChange = (enabled: boolean) => {
    if (!canConfigureDecoder) return;
    setSettingsDraft(prev => ({
      ...(prev ?? makeSettingsDraft(backendId, modelSize, runtimeBackend)),
      runtimeBackend: enabled ? GPU_RUNTIME_BACKEND : 'cpu',
    }));
  };

  const openSettings = () => {
    if (!canConfigureDecoder) return;
    setSettingsDraft(makeSettingsDraft(backendId, modelSize, runtimeBackend));
    setSettingsOpen(true);
  };

  const closeSettings = () => {
    setSettingsOpen(false);
    setSettingsDraft(null);
    setSavingSettings(false);
  };

  const saveSettings = async () => {
    if (!canConfigureDecoder || !settingsChanged || savingSettings) return;
    setSavingSettings(true);
    try {
      await updateConfig({
        backend: draft.backend,
        modelSize: normalizedDraftModelSize,
        runtimeBackend: draft.runtimeBackend,
      });
      closeSettings();
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <>
      <div className="flex-shrink-0 rounded-xl bg-content1/80 p-3 shadow-sm ring-1 ring-default-200/60">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FontAwesomeIcon icon={faSatelliteDish} />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-semibold text-foreground">{t('cw.decoder.title', 'CW Decoder')}</span>
                <Chip size="sm" color={statusColor} variant="flat" className="h-5 text-[10px]">
                  {t(`cw.decoder.state.${status.state}`, status.state)}
                </Chip>
              </div>
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-default-500">
                <FontAwesomeIcon icon={faMicrochip} className="text-[10px]" />
                <span className="truncate">{backendId || t('cw.decoder.backendUnknown', 'backend')}</span>
                <span>·</span>
                <span className="truncate">{model}</span>
                <span>·</span>
                <span className="truncate">{runtime}</span>
                <Tooltip content={canConfigureDecoder ? t('cw.decoder.settings', 'Decoder settings') : t('cw.decoder.configPermissionRequired', 'No permission to change decoder settings')}>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="light"
                    className="ml-0.5 h-5 min-w-5 text-default-500"
                    aria-label={t('cw.decoder.settings', 'Decoder settings')}
                    isDisabled={!canConfigureDecoder}
                    onPress={openSettings}
                  >
                    <FontAwesomeIcon icon={faGear} className="text-[10px]" />
                  </Button>
                </Tooltip>
              </div>
            </div>
          </div>
          <Switch
            size="sm"
            isSelected={isEnabled}
            isDisabled={!canControlDecoder || loading || status.state === 'starting' || status.state === 'stopping'}
            onValueChange={handleEnabledChange}
            aria-label={canControlDecoder ? t('cw.decoder.enable', 'Enable CW decoder') : t('cw.decoder.controlPermissionRequired', 'No permission to control CW decoder')}
          />
        </div>

        {showDecoderDetails && (
          <>
            {(error || status.lastError) && (
              <Chip size="sm" variant="flat" color="danger" className="mt-3 max-w-full text-[11px]">
                <span className="truncate">{error ?? status.lastError}</span>
              </Chip>
            )}

            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium uppercase tracking-wide text-default-500">
                  {t('cw.decoder.transcript', 'Transcript')}
                </span>
                <div className="flex items-center gap-1">
                  <Tooltip content={callsign ? t('cw.decoder.useCallsign', 'Use callsign {{callsign}}', { callsign }) : t('cw.decoder.noCallsign', 'No callsign found')}>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="light"
                      color={callsign ? 'primary' : 'default'}
                      className="h-6 min-w-6 text-[11px]"
                      isDisabled={!callsign}
                      aria-label={callsign ? t('cw.decoder.useCallsign', 'Use callsign {{callsign}}', { callsign }) : t('cw.decoder.noCallsign', 'No callsign found')}
                      onPress={() => callsign && setCWQSOHisCallsign(callsign)}
                    >
                      <FontAwesomeIcon icon={faUserTag} className="text-[10px]" />
                    </Button>
                  </Tooltip>
                  <Button
                    size="sm"
                    variant="light"
                    className="h-6 px-2 text-[11px]"
                    startContent={<FontAwesomeIcon icon={faBroom} className="text-[10px]" />}
                    onPress={clearTranscript}
                    isDisabled={!canControlDecoder || (confirmedSegments.length === 0 && !pendingText)}
                  >
                    {t('cw.decoder.clear', 'Clear')}
                  </Button>
                </div>
              </div>
              <div
                ref={transcriptRef}
                spellCheck={false}
                role="textbox"
                aria-multiline="true"
                aria-readonly="true"
                className="h-16 overflow-y-auto rounded-lg bg-content2 px-2.5 py-2 font-mono text-sm leading-6 text-foreground whitespace-pre-wrap break-words outline-none"
              >
                {hasTranscript ? (
                  <>
                    {confirmedText && <span>{confirmedText}</span>}
                    {renderedPendingText && <span className="text-default-400 opacity-80">{renderedPendingText}</span>}
                  </>
                ) : (
                  <span className="text-default-400">{t('cw.decoder.pendingEmpty', 'Listening for decoded Morse...')}</span>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <Modal isOpen={settingsOpen} onClose={closeSettings} size="sm" placement="center">
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">
            <span>{t('cw.decoder.settings', 'Decoder settings')}</span>
            <span className="text-xs font-normal text-default-500">
              {draftBackendLabel} · {normalizedDraftModelSize} · {draft.runtimeBackend}
            </span>
          </ModalHeader>
          <ModalBody className="gap-4">
            <div className="space-y-1.5">
              <Select
                size="sm"
                label={t('cw.decoder.backend', 'Backend')}
                selectedKeys={draft.backend ? [draft.backend] : []}
                isDisabled={!canConfigureDecoder || backends.length === 0 || savingSettings}
                onSelectionChange={(keys) => {
                  if (keys === 'all') return;
                  const key = Array.from(keys)[0];
                  if (key) handleBackendChange(key);
                }}
              >
                {backends.map(backend => (
                  <SelectItem key={backend.id} textValue={getBackendLabel(backend) || backend.id}>
                    <div className="flex items-center justify-between gap-2">
                      <span>{getBackendLabel(backend) || backend.id}</span>
                      {backend.available === false && <span className="text-[10px] text-warning">{t('cw.decoder.unavailable', 'Unavailable')}</span>}
                    </div>
                  </SelectItem>
                ))}
              </Select>
              {draftAttribution && (
                <div className="px-1 text-xs font-normal leading-5 text-default-400">
                  {t('cw.decoder.backendSourceLicenseNotice', '{{name}} is {{license}} open-source software. Original project:', {
                    name: draftAttribution.name,
                    license: draftAttribution.license,
                  })}
                  {' '}
                  <button
                    type="button"
                    className="text-left text-primary underline-offset-2 hover:underline"
                    onClick={() => openExternal(draftAttribution.sourceUrl)}
                  >
                    {draftAttribution.sourceUrl}
                  </button>
                </div>
              )}
            </div>

            <Select
              size="sm"
              label={t('cw.decoder.modelSize', 'Model size')}
              selectedKeys={normalizedDraftModelSize ? [normalizedDraftModelSize] : []}
              isDisabled={!canConfigureDecoder || savingSettings}
              onSelectionChange={(keys) => {
                if (keys === 'all') return;
                const key = Array.from(keys)[0];
                if (key) handleModelSizeChange(key);
              }}
            >
              {modelSizeOptions.map(size => (
                <SelectItem key={size} textValue={size}>
                  {t(`cw.decoder.modelSizes.${size}`, size)}
                </SelectItem>
              ))}
            </Select>

            <div className="rounded-lg bg-content2 px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-foreground">{t('cw.decoder.runtimeMode', 'Runtime mode')}</div>
                  <div className="text-xs text-default-500">
                    {isGpuRuntime ? t('cw.decoder.gpuMode', 'GPU') : t('cw.decoder.cpuMode', 'CPU')}
                  </div>
                </div>
                <Switch
                  size="sm"
                  isSelected={isGpuRuntime}
                  isDisabled={!canConfigureDecoder || savingSettings}
                  onValueChange={handleGpuModeChange}
                  aria-label={t('cw.decoder.runtimeMode', 'Runtime mode')}
                />
              </div>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={closeSettings} isDisabled={savingSettings}>
              {t('cw.decoder.cancel', 'Cancel')}
            </Button>
            <Button
              color="primary"
              onPress={saveSettings}
              isLoading={savingSettings}
              isDisabled={!canConfigureDecoder || !settingsChanged}
            >
              {t('cw.decoder.save', 'Save')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
