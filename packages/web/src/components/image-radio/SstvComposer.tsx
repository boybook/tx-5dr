import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, ButtonGroup, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Popover, PopoverContent, PopoverTrigger, Progress, Select, SelectItem, Switch } from '@heroui/react';
import { addToast } from '@heroui/toast';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faGear, faImage, faPaperPlane, faPlus, faSave, faStop, faTrash, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import type { ImageTemplateTextLayer, SstvTxEnvelopeSelection } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';

import { useImageRadioControls } from '../../hooks/useImageRadio';
import { useSstvTxStart } from '../../hooks/useSstvTxStart';
import { useConnection, useCurrentOperatorId, useOperators, useRadioModeState } from '../../store/radioStore';
import { createClientId } from '../../utils/clientId';
import { fitComposerBackgroundSize, validateComposerBackgroundFile } from './composerBackground';
import { SstvCaptureConfirmModal } from './SstvCaptureConfirmModal';
import { SstvTextLayerInspector } from './SstvTextLayerInspector';
import { estimateSstvTxDurationSeconds, isSstvStationIdCallsignSupported } from './sstvTxEnvelope';
import {
  moveTextLayer,
  pointDistance,
  pointInsideTextLayer,
  rotateTextLayer,
  scaleTextLayer,
  textLayerInspectorPlacement,
  textLayerHandles,
  type CanvasPoint,
} from './sstvTextLayerGeometry';
import { formatFrequencyMHz } from '../../utils/frequencyMHz';

type TextLayer = ImageTemplateTextLayer;
type LayerInteraction =
  | { kind: 'move'; id: string; offset: CanvasPoint }
  | { kind: 'scale'; id: string; startDistance: number; startLayer: TextLayer }
  | { kind: 'rotate'; id: string; startAngle: number; startRotation: number; startLayer: TextLayer };

