import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  getCWDecoderRuntimeDescription,
  getCWDecoderRuntimeLabel,
  normalizeCWDecoderRuntimeBackends,
  normalizeSelectedCWDecoderRuntimeBackend,
} from '../../utils/cwDecoderRuntimeOptions';
import {
  CW_DECODER_FILTER_WIDTH_OPTIONS,
  clampCWDecoderFilterWidth,
  clampCWDecoderTargetFreq,
} from '../../utils/cwDecoderTuning';

const CALLSIGN_RE = /\b(?:[A-Z]{1,2}\d[A-Z0-9]{1,4}|[A-Z0-9]{1,3}\d[A-Z]{1,4})\b/i;
const DEFAULT_MODEL_SIZES = ['tiny', 'small'] as const;
const TRANSCRIPT_BOTTOM_THRESHOLD_PX = 8;

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

function isNearScrollBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= TRANSCRIPT_BOTTOM_THRESHOLD_PX;
}

export function CWDecoderPanel() {
  const { t } = useTranslation('radio');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<DecoderSettingsDraft | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingFilterWidth, setSavingFilterWidth] = useState<number | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollTranscriptRef = useRef(true);
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
    tuneRuntime,
    clearTranscript,
  } = useCWDecoder();

  const backendId = status.backend ?? config?.backend ?? effectiveBackend?.id ?? '';
  const modelSize = String(config?.modelSize ?? config?.model ?? status.model ?? effectiveBackend?.model ?? 'tiny');
  const runtimeBackend = String(config?.runtimeBackend ?? config?.runtime ?? status.runtime ?? effectiveBackend?.runtime ?? 'cpu');
  const targetFreqHz = clampCWDecoderTargetFreq(typeof config?.targetFreqHz === 'number' ? config.targetFreqHz : 800);
  const filterWidthHz = clampCWDecoderFilterWidth(typeof config?.filterWidthHz === 'number' ? config.filterWidthHz : 800);
  const model = (status.model ?? modelSize) || t('cw.decoder.modelUnknown', 'default');
  const runtime = getCWDecoderRuntimeLabel((status.runtime ?? runtimeBackend) || t('cw.decoder.runtimeUnknown', 'auto'));
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
  const runtimeBackendOptions = normalizeCWDecoderRuntimeBackends(draftBackend?.runtimeBackends);
  const normalizedDraftRuntimeBackend = normalizeSelectedCWDecoderRuntimeBackend(draft.runtimeBackend, runtimeBackendOptions);
  const filterWidthOptions = useMemo(() => (
    Array.from(new Set<number>([...CW_DECODER_FILTER_WIDTH_OPTIONS, filterWidthHz])).sort((left, right) => left - right)
  ), [filterWidthHz]);
  const settingsChanged = draft.backend !== backendId
    || normalizedDraftModelSize !== modelSize
    || normalizedDraftRuntimeBackend !== runtimeBackend;

  useEffect(() => {
    if (!settingsOpen) return;
    setSettingsDraft(makeSettingsDraft(backendId, modelSize, runtimeBackend));
  }, [backendId, modelSize, runtimeBackend, settingsOpen]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    if (!shouldAutoScrollTranscriptRef.current) return;
    transcript.scrollTop = transcript.scrollHeight;
  }, [confirmedText, pendingText, showDecoderDetails]);

  const handleTranscriptScroll = useCallback(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    shouldAutoScrollTranscriptRef.current = isNearScrollBottom(transcript);
  }, []);

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

  const handleRuntimeBackendChange = (key: React.Key) => {
    if (!canConfigureDecoder) return;
    setSettingsDraft(prev => ({
      ...(prev ?? makeSettingsDraft(backendId, modelSize, runtimeBackend)),
      runtimeBackend: String(key),
    }));
  };

  const handleFilterWidthChange = async (width: number) => {
    if (!canConfigureDecoder || savingFilterWidth !== null || width === filterWidthHz) return;
    const nextWidth = clampCWDecoderFilterWidth(width);
    setSavingFilterWidth(nextWidth);
    try {
      await tuneRuntime({ targetFreqHz, filterWidthHz: nextWidth });
      await updateConfig({ targetFreqHz, filterWidthHz: nextWidth });
    } finally {
      setSavingFilterWidth(null);
    }
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
        runtimeBackend: normalizedDraftRuntimeBackend,
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
                <Select
                  size="sm"
                  aria-label={t('cw.decoder.filter', 'Audio filter')}
                  title={t('cw.decoder.filterSummary', '{{target}} Hz tone · {{width}} Hz width', {
                    target: targetFreqHz,
                    width: filterWidthHz,
                  })}
                  selectedKeys={[String(filterWidthHz)]}
                  isDisabled={!canConfigureDecoder || savingFilterWidth !== null}
                  disallowEmptySelection
                  classNames={{
                    base: 'w-[76px] shrink-0',
                    trigger: 'h-5 min-h-5 rounded-md bg-content2 px-1.5',
                    value: 'text-[10px] text-default-500',
                    selectorIcon: 'h-3 w-3 text-default-400',
                  }}
                  onSelectionChange={(keys) => {
                    if (keys === 'all') return;
                    const key = Array.from(keys)[0];
                    const width = Number(key);
                    if (Number.isFinite(width)) {
                      void handleFilterWidthChange(width);
                    }
                  }}
                >
                  {filterWidthOptions.map(width => (
                    <SelectItem key={String(width)} textValue={`${width} Hz`}>
                      {width} Hz
                    </SelectItem>
                  ))}
                </Select>
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
                onScroll={handleTranscriptScroll}
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

      <Modal isOpen={settingsOpen} onClose={closeSettings} size="sm" placement="center"
        scrollBehavior="inside"
      >
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">
            <span>{t('cw.decoder.settings', 'Decoder settings')}</span>
            <span className="text-xs font-normal text-default-500">
              {draftBackendLabel} · {normalizedDraftModelSize} · {getCWDecoderRuntimeLabel(normalizedDraftRuntimeBackend)}
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

            <Select
              size="sm"
              label={t('cw.decoder.runtimeMode', 'Runtime mode')}
              selectedKeys={normalizedDraftRuntimeBackend ? [normalizedDraftRuntimeBackend] : []}
              isDisabled={!canConfigureDecoder || savingSettings}
              onSelectionChange={(keys) => {
                if (keys === 'all') return;
                const key = Array.from(keys)[0];
                if (key) handleRuntimeBackendChange(key);
              }}
            >
              {runtimeBackendOptions.map(runtimeOption => {
                const description = getCWDecoderRuntimeDescription(runtimeOption);
                return (
                  <SelectItem key={runtimeOption} textValue={getCWDecoderRuntimeLabel(runtimeOption)}>
                    <div className="flex flex-col gap-0.5">
                      <span>{t(`cw.decoder.runtimeBackends.${runtimeOption}.label`, getCWDecoderRuntimeLabel(runtimeOption))}</span>
                      {description && (
                        <span className="text-[11px] leading-4 text-default-400">
                          {t(`cw.decoder.runtimeBackends.${runtimeOption}.description`, description)}
                        </span>
                      )}
                    </div>
                  </SelectItem>
                );
              })}
            </Select>
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