export function SstvComposer() {
  const { t } = useTranslation('image');
  const { modes, templates, refreshTemplates, txStatus } = useImageRadioControls();
  const txStart = useSstvTxStart();
  const connection = useConnection();
  const radio = useRadioModeState();
  const { currentOperatorId } = useCurrentOperatorId();
  const { operators } = useOperators();
  const operator = operators.find((item) => item.id === currentOperatorId) ?? operators[0];
  const operatorId = operator?.id;
  const [selectedMode, setSelectedMode] = useState('robot36');
  const [layers, setLayers] = useState<TextLayer[]>([]);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorPlacement, setInspectorPlacement] = useState<'side' | 'bottom'>('bottom');
  const [hisCall, setHisCall] = useState('');
  const [rsv, setRsv] = useState('595');
  const [note, setNote] = useState('');
  const [fit, setFit] = useState<'contain' | 'cover'>('cover');
  const [background, setBackground] = useState<ImageBitmap | null>(null);
  const [backgroundSaving, setBackgroundSaving] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [templateSaveOpen, setTemplateSaveOpen] = useState(false);
  const [deleteTemplateId, setDeleteTemplateId] = useState<string | null>(null);
  const [deletingTemplate, setDeletingTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [txEnvelope, setTxEnvelope] = useState<SstvTxEnvelopeSelection>({ enhancedPreamble: true, stationIdMode: 'fsk' });
  const [previewSize, setPreviewSize] = useState<{ width: number; height: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const backgroundRef = useRef<ImageBitmap | null>(null);
  const backgroundSaveGenerationRef = useRef(0);
  const preferenceSaveGenerationRef = useRef(0);
  const previewViewportRef = useRef<HTMLDivElement | null>(null);
  const interactionRef = useRef<LayerInteraction | null>(null);
  const operatorIdRef = useRef(operatorId);
  operatorIdRef.current = operatorId;
  const mode = modes.find((item) => item.mode === selectedMode) ?? modes.find((item) => item.mode === 'robot36') ?? modes[0];
  const stationCallsign = (operator?.context.myCall ?? '').trim().toUpperCase();
  const stationIdAvailable = isSstvStationIdCallsignSupported(stationCallsign);
  const stationIdBlocked = txEnvelope.stationIdMode !== 'none' && !stationIdAvailable;
  const durationSeconds = estimateSstvTxDurationSeconds(mode, stationCallsign, txEnvelope);
  const txProgress = txStatus?.estimatedTotalSamples
    ? Math.min(100, Math.round((txStatus.samplesEmitted / txStatus.estimatedTotalSamples) * 100))
    : 0;
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId);
  const deleteTemplate = templates.find((template) => template.id === deleteTemplateId);

  const replaceBackground = useCallback((next: ImageBitmap | null) => {
    backgroundRef.current?.close();
    backgroundRef.current = next;
    setBackground(next);
  }, []);

  useEffect(() => { void refreshTemplates(operatorId); }, [operatorId, refreshTemplates]);
  useEffect(() => {
    let active = true;
    preferenceSaveGenerationRef.current += 1;
    setTxEnvelope({ enhancedPreamble: true, stationIdMode: 'fsk' });
    if (!operatorId) return () => { active = false; };
    void api.getSstvTxPreferences(operatorId).then((result) => {
      if (active) setTxEnvelope({
        enhancedPreamble: result.preferences.enhancedPreamble,
        stationIdMode: result.preferences.stationIdMode,
      });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [operatorId]);
  useEffect(() => {
    let active = true;
    backgroundSaveGenerationRef.current += 1;
    setBackgroundSaving(false);
    replaceBackground(null);
    if (!operatorId) return () => { active = false; };
    void api.getImageComposerBackground(operatorId).then(async (result) => {
      if (!result.background) return;
      const bitmap = await createImageBitmap(await api.getImageComposerBackgroundBlob(operatorId));
      if (!active) bitmap.close();
      else replaceBackground(bitmap);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [operatorId, replaceBackground]);
  useEffect(() => () => {
    backgroundRef.current?.close();
    backgroundRef.current = null;
  }, []);
  useEffect(() => { if (modes.length && !modes.some((item) => item.mode === selectedMode)) setSelectedMode(modes[0].mode); }, [modes, selectedMode]);
  useEffect(() => {
    const viewport = previewViewportRef.current;
    if (!viewport || !mode) return;
    const update = () => {
      const availableWidth = viewport.clientWidth;
      const availableHeight = viewport.clientHeight;
      if (availableWidth <= 0 || availableHeight <= 0) return;
      const ratio = mode.width / mode.height;
      const widthConstrained = availableWidth / availableHeight <= ratio;
      const width = widthConstrained ? availableWidth : availableHeight * ratio;
      const height = widthConstrained ? availableWidth / ratio : availableHeight;
      const canvasLeftInWindow = viewport.getBoundingClientRect().left + (availableWidth - width) / 2;
      setInspectorPlacement(textLayerInspectorPlacement(canvasLeftInWindow));
      setPreviewSize({ width: Math.floor(width), height: Math.floor(height) });
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(viewport);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [mode]);

  const values = useMemo(() => ({
    MYCALL: operator?.context.myCall ?? '', MYGRID: operator?.context.myGrid ?? '', HISCALL: hisCall,
    RSV: rsv, UTC: new Date().toISOString().slice(11, 16), FREQ: radio.currentRadioFrequency ? formatFrequencyMHz(radio.currentRadioFrequency) : '', NOTE: note,
  }), [hisCall, note, operator?.context.myCall, operator?.context.myGrid, radio.currentRadioFrequency, rsv]);

  const resolveText = useCallback((text: string) => text.replace(/\{([A-Z]+)\}/g, (_match, key: keyof typeof values) => values[key] ?? ''), [values]);

  const draw = useCallback((showSelection = true) => {
    const canvas = canvasRef.current;
    if (!canvas || !mode) return;
    canvas.width = mode.width; canvas.height = mode.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.fillStyle = '#101316'; context.fillRect(0, 0, canvas.width, canvas.height);
    if (background) {
      const scale = fit === 'cover' ? Math.max(canvas.width / background.width, canvas.height / background.height) : Math.min(canvas.width / background.width, canvas.height / background.height);
      const width = background.width * scale; const height = background.height * scale;
      context.drawImage(background, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    }
    for (const layer of layers) {
      const x = layer.x * canvas.width; const y = layer.y * canvas.height;
      const width = layer.width * canvas.width; const height = layer.height * canvas.height;
      let fontPx = Math.max(8, layer.fontSize * canvas.height);
      const text = resolveText(layer.text);
      context.font = `700 ${fontPx}px sans-serif`;
      while (fontPx > 8 && context.measureText(text).width > width) {
        fontPx -= 1;
        context.font = `700 ${fontPx}px sans-serif`;
      }
      context.save();
      context.translate(x + width / 2, y + height / 2);
      context.rotate((layer.rotation ?? 0) * Math.PI / 180);
      context.textAlign = layer.align; context.textBaseline = 'middle';
      const textX = layer.align === 'left' ? -width / 2 : layer.align === 'right' ? width / 2 : 0;
      const textY = 0;
      const strokeWidth = layer.strokeWidth ?? 0.12;
      if (layer.strokeColor && strokeWidth > 0) {
        context.strokeStyle = layer.strokeColor;
        context.lineWidth = Math.max(0.5, fontPx * strokeWidth);
        context.strokeText(text, textX, textY, width);
      }
      context.fillStyle = layer.color; context.fillText(text, textX, textY, width);
      if (showSelection && layer.id === selectedLayerId) {
        const displayedWidth = canvas.getBoundingClientRect().width;
        const cssScale = displayedWidth > 0 ? canvas.width / displayedWidth : 1;
        const handleSize = 5 * cssScale;
        const rotateOffset = 24 * cssScale;
        context.strokeStyle = '#38bdf8'; context.lineWidth = Math.max(1, cssScale); context.setLineDash([5 * cssScale, 4 * cssScale]); context.strokeRect(-width / 2, -height / 2, width, height); context.setLineDash([]);
        context.beginPath();
        context.moveTo(0, -height / 2);
        context.lineTo(0, -height / 2 - rotateOffset);
        context.stroke();
        context.fillStyle = '#ffffff';
        context.strokeStyle = '#0ea5e9';
        context.lineWidth = Math.max(1, cssScale);
        context.beginPath();
        context.arc(0, -height / 2 - rotateOffset, handleSize, 0, Math.PI * 2);
        context.fill(); context.stroke();
        context.fillRect(width / 2 - handleSize, height / 2 - handleSize, handleSize * 2, handleSize * 2);
        context.strokeRect(width / 2 - handleSize, height / 2 - handleSize, handleSize * 2, handleSize * 2);
      }
      context.restore();
    }
  }, [background, fit, layers, mode, resolveText, selectedLayerId]);

  useEffect(() => { draw(); }, [draw]);

  const applyTemplate = (id: string) => {
    const template = templates.find((item) => item.id === id);
    if (!template) return;
    setSelectedTemplateId(id);
    setLayers(template.layers.map((layer) => ({ ...layer })));
    setSelectedLayerId(null);
    setInspectorOpen(false);
  };

  const addTextLayer = () => {
    const layer = { id: createClientId(), text: '{NOTE}', x: 0.1, y: 0.4, width: 0.8, height: 0.16, fontSize: 0.09, color: '#ffffff', strokeColor: '#000000', strokeWidth: 0.12, align: 'center' as const, rotation: 0 };
    setLayers((current) => [...current, layer]);
    setSelectedLayerId(layer.id);
    setInspectorOpen(true);
  };

  const removeSelectedTextLayer = () => {
    if (!selectedLayerId) return;
    const selectedIndex = layers.findIndex((layer) => layer.id === selectedLayerId);
    if (selectedIndex < 0) return;
    const remainingLayers = layers.filter((layer) => layer.id !== selectedLayerId);
    const adjacentLayer = remainingLayers[Math.min(selectedIndex, remainingLayers.length - 1)];
    if (interactionRef.current?.id === selectedLayerId) interactionRef.current = null;
    setLayers(remainingLayers);
    setSelectedLayerId(adjacentLayer?.id ?? null);
    setInspectorOpen(Boolean(adjacentLayer));
  };

  const saveTemplate = async () => {
    if (!operatorId || !templateName.trim()) return;
    try {
      await api.saveImageTemplate({
        id: createClientId(), operatorId, name: templateName.trim(), builtIn: false,
        layers, createdAt: Date.now(), updatedAt: Date.now(),
      });
      await refreshTemplates(operatorId);
      setTemplateName('');
      setTemplateSaveOpen(false);
    } catch (error) {
      addToast({ title: error instanceof Error ? error.message : t('templateSaveFailed'), color: 'danger' });
    }
  };

  const confirmDeleteTemplate = async () => {
    if (!deleteTemplate || deleteTemplate.builtIn || !operatorId) return;
    setDeletingTemplate(true);
    try {
      await api.deleteImageTemplate(deleteTemplate.id, operatorId);
      await refreshTemplates(operatorId);
      if (selectedTemplateId === deleteTemplate.id) setSelectedTemplateId(null);
      setDeleteTemplateId(null);
    } catch (error) {
      addToast({ title: error instanceof Error ? error.message : t('templateDeleteFailed'), color: 'danger' });
    } finally {
      setDeletingTemplate(false);
    }
  };

  const handleBackground = async (file?: File) => {
    if (!file || !operatorId) return;
    if (validateComposerBackgroundFile(file)) {
      addToast({ title: t('backgroundSaveFailed'), color: 'warning' });
      return;
    }
    const targetOperatorId = operatorId;
    const saveGeneration = ++backgroundSaveGenerationRef.current;
    setBackgroundSaving(true);
    let source: ImageBitmap | null = null;
    let normalized: ImageBitmap | null = null;
    try {
      source = await createImageBitmap(file);
      const size = fitComposerBackgroundSize(source.width, source.height);
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('IMAGE_CANVAS_UNAVAILABLE');
      context.drawImage(source, 0, 0, size.width, size.height);
      const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG render failed')), 'image/png'));
      normalized = await createImageBitmap(png);
      await api.saveImageComposerBackground(targetOperatorId, png);
      if (operatorIdRef.current === targetOperatorId) {
        replaceBackground(normalized);
        normalized = null;
      }
    } catch {
      addToast({ title: t('backgroundSaveFailed'), color: 'danger' });
    } finally {
      source?.close();
      normalized?.close();
      if (backgroundSaveGenerationRef.current === saveGeneration) setBackgroundSaving(false);
    }
  };

  const pointerPosition = (event: React.PointerEvent<HTMLCanvasElement>): CanvasPoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * event.currentTarget.width / rect.width,
      y: (event.clientY - rect.top) * event.currentTarget.height / rect.height,
    };
  };
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = pointerPosition(event);
    const canvas = event.currentTarget;
    const displayedWidth = canvas.getBoundingClientRect().width;
    const cssScale = displayedWidth > 0 ? canvas.width / displayedWidth : 1;
    const selected = layers.find((layer) => layer.id === selectedLayerId);
    if (selected) {
      const handles = textLayerHandles(selected, canvas.width, canvas.height, 24 * cssScale);
      if (pointDistance(point, handles.rotate) <= 11 * cssScale) {
        interactionRef.current = {
          kind: 'rotate', id: selected.id, startLayer: { ...selected }, startRotation: selected.rotation ?? 0,
          startAngle: Math.atan2(point.y - handles.center.y, point.x - handles.center.x),
        };
        canvas.setPointerCapture(event.pointerId);
        return;
      }
      if (pointDistance(point, handles.scale) <= 11 * cssScale) {
        interactionRef.current = {
          kind: 'scale', id: selected.id, startLayer: { ...selected },
          startDistance: Math.max(1, pointDistance(point, handles.center)),
        };
        canvas.setPointerCapture(event.pointerId);
        return;
      }
    }
    const layer = [...layers].reverse().find((item) => pointInsideTextLayer(point, item, canvas.width, canvas.height));
    if (!layer) {
      setSelectedLayerId(null);
      setInspectorOpen(false);
      return;
    }
    const { center } = textLayerHandles(layer, canvas.width, canvas.height);
    setSelectedLayerId(layer.id);
    setInspectorOpen(true);
    interactionRef.current = { kind: 'move', id: layer.id, offset: { x: point.x - center.x, y: point.y - center.y } };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const interaction = interactionRef.current; if (!interaction) return;
    const point = pointerPosition(event);
    const canvas = event.currentTarget;
    setLayers((current) => current.map((layer) => {
      if (layer.id !== interaction.id) return layer;
      if (interaction.kind === 'move') {
        return moveTextLayer(layer, { x: point.x - interaction.offset.x, y: point.y - interaction.offset.y }, canvas.width, canvas.height);
      }
      const { center } = textLayerHandles(interaction.startLayer, canvas.width, canvas.height);
      if (interaction.kind === 'scale') {
        const scale = pointDistance(point, center) / interaction.startDistance;
        return scaleTextLayer(interaction.startLayer, scale, canvas.width, canvas.height);
      }
      const angle = Math.atan2(point.y - center.y, point.x - center.x);
      const rotation = interaction.startRotation + (angle - interaction.startAngle) * 180 / Math.PI;
      return rotateTextLayer(interaction.startLayer, rotation, canvas.width, canvas.height);
    }));
  };
  const onPointerEnd = (event: React.PointerEvent<HTMLCanvasElement>) => {
    interactionRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const send = () => {
    if (!mode || !operatorId || !radio.currentRadioFrequency || !canvasRef.current) return;
    if (stationIdBlocked) {
      addToast({ title: t('txCallsignRequired'), color: 'warning' });
      return;
    }
    const expectedFrequency = radio.currentRadioFrequency;
    const expectedRadioMode = radio.currentRadioMode ?? undefined;
    txStart.start('composer', async () => {
      if (!connection.state.radioService || !connection.state.isReady) throw new Error('IMAGE_CONNECTION_UNAVAILABLE');
      setSelectedLayerId(null); draw(false);
      const blob = await new Promise<Blob>((resolve, reject) => canvasRef.current?.toBlob((value) => value ? resolve(value) : reject(new Error('PNG render failed')), 'image/png'));
      const upload = await api.uploadSstvArtifact({ file: blob, operatorId, mode: mode.mode, frequency: expectedFrequency, radioMode: expectedRadioMode });
      return {
        operatorId,
        artifactId: upload.artifact.id,
        mode: mode.mode,
        expectedFrequency,
        envelope: { ...txEnvelope },
      };
    });
  };

  const updateTxEnvelope = (next: SstvTxEnvelopeSelection) => {
    const previous = txEnvelope;
    const targetOperatorId = operatorId;
    const generation = ++preferenceSaveGenerationRef.current;
    setTxEnvelope(next);
    if (!targetOperatorId) return;
    void api.saveSstvTxPreferences(targetOperatorId, next).catch(() => {
      if (preferenceSaveGenerationRef.current === generation) setTxEnvelope(previous);
      addToast({ title: t('txPreferenceSaveFailed'), color: 'danger' });
    });
  };

  const selectedLayer = layers.find((layer) => layer.id === selectedLayerId);
  return (
    <>
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto pr-1" style={{ containerType: 'inline-size' }}>
      <div className="flex flex-shrink-0 items-center gap-1.5">
        <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-0.5">
          {templates.map((template) => (
            <Button
              key={template.id}
              size="sm"
              variant={selectedTemplateId === template.id ? 'solid' : 'flat'}
              color={selectedTemplateId === template.id ? 'primary' : 'default'}
              className="shrink-0"
              onPress={() => applyTemplate(template.id)}
            >
              {template.name}
            </Button>
          ))}
        </div>
        {selectedTemplate && !selectedTemplate.builtIn ? (
          <Button isIconOnly size="sm" variant="light" color="danger" onPress={() => setDeleteTemplateId(selectedTemplate.id)} aria-label={t('deleteTemplate')}>
            <FontAwesomeIcon icon={faTrash} />
          </Button>
        ) : null}
      </div>

      <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-1.5">
        <Button as="label" size="sm" variant="flat" isLoading={backgroundSaving} startContent={<FontAwesomeIcon icon={faImage} />}>
          <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { void handleBackground(event.target.files?.[0]); event.target.value = ''; }} />
          {t('background')}
        </Button>
        <ButtonGroup size="sm" variant="flat">
          <Button color={fit === 'cover' ? 'primary' : 'default'} onPress={() => setFit('cover')}>{t('fill')}</Button>
          <Button color={fit === 'contain' ? 'primary' : 'default'} onPress={() => setFit('contain')}>{t('fit')}</Button>
        </ButtonGroup>
        <Button size="sm" variant="flat" startContent={<FontAwesomeIcon icon={faPlus} />} onPress={addTextLayer}>{t('addText')}</Button>
        <Button isIconOnly size="sm" variant="light" onPress={() => setTemplateSaveOpen((open) => !open)} aria-label={t('saveAsTemplate')}><FontAwesomeIcon icon={faSave} /></Button>
      </div>

      <div ref={previewViewportRef} className="flex min-h-32 flex-1 items-center justify-center overflow-hidden">
        <div
          className="relative"
          style={{
            width: previewSize ? `${previewSize.width}px` : '100%',
            height: previewSize ? `${previewSize.height}px` : 'auto',
            aspectRatio: mode ? `${mode.width} / ${mode.height}` : '4 / 3',
          }}
        >
          <div className="h-full w-full overflow-hidden rounded-md border border-default-200 bg-black">
            <canvas ref={canvasRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} className="h-full w-full touch-none object-contain" />
          </div>
          {selectedLayer ? (
            <SstvTextLayerInspector
              layer={selectedLayer}
              placement={inspectorPlacement}
              isOpen={inspectorOpen}
              onOpenChange={setInspectorOpen}
              canvasWidth={canvasRef.current?.width ?? mode?.width ?? 320}
              canvasHeight={canvasRef.current?.height ?? mode?.height ?? 240}
              onChange={(next) => setLayers((current) => current.map((layer) => layer.id === next.id ? next : layer))}
              onDelete={removeSelectedTextLayer}
            />
          ) : null}
        </div>
      </div>

      <div className="grid flex-shrink-0 gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 9rem), 1fr))' }}>
        <Input size="sm" label={t('to')} value={hisCall} onValueChange={(value) => setHisCall(value.toUpperCase())} />
        <Input size="sm" label="RSV" value={rsv} onValueChange={setRsv} />
        <Input size="sm" label={t('note')} value={note} onValueChange={setNote} />
      </div>

      {templateSaveOpen ? (
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <Input size="sm" placeholder={t('template')} value={templateName} onValueChange={setTemplateName} className="min-w-[10rem] flex-1" />
          <Button isIconOnly size="sm" color="primary" isDisabled={!templateName.trim() || !operatorId} onPress={() => void saveTemplate()} aria-label={t('saveTemplate')}><FontAwesomeIcon icon={faSave} /></Button>
        </div>
      ) : null}

      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-t border-default-200/70 pt-2">
        <Select size="sm" aria-label={t('mode')} selectedKeys={mode ? [mode.mode] : []} onSelectionChange={(keys) => setSelectedMode(String(Array.from(keys)[0]))} className="min-w-[12rem] flex-1">
          {modes.map((item) => <SelectItem key={item.mode} textValue={item.name}>{item.name} · {item.width}×{item.height}</SelectItem>)}
        </Select>
        <div className="shrink-0 text-xs text-default-500">
          {mode ? `${mode.width}×${mode.height} · ${durationSeconds}s` : '—'}
        </div>
        <Popover placement="top-end">
          <PopoverTrigger>
            <Button isIconOnly size="sm" variant="flat" aria-label={t('stationId')}>
              <FontAwesomeIcon icon={faGear} />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[min(18rem,calc(100vw-1rem))] gap-3 p-3">
            <Switch
              size="sm"
              isSelected={txEnvelope.enhancedPreamble}
              onValueChange={(enhancedPreamble) => updateTxEnvelope({ ...txEnvelope, enhancedPreamble })}
              className="self-start"
            >
              {t('enhancedPreamble')}
            </Switch>
            <Select
              size="sm"
              label={t('stationId')}
              selectedKeys={[txEnvelope.stationIdMode]}
              disallowEmptySelection
              onSelectionChange={(keys) => updateTxEnvelope({
                ...txEnvelope,
                stationIdMode: String(Array.from(keys)[0]) as SstvTxEnvelopeSelection['stationIdMode'],
              })}
              className="w-full"
            >
              <SelectItem key="fsk">FSK-ID</SelectItem>
              <SelectItem key="cw">CW</SelectItem>
              <SelectItem key="none">{t('stationIdNone')}</SelectItem>
            </Select>
            <div className={`flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-xs ${stationIdBlocked ? 'bg-warning-100 text-warning-700' : 'bg-default-100 text-default-600'}`}>
              {stationIdBlocked ? <FontAwesomeIcon icon={faTriangleExclamation} className="shrink-0" /> : null}
              <span className="truncate">{stationIdAvailable ? stationCallsign : t('noCallsign')}</span>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {txStart.starting ? <Progress size="sm" value={txProgress} aria-label={t('transmitting')} className="flex-shrink-0" /> : null}
      <div className="flex flex-shrink-0 items-center gap-2 pb-2">
        <Button color="danger" className="min-h-11 flex-1" isLoading={txStart.starting && txStatus?.phase !== 'on_air'} isDisabled={!mode || !operatorId || txStart.isBusy || stationIdBlocked} onPress={send} startContent={<FontAwesomeIcon icon={faPaperPlane} />}>{t('sendImage')} · {durationSeconds}s</Button>
        {txStatus?.phase === 'on_air' || txStatus?.phase === 'draining' ? <Button isIconOnly className="min-h-11 min-w-11" color="danger" variant="flat" onPress={() => operatorId && txStatus.sessionId && connection.state.radioService?.cancelSstvTx({ requestId: createClientId(), operatorId, sessionId: txStatus.sessionId, expectedRevision: txStatus.revision })} aria-label={t('stop')}><FontAwesomeIcon icon={faStop} /></Button> : null}
      </div>
    </div>

    <Modal isOpen={Boolean(deleteTemplate)} onClose={() => { if (!deletingTemplate) setDeleteTemplateId(null); }} size="sm" placement="center">
      <ModalContent>
        <ModalHeader>{t('deleteTemplateTitle')}</ModalHeader>
        <ModalBody>
          <p className="text-sm text-default-600">{t('deleteTemplateConfirm', { name: deleteTemplate?.name ?? '' })}</p>
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" isDisabled={deletingTemplate} onPress={() => setDeleteTemplateId(null)}>{t('common:button.cancel')}</Button>
          <Button color="danger" isLoading={deletingTemplate} onPress={() => void confirmDeleteTemplate()}>{t('common:button.delete')}</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
    <SstvCaptureConfirmModal
      isOpen={txStart.captureConfirmOpen}
      onCancel={txStart.cancelCaptureConfirmation}
      onConfirm={txStart.confirmCaptureInterrupt}
    />
    </>
  );
}
