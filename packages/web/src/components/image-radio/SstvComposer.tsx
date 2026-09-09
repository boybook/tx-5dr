import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, ButtonGroup, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Popover, PopoverContent, PopoverTrigger, Progress, Select, SelectItem, Switch } from '@heroui/react';
import { addToast } from '@heroui/toast';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowDown, faArrowUp, faFont, faGear, faImage, faImages, faLayerGroup, faPaperPlane, faSave, faSliders, faStop, faTrash, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import type { ImageComposerTransform, ImageTemplateImageLayer, ImageTemplateImageSource, ImageTemplateLayer, SstvTxEnvelopeSelection } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';

import { useImageRadioControls } from '../../hooks/useImageRadio';
import { useSstvTxStart } from '../../hooks/useSstvTxStart';
import { useConnection, useCurrentOperatorId, useOperators, useRadioModeState } from '../../store/radioStore';
import { createClientId } from '../../utils/clientId';
import { fitComposerBackgroundSize, fitComposerImageTransform, validateComposerBackgroundFile } from './composerBackground';
import { SstvCaptureConfirmModal } from './SstvCaptureConfirmModal';
import { SstvImageLayerInspector } from './SstvImageLayerInspector';
import { SstvTextLayerInspector } from './SstvTextLayerInspector';
import { SSTV_COMPOSER_INSERT_IMAGE_EVENT, type SstvComposerInsertImageDetail } from './sstvComposerEvents';
import { estimateSstvTxDurationSeconds, isSstvStationIdCallsignSupported } from './sstvTxEnvelope';
import {
  layerHandles,
  moveLayer,
  pointDistance,
  pointInsideLayer,
  rotateLayer,
  scaleImageLayer,
  scaleTextLayer,
  textLayerInspectorPlacement,
  type CanvasPoint,
} from './sstvTextLayerGeometry';
import { formatFrequencyMHz } from '../../utils/frequencyMHz';

type ImageLayer = ImageTemplateImageLayer;
type ComposerLayer = ImageTemplateLayer;
type InsertArtifactOptions = { mode?: string; callsign?: string; reply?: boolean };
const BACKGROUND_LAYER_ID = '__background__';
type LayerInteraction =
  | { kind: 'move'; id: string; offset: CanvasPoint; startLayer: ComposerLayer | ImageComposerTransform }
  | { kind: 'scale'; id: string; startDistance: number; startLayer: ComposerLayer | ImageComposerTransform }
  | { kind: 'rotate'; id: string; startAngle: number; startRotation: number; startLayer: ComposerLayer | ImageComposerTransform }
  | { kind: 'crop'; id: string; startPoint: CanvasPoint; startLayer: ImageLayer | ImageComposerTransform };

function isImageLayer(layer: ComposerLayer): layer is ImageLayer {
  return 'kind' in layer && layer.kind === 'image';
}

function drawLayerSelection(
  context: CanvasRenderingContext2D,
  layer: ComposerLayer | ImageComposerTransform,
  canvasWidth: number,
  canvasHeight: number,
  cssScale: number,
  showHandles = true,
): void {
  const { center } = layerHandles(layer, canvasWidth, canvasHeight);
  const width = layer.width * canvasWidth;
  const height = layer.height * canvasHeight;
  const handleSize = 5 * cssScale;
  const rotateOffset = 24 * cssScale;
  context.save();
  context.translate(center.x, center.y);
  context.rotate((layer.rotation ?? 0) * Math.PI / 180);
  context.strokeStyle = '#38bdf8';
  context.lineWidth = Math.max(1, cssScale);
  context.setLineDash([5 * cssScale, 4 * cssScale]);
  context.strokeRect(-width / 2, -height / 2, width, height);
  context.setLineDash([]);
  if (!showHandles) {
    context.restore();
    return;
  }
  context.beginPath();
  context.moveTo(0, -height / 2);
  context.lineTo(0, -height / 2 - rotateOffset);
  context.stroke();
  context.fillStyle = '#ffffff';
  context.strokeStyle = '#0ea5e9';
  context.beginPath();
  context.arc(0, -height / 2 - rotateOffset, handleSize, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.fillRect(width / 2 - handleSize, height / 2 - handleSize, handleSize * 2, handleSize * 2);
  context.strokeRect(width / 2 - handleSize, height / 2 - handleSize, handleSize * 2, handleSize * 2);
  context.restore();
}

function drawBitmapLayer(
  context: CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  layer: ImageTemplateImageLayer | ImageComposerTransform,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const width = layer.width * canvasWidth;
  const height = layer.height * canvasHeight;
  const center = layerHandles(layer, canvasWidth, canvasHeight).center;
  context.save();
  context.translate(center.x, center.y);
  context.rotate((layer.rotation ?? 0) * Math.PI / 180);
  context.scale(layer.flipX ? -1 : 1, layer.flipY ? -1 : 1);
  const crop = layer.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  context.drawImage(
    bitmap,
    crop.x * bitmap.width,
    crop.y * bitmap.height,
    crop.width * bitmap.width,
    crop.height * bitmap.height,
    -width / 2,
    -height / 2,
    width,
    height,
  );
  context.restore();
}

function imageSourceKey(source: ImageTemplateImageLayer['source']): string {
  return source.type === 'artifact' ? `artifact:${source.artifactId}` : `asset:${source.assetId}`;
}

function zoomCrop(transform: ImageComposerTransform, zoom: number, baseCrop?: ImageComposerTransform['crop']): ImageComposerTransform {
  const current = transform.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const base = baseCrop ?? (transform.fit === 'cover' ? current : { x: 0, y: 0, width: 1, height: 1 });
  const factor = Math.max(1, Math.min(4, zoom));
  const width = Math.max(0.02, base.width / factor);
  const height = Math.max(0.02, base.height / factor);
  const centerX = current.x + current.width / 2;
  const centerY = current.y + current.height / 2;
  return {
    ...transform,
    crop: {
      x: Math.min(1 - width, Math.max(0, centerX - width / 2)),
      y: Math.min(1 - height, Math.max(0, centerY - height / 2)),
      width,
      height,
    },
  };
}

function panCrop(transform: ImageComposerTransform, delta: CanvasPoint, canvasWidth: number, canvasHeight: number): ImageComposerTransform {
  const crop = transform.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const frameWidth = Math.max(1, transform.width * canvasWidth);
  const frameHeight = Math.max(1, transform.height * canvasHeight);
  const radians = -(transform.rotation ?? 0) * Math.PI / 180;
  const localDelta = {
    x: delta.x * Math.cos(radians) - delta.y * Math.sin(radians),
    y: delta.x * Math.sin(radians) + delta.y * Math.cos(radians),
  };
  return {
    ...transform,
    crop: {
      ...crop,
      x: Math.min(1 - crop.width, Math.max(0, crop.x - localDelta.x / frameWidth * crop.width)),
      y: Math.min(1 - crop.height, Math.max(0, crop.y - localDelta.y / frameHeight * crop.height)),
    },
  };
}

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
  const [layers, setLayers] = useState<ComposerLayer[]>([]);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [layersOpen, setLayersOpen] = useState(false);
  const [backgroundEditing, setBackgroundEditing] = useState(false);
  const [cropEditing, setCropEditing] = useState(false);
  const [cropZoomValue, setCropZoomValue] = useState(1);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorPlacement, setInspectorPlacement] = useState<'side' | 'bottom'>('bottom');
  const [hisCall, setHisCall] = useState('');
  const [rsv, setRsv] = useState('595');
  const [note, setNote] = useState('');
  const [background, setBackground] = useState<ImageBitmap | null>(null);
  const [backgroundSource, setBackgroundSource] = useState<ImageTemplateImageSource | null>(null);
  const [backgroundTransform, setBackgroundTransform] = useState<ImageComposerTransform | null>(null);
  const [backgroundSaving, setBackgroundSaving] = useState(false);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageRevision, setImageRevision] = useState(0);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [templateSaveOpen, setTemplateSaveOpen] = useState(false);
  const [deleteTemplateId, setDeleteTemplateId] = useState<string | null>(null);
  const [deletingTemplate, setDeletingTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [txEnvelope, setTxEnvelope] = useState<SstvTxEnvelopeSelection>({ enhancedPreamble: true, stationIdMode: 'fsk' });
  const [previewSize, setPreviewSize] = useState<{ width: number; height: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const backgroundRef = useRef<ImageBitmap | null>(null);
  const imageBitmapsRef = useRef(new Map<string, ImageBitmap>());
  const defaultTemplateAppliedRef = useRef(false);
  const backgroundSaveGenerationRef = useRef(0);
  const preferenceSaveGenerationRef = useRef(0);
  const previewViewportRef = useRef<HTMLDivElement | null>(null);
  const hisCallInputRef = useRef<HTMLInputElement | null>(null);
  const interactionRef = useRef<LayerInteraction | null>(null);
  const cropBaseRef = useRef<ImageComposerTransform['crop'] | null>(null);
  const operatorIdRef = useRef(operatorId);
  operatorIdRef.current = operatorId;
  const mode = modes.find((item) => item.mode === selectedMode) ?? modes.find((item) => item.mode === 'robot36') ?? modes[0];
  const stationCallsign = (operator?.context.myCall ?? '').trim().toUpperCase();
  const stationIdAvailable = isSstvStationIdCallsignSupported(stationCallsign);
  const stationIdBlocked = txEnvelope.stationIdMode !== 'none' && !stationIdAvailable;
  const durationSeconds = estimateSstvTxDurationSeconds(mode, stationCallsign, txEnvelope);
  const txProgress = txStatus?.estimatedTotalSamples
    ? Math.min(txStatus.phase === 'completed' ? 100 : 99, Math.round((txStatus.samplesEmitted / txStatus.estimatedTotalSamples) * 100))
    : 0;
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId);
  const deleteTemplate = templates.find((template) => template.id === deleteTemplateId);

  const replaceBackground = useCallback((next: ImageBitmap | null) => {
    backgroundRef.current?.close();
    backgroundRef.current = next;
    setBackground(next);
  }, []);

  const shouldCloseInspectorOnInteractOutside = useCallback((element: Element) => {
    const canvas = canvasRef.current;
    return !canvas || !canvas.contains(element);
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
    setBackgroundSource(null);
    setBackgroundTransform(null);
    setBackgroundEditing(false);
    setCropEditing(false);
    setCropZoomValue(1);
    setLayers([]);
    setSelectedLayerId(null);
    setSelectedTemplateId(null);
    defaultTemplateAppliedRef.current = false;
    for (const bitmap of imageBitmapsRef.current.values()) bitmap.close();
    imageBitmapsRef.current.clear();
    if (!operatorId) return () => { active = false; };
    void api.getImageComposerBackground(operatorId).then(async (result) => {
      if (!result.background) return;
      const bitmap = await createImageBitmap(await api.getImageComposerBackgroundBlob(operatorId));
      if (!active) bitmap.close();
      else {
        replaceBackground(bitmap);
        setBackgroundSource(result.background.assetId ? { type: 'asset', assetId: result.background.assetId } : null);
        setBackgroundTransform(result.background.transform ?? fitComposerImageTransform(bitmap.width, bitmap.height, 320, 240, 'cover'));
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [operatorId, replaceBackground]);
  useEffect(() => () => {
    backgroundRef.current?.close();
    backgroundRef.current = null;
    for (const bitmap of imageBitmapsRef.current.values()) bitmap.close();
    imageBitmapsRef.current.clear();
  }, []);

  const loadImageBitmap = useCallback(async (source: ImageLayer['source']) => {
    const key = imageSourceKey(source);
    const existing = imageBitmapsRef.current.get(key);
    if (existing) return existing;
    const blob = source.type === 'artifact'
      ? await api.getImageArtifactBlob(source.artifactId)
      : await api.getImageComposerAssetBlob(operatorId ?? '', source.assetId);
    const bitmap = await createImageBitmap(blob);
    imageBitmapsRef.current.set(key, bitmap);
    setImageRevision((value) => value + 1);
    return bitmap;
  }, [operatorId]);

  const insertArtifactImage = useCallback(async (artifactId: string, options: InsertArtifactOptions = {}) => {
    if (!operatorId) return;
    const targetOperatorId = operatorId;
    setImageLoading(true);
    try {
      const source: ImageLayer['source'] = { type: 'artifact', artifactId };
      const bitmap = await loadImageBitmap(source);
      if (operatorIdRef.current !== targetOperatorId) return;
      const requestedMode = options.mode ? modes.find((item) => item.mode === options.mode) : undefined;
      if (requestedMode) setSelectedMode(requestedMode.mode);
      const targetMode = requestedMode ?? mode;
      const canvasWidth = targetMode?.width ?? 320;
      const canvasHeight = targetMode?.height ?? 240;
      const transform = fitComposerImageTransform(bitmap.width, bitmap.height, canvasWidth, canvasHeight, 'contain', canvasWidth * 0.62, canvasHeight * 0.62);
      const layer: ImageLayer = { id: createClientId(), kind: 'image', source, ...transform };
      const replyTemplate = options.reply ? templates.find((template) => template.id === 'builtin-reply') : undefined;
      setLayers((current) => {
        if (!replyTemplate) return [...current, layer];
        return [
          ...current.filter(isImageLayer),
          layer,
          ...replyTemplate.layers.map((item) => ({ ...item })),
        ];
      });
      if (replyTemplate) setSelectedTemplateId(replyTemplate.id);
      if (options.callsign) {
        setHisCall(options.callsign.toUpperCase());
      } else if (options.reply) {
        window.requestAnimationFrame(() => hisCallInputRef.current?.focus());
      }
      setSelectedLayerId(layer.id);
      setBackgroundEditing(false);
      setCropEditing(false);
      setCropZoomValue(1);
      setInspectorOpen(true);
    } catch {
      addToast({ title: t('imageLoadFailed'), color: 'danger' });
    } finally {
      setImageLoading(false);
    }
  }, [hisCallInputRef, loadImageBitmap, mode, modes, operatorId, t, templates]);

  useEffect(() => {
    const insert = (event: Event) => {
      const detail = (event as CustomEvent<SstvComposerInsertImageDetail>).detail;
      if (detail?.artifactId) void insertArtifactImage(detail.artifactId, detail);
    };
    window.addEventListener(SSTV_COMPOSER_INSERT_IMAGE_EVENT, insert);
    return () => window.removeEventListener(SSTV_COMPOSER_INSERT_IMAGE_EVENT, insert);
  }, [insertArtifactImage]);
  useEffect(() => {
    if (defaultTemplateAppliedRef.current || templates.length === 0) return;
    const cq = templates.find((template) => template.id === 'builtin-cq');
    if (!cq) return;
    defaultTemplateAppliedRef.current = true;
    setSelectedTemplateId(cq.id);
    setLayers((current) => [...current.filter(isImageLayer), ...cq.layers.map((layer) => ({ ...layer }))]);
  }, [templates]);
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
      setInspectorPlacement(window.innerWidth >= 768 && textLayerInspectorPlacement(canvasLeftInWindow) === 'side' ? 'side' : 'bottom');
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
    if (background && backgroundTransform) drawBitmapLayer(context, background, backgroundTransform, canvas.width, canvas.height);
    for (const layer of layers) {
      if (isImageLayer(layer)) {
        const bitmap = imageBitmapsRef.current.get(imageSourceKey(layer.source));
        if (bitmap) drawBitmapLayer(context, bitmap, layer, canvas.width, canvas.height);
        continue;
      }
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
      context.restore();
    }
    if (showSelection) {
      const selected = layers.find((layer) => layer.id === selectedLayerId) ?? (backgroundEditing ? backgroundTransform : null);
      if (selected) {
        const displayedWidth = canvas.getBoundingClientRect().width;
        drawLayerSelection(context, selected, canvas.width, canvas.height, displayedWidth > 0 ? canvas.width / displayedWidth : 1, !cropEditing);
      }
    }
  }, [background, backgroundEditing, backgroundTransform, cropEditing, imageRevision, layers, mode, resolveText, selectedLayerId]);

  useEffect(() => { draw(); }, [draw]);

  useEffect(() => {
    if (!operatorId || !background || !backgroundTransform || backgroundSource?.type === 'artifact') return;
    const timer = window.setTimeout(() => {
      void api.updateImageComposerBackgroundTransform(operatorId, backgroundTransform).catch(() => {
        addToast({ title: t('backgroundSaveFailed'), color: 'danger' });
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [background, backgroundSource?.type, backgroundTransform, operatorId, t]);

  const applyTemplate = (id: string) => {
    const template = templates.find((item) => item.id === id);
    if (!template) return;
    setSelectedTemplateId(id);
    setLayers((current) => template.builtIn
      ? [...current.filter(isImageLayer), ...template.layers.map((layer) => ({ ...layer }))]
      : template.layers.map((layer) => ({ ...layer })));
    if (template.backgroundSource) {
      setBackgroundSource(template.backgroundSource);
      void loadImageBitmap(template.backgroundSource).then(replaceBackground).catch(() => addToast({ title: t('imageLoadFailed'), color: 'danger' }));
    }
    if (template.backgroundTransform) setBackgroundTransform(template.backgroundTransform);
    for (const layer of template.layers) {
      if (isImageLayer(layer)) void loadImageBitmap(layer.source).catch(() => addToast({ title: t('imageLoadFailed'), color: 'danger' }));
    }
    setSelectedLayerId(null);
    setBackgroundEditing(false);
    setCropEditing(false);
    setCropZoomValue(1);
    setInspectorOpen(false);
  };

  const addTextLayer = () => {
    const layer = { id: createClientId(), text: '{NOTE}', x: 0.1, y: 0.4, width: 0.8, height: 0.16, fontSize: 0.09, color: '#ffffff', strokeColor: '#000000', strokeWidth: 0.12, align: 'center' as const, rotation: 0 };
    setLayers((current) => [...current, layer]);
    setSelectedLayerId(layer.id);
    setBackgroundEditing(false);
    setCropEditing(false);
    setCropZoomValue(1);
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
    setCropEditing(false);
    setCropZoomValue(1);
    setInspectorOpen(Boolean(adjacentLayer));
  };

  const saveTemplate = async () => {
    if (!operatorId || !templateName.trim()) return;
    try {
      let templateBackgroundSource = backgroundSource;
      if (!templateBackgroundSource && background) {
        const asset = await api.uploadImageComposerAsset(operatorId, await api.getImageComposerBackgroundBlob(operatorId));
        templateBackgroundSource = { type: 'asset', assetId: asset.asset.id };
        setBackgroundSource(templateBackgroundSource);
      }
      await api.saveImageTemplate({
        id: createClientId(), operatorId, name: templateName.trim(), builtIn: false,
        backgroundSource: templateBackgroundSource ?? undefined,
        backgroundTransform: backgroundTransform ?? undefined, layers, createdAt: Date.now(), updatedAt: Date.now(),
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
      const saved = await api.saveImageComposerBackground(targetOperatorId, png);
      if (operatorIdRef.current === targetOperatorId) {
        const canvasWidth = mode?.width ?? 320;
        const canvasHeight = mode?.height ?? 240;
        setBackgroundTransform(fitComposerImageTransform(normalized.width, normalized.height, canvasWidth, canvasHeight, 'cover'));
        setBackgroundSource(saved.background.assetId ? { type: 'asset', assetId: saved.background.assetId } : null);
        replaceBackground(normalized);
        normalized = null;
        setSelectedLayerId(null);
        setBackgroundEditing(true);
        setInspectorOpen(true);
      }
    } catch {
      addToast({ title: t('backgroundSaveFailed'), color: 'danger' });
    } finally {
      source?.close();
      normalized?.close();
      if (backgroundSaveGenerationRef.current === saveGeneration) setBackgroundSaving(false);
    }
  };

  const fitBackground = (nextFit: ImageComposerTransform['fit']) => {
    if (!background) return;
    setBackgroundTransform(fitComposerImageTransform(background.width, background.height, mode?.width ?? 320, mode?.height ?? 240, nextFit));
    cropBaseRef.current = null;
    setCropZoomValue(1);
    setSelectedLayerId(null);
    setBackgroundEditing(true);
    setInspectorOpen(true);
  };

  const handleImageLayer = async (file?: File) => {
    if (!file || !operatorId) return;
    const targetOperatorId = operatorId;
    if (validateComposerBackgroundFile(file)) {
      addToast({ title: t('imageLoadFailed'), color: 'warning' });
      return;
    }
    setImageLoading(true);
    let sourceBitmap: ImageBitmap | null = null;
    let normalizedBitmap: ImageBitmap | null = null;
    try {
      sourceBitmap = await createImageBitmap(file);
      const size = fitComposerBackgroundSize(sourceBitmap.width, sourceBitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('IMAGE_CANVAS_UNAVAILABLE');
      context.drawImage(sourceBitmap, 0, 0, size.width, size.height);
      const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG render failed')), 'image/png'));
      const asset = await api.uploadImageComposerAsset(targetOperatorId, png);
      if (operatorIdRef.current !== targetOperatorId) return;
      normalizedBitmap = await createImageBitmap(png);
      imageBitmapsRef.current.set(imageSourceKey({ type: 'asset', assetId: asset.asset.id }), normalizedBitmap);
      normalizedBitmap = null;
      const transform = fitComposerImageTransform(asset.asset.width, asset.asset.height, mode?.width ?? 320, mode?.height ?? 240, 'contain', (mode?.width ?? 320) * 0.62, (mode?.height ?? 240) * 0.62);
      const layer: ImageLayer = { id: createClientId(), kind: 'image', source: { type: 'asset', assetId: asset.asset.id }, ...transform };
      setLayers((current) => [...current, layer]);
      setSelectedLayerId(layer.id);
      setBackgroundEditing(false);
      setCropEditing(false);
      setCropZoomValue(1);
      setInspectorOpen(true);
    } catch {
      addToast({ title: t('imageLoadFailed'), color: 'danger' });
    } finally {
      sourceBitmap?.close();
      normalizedBitmap?.close();
      setImageLoading(false);
    }
  };

  const fitImageLayer = (layer: ImageLayer, nextFit: ImageComposerTransform['fit']) => {
    const bitmap = imageBitmapsRef.current.get(imageSourceKey(layer.source));
    if (!bitmap) return;
    const canvasWidth = mode?.width ?? 320;
    const canvasHeight = mode?.height ?? 240;
    const transform = fitComposerImageTransform(bitmap.width, bitmap.height, canvasWidth, canvasHeight, nextFit, canvasWidth * 0.62, canvasHeight * 0.62);
    setLayers((current) => current.map((item) => item.id === layer.id ? { ...layer, ...transform } : item));
    cropBaseRef.current = null;
    setCropZoomValue(1);
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
    const selected = layers.find((layer) => layer.id === selectedLayerId) ?? (backgroundEditing ? backgroundTransform : null);
    const selectedId = selectedLayerId ?? BACKGROUND_LAYER_ID;
    if (selected) {
      if (cropEditing && (selectedId === BACKGROUND_LAYER_ID || isImageLayer(selected as ComposerLayer))) {
        interactionRef.current = { kind: 'crop', id: selectedId, startLayer: selected as ImageLayer | ImageComposerTransform, startPoint: point };
        canvas.setPointerCapture(event.pointerId);
        return;
      }
      const handles = layerHandles(selected, canvas.width, canvas.height, 24 * cssScale);
      if (pointDistance(point, handles.rotate) <= 11 * cssScale) {
        interactionRef.current = {
          kind: 'rotate', id: selectedId, startLayer: { ...selected }, startRotation: selected.rotation ?? 0,
          startAngle: Math.atan2(point.y - handles.center.y, point.x - handles.center.x),
        };
        canvas.setPointerCapture(event.pointerId);
        return;
      }
      if (pointDistance(point, handles.scale) <= 11 * cssScale) {
        interactionRef.current = {
          kind: 'scale', id: selectedId, startLayer: { ...selected },
          startDistance: Math.max(1, pointDistance(point, handles.center)),
        };
        canvas.setPointerCapture(event.pointerId);
        return;
      }
    }
    const layer = [...layers].reverse().find((item) => pointInsideLayer(point, item, canvas.width, canvas.height));
    if (!layer) {
      setSelectedLayerId(null);
      if (backgroundEditing && backgroundTransform) {
        const { center } = layerHandles(backgroundTransform, canvas.width, canvas.height);
        interactionRef.current = { kind: 'move', id: BACKGROUND_LAYER_ID, startLayer: backgroundTransform, offset: { x: point.x - center.x, y: point.y - center.y } };
        setInspectorOpen(true);
        canvas.setPointerCapture(event.pointerId);
      } else {
        setInspectorOpen(false);
      }
      return;
    }
    const { center } = layerHandles(layer, canvas.width, canvas.height);
    setSelectedLayerId(layer.id);
    setBackgroundEditing(false);
    setCropEditing(false);
    setInspectorOpen(true);
    interactionRef.current = { kind: 'move', id: layer.id, startLayer: layer, offset: { x: point.x - center.x, y: point.y - center.y } };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const interaction = interactionRef.current; if (!interaction) return;
    const point = pointerPosition(event);
    const canvas = event.currentTarget;
    if (interaction.kind === 'crop') {
      const delta = { x: point.x - interaction.startPoint.x, y: point.y - interaction.startPoint.y };
      const next = panCrop(interaction.startLayer, delta, canvas.width, canvas.height);
      if (interaction.id === BACKGROUND_LAYER_ID) setBackgroundTransform(next);
      else setLayers((current) => current.map((layer) => layer.id === interaction.id ? { ...layer, ...next } : layer));
      return;
    }
    const transform = (layer: ComposerLayer | ImageComposerTransform): ComposerLayer | ImageComposerTransform => {
      if (interaction.kind === 'move') {
        return moveLayer(layer, { x: point.x - interaction.offset.x, y: point.y - interaction.offset.y }, canvas.width, canvas.height);
      }
      const { center } = layerHandles(interaction.startLayer, canvas.width, canvas.height);
      if (interaction.kind === 'scale') {
        const scale = pointDistance(point, center) / interaction.startDistance;
        return 'text' in interaction.startLayer
          ? scaleTextLayer(interaction.startLayer, scale, canvas.width, canvas.height)
          : scaleImageLayer(interaction.startLayer, scale, canvas.width, canvas.height);
      }
      const angle = Math.atan2(point.y - center.y, point.x - center.x);
      const rotation = interaction.startRotation + (angle - interaction.startAngle) * 180 / Math.PI;
      return rotateLayer(interaction.startLayer, rotation, canvas.width, canvas.height);
    };
    if (interaction.id === BACKGROUND_LAYER_ID) {
      setBackgroundTransform((current) => current ? transform(current) as ImageComposerTransform : current);
    } else {
      setLayers((current) => current.map((layer) => layer.id === interaction.id ? transform(layer) as ComposerLayer : layer));
    }
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
  const selectedImageLayer = selectedLayer && isImageLayer(selectedLayer) ? selectedLayer : null;
  const selectedTextLayer = selectedLayer && !isImageLayer(selectedLayer) ? selectedLayer : null;

  const reorderLayer = (id: string, direction: -1 | 1) => {
    setLayers((current) => {
      const index = current.findIndex((layer) => layer.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const toggleCropEditing = () => {
    const target = selectedImageLayer ?? (backgroundEditing ? backgroundTransform : null);
    if (!target) return;
    const next = !cropEditing;
    if (next) cropBaseRef.current = target.crop ?? { x: 0, y: 0, width: 1, height: 1 };
    else cropBaseRef.current = null;
    setCropZoomValue(1);
    setCropEditing(next);
  };

  const updateSelectedImageCropZoom = (zoom: number) => {
    setCropZoomValue(zoom);
    if (selectedImageLayer) {
      setLayers((current) => current.map((layer) => layer.id === selectedImageLayer.id && isImageLayer(layer)
        ? { ...layer, ...zoomCrop(layer, zoom, cropBaseRef.current ?? undefined) }
        : layer));
    } else if (backgroundEditing) {
      setBackgroundTransform((current) => current ? zoomCrop(current, zoom, cropBaseRef.current ?? undefined) : current);
    }
  };

  const flipSelectedImage = (axis: 'x' | 'y') => {
    if (selectedImageLayer) {
      setLayers((current) => current.map((layer) => layer.id === selectedImageLayer.id && isImageLayer(layer)
        ? { ...layer, [axis === 'x' ? 'flipX' : 'flipY']: !(axis === 'x' ? layer.flipX : layer.flipY) }
        : layer));
    } else if (backgroundEditing) {
      setBackgroundTransform((current) => current ? { ...current, [axis === 'x' ? 'flipX' : 'flipY']: !(axis === 'x' ? current.flipX : current.flipY) } : current);
    }
  };
  return (
    <>
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto pr-1" style={{ containerType: 'inline-size' }}>
      <div className="sticky top-0 z-20 -mx-1 flex flex-shrink-0 flex-col gap-2 border-b border-default-200/70 bg-background/95 px-1 pb-2 pt-1 backdrop-blur">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-[minmax(10rem,1.2fr)_minmax(6rem,.6fr)_minmax(10rem,1fr)]">
          <Input ref={hisCallInputRef} size="sm" label={t('to')} value={hisCall} onValueChange={(value) => setHisCall(value.toUpperCase())} />
          <Input size="sm" label="RSV" value={rsv} onValueChange={setRsv} />
          <Input size="sm" label={t('note')} value={note} onValueChange={setNote} className="col-span-2 md:col-span-1" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select size="md" aria-label={t('mode')} selectedKeys={mode ? [mode.mode] : []} onSelectionChange={(keys) => setSelectedMode(String(Array.from(keys)[0]))} className="min-h-11 min-w-0 flex-1 md:min-w-[12rem]">
            {modes.map((item) => <SelectItem key={item.mode} textValue={item.name}>{item.name} · {item.width}×{item.height}</SelectItem>)}
          </Select>
          <div className="flex min-h-11 shrink-0 items-center text-sm text-default-500">{mode ? `${mode.width}×${mode.height} · ${durationSeconds}s` : '—'}</div>
          <Popover placement="bottom-end">
            <PopoverTrigger>
              <Button isIconOnly size="md" className="min-h-11 min-w-11" variant="flat" aria-label={t('stationId')} title={t('stationId')}>
                <FontAwesomeIcon icon={faGear} />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[min(18rem,calc(100vw-1rem))] gap-3 p-3">
              <Switch size="sm" isSelected={txEnvelope.enhancedPreamble} onValueChange={(enhancedPreamble) => updateTxEnvelope({ ...txEnvelope, enhancedPreamble })} className="self-start">
                {t('enhancedPreamble')}
              </Switch>
              <Select size="sm" label={t('stationId')} selectedKeys={[txEnvelope.stationIdMode]} disallowEmptySelection onSelectionChange={(keys) => updateTxEnvelope({ ...txEnvelope, stationIdMode: String(Array.from(keys)[0]) as SstvTxEnvelopeSelection['stationIdMode'] })} className="w-full">
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
          <Button size="md" color="danger" className="order-last min-h-11 w-full md:order-none md:min-w-[13rem] md:flex-1" isLoading={txStart.starting && txStatus?.phase !== 'on_air'} isDisabled={!mode || !operatorId || txStart.isBusy || stationIdBlocked} onPress={send} startContent={<FontAwesomeIcon icon={faPaperPlane} />}>
            {t('sendImage')} · {durationSeconds}s
          </Button>
          {txStatus?.phase === 'on_air' || txStatus?.phase === 'draining' ? <Button isIconOnly className="min-h-11 min-w-11" color="danger" variant="flat" onPress={() => operatorId && txStatus.sessionId && connection.state.radioService?.cancelSstvTx({ requestId: createClientId(), operatorId, sessionId: txStatus.sessionId, expectedRevision: txStatus.revision })} aria-label={t('stop')} title={t('stop')}><FontAwesomeIcon icon={faStop} /></Button> : null}
        </div>
        {txStart.starting ? <Progress size="sm" value={txProgress} aria-label={t('transmitting')} /> : null}
      </div>
      <div className="flex min-w-0 flex-shrink-0 items-center gap-2 rounded-lg border border-default-200/70 bg-default-50/60 p-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
          <span className="shrink-0 px-1 text-[11px] font-medium text-default-500">{t('templateGroup')}</span>
          {templates.map((template) => (
            <Button
              key={template.id}
              size="sm"
              variant="flat"
              color={selectedTemplateId === template.id ? 'primary' : 'default'}
              className="h-10 min-w-14 max-w-40 shrink-0 px-3 md:h-8"
              aria-pressed={selectedTemplateId === template.id}
              title={template.name}
              onPress={() => applyTemplate(template.id)}
            >
              <span className="truncate text-sm font-semibold">{template.name}</span>
            </Button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {selectedTemplate && !selectedTemplate.builtIn ? (
            <Button isIconOnly size="sm" variant="light" color="danger" onPress={() => setDeleteTemplateId(selectedTemplate.id)} aria-label={t('deleteTemplate')} title={t('deleteTemplate')}>
              <FontAwesomeIcon icon={faTrash} />
            </Button>
          ) : null}
          <Button isIconOnly size="sm" variant="light" onPress={() => setTemplateSaveOpen((open) => !open)} aria-label={t('saveAsTemplate')} title={t('saveAsTemplate')}>
            <FontAwesomeIcon icon={faSave} />
          </Button>
        </div>
      </div>
      {templateSaveOpen ? (
        <div className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-default-50/40 p-1">
          <Input size="sm" placeholder={t('template')} value={templateName} onValueChange={setTemplateName} className="min-w-0 flex-1" />
          <Button isIconOnly size="sm" color="primary" isDisabled={!templateName.trim() || !operatorId} onPress={() => void saveTemplate()} aria-label={t('saveTemplate')} title={t('saveTemplate')}><FontAwesomeIcon icon={faSave} /></Button>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-shrink-0 items-center gap-1.5 rounded-lg border border-default-200/70 bg-default-50/60 p-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="group" aria-label={t('assetsGroup')}>
          <ButtonGroup size="sm" variant="flat" className="shrink-0" aria-label={t('background')}>
            <Button as="label" isLoading={backgroundSaving} startContent={<FontAwesomeIcon icon={faImage} />}>
              <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { void handleBackground(event.target.files?.[0]); event.target.value = ''; }} />
              {t('background')}
            </Button>
            <Button isIconOnly color={backgroundEditing ? 'primary' : 'default'} isDisabled={!background} aria-label={t('editBackground')} title={t('editBackground')} onPress={() => {
              setBackgroundEditing((value) => !value);
              setSelectedLayerId(null);
              setCropEditing(false);
              setCropZoomValue(1);
              setInspectorOpen(true);
            }}>
              <FontAwesomeIcon icon={faSliders} />
            </Button>
          </ButtonGroup>
          <Button as="label" size="sm" variant="flat" className="shrink-0" startContent={<FontAwesomeIcon icon={faImages} />}>
            <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { void handleImageLayer(event.target.files?.[0]); event.target.value = ''; }} />
            {t('addImage')}
          </Button>
          <Button size="sm" variant="flat" className="shrink-0" startContent={<FontAwesomeIcon icon={faFont} />} onPress={addTextLayer}>{t('addText')}</Button>
        </div>
        <span className="h-5 w-px shrink-0 bg-default-200" aria-hidden="true" />
        <Popover isOpen={layersOpen} onOpenChange={(open) => {
          setLayersOpen(open);
          if (open) setInspectorOpen(false);
        }} placement="bottom-end" offset={8}>
          <PopoverTrigger>
            <Button size="sm" variant="flat" className="shrink-0" color={layersOpen ? 'primary' : 'default'} isDisabled={!layers.length && !background} startContent={<FontAwesomeIcon icon={faLayerGroup} />}>
              {t('layerGroup')}
              <span className="text-[11px] tabular-nums text-default-500">{layers.length + (background ? 1 : 0)}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[min(20rem,calc(100vw-1rem))] min-w-0 p-2" aria-label={t('layerGroup')}>
            <div className="max-h-[min(20rem,50dvh)] w-full min-w-0 space-y-1 overflow-y-auto">
              {layers.map((layer, index) => ({ layer, index })).reverse().map(({ layer, index }) => (
                <div key={layer.id} className="flex min-w-0 items-center gap-1">
                  <Button size="sm" variant="flat" color={selectedLayerId === layer.id ? 'primary' : 'default'} className="h-10 min-w-0 flex-1 justify-start px-2" startContent={<FontAwesomeIcon className="shrink-0" icon={isImageLayer(layer) ? faImage : faFont} />} onPress={() => {
                    setLayersOpen(false);
                    setSelectedLayerId(layer.id);
                    setBackgroundEditing(false);
                    setCropEditing(false);
                    setCropZoomValue(1);
                    setInspectorOpen(true);
                  }}>
                    <span className="truncate">{isImageLayer(layer) ? `${t('imageLayer')} ${index + 1}` : layer.text}</span>
                  </Button>
                  <ButtonGroup size="sm" variant="light" className="shrink-0" aria-label={t('layerOrder')}>
                    <Button isIconOnly className="h-10" isDisabled={index === 0} aria-label={t('sendBackward')} title={t('sendBackward')} onPress={() => reorderLayer(layer.id, -1)}><FontAwesomeIcon icon={faArrowDown} /></Button>
                    <Button isIconOnly className="h-10" isDisabled={index === layers.length - 1} aria-label={t('bringForward')} title={t('bringForward')} onPress={() => reorderLayer(layer.id, 1)}><FontAwesomeIcon icon={faArrowUp} /></Button>
                  </ButtonGroup>
                </div>
              ))}
              {background ? (
                <Button size="sm" variant="flat" color={backgroundEditing ? 'primary' : 'default'} className="h-10 w-full min-w-0 justify-start px-2" startContent={<FontAwesomeIcon icon={faImage} />} onPress={() => {
                  setLayersOpen(false);
                  setSelectedLayerId(null);
                  setBackgroundEditing(true);
                  setCropEditing(false);
                  setCropZoomValue(1);
                  setInspectorOpen(true);
                }}>{t('background')}</Button>
              ) : null}
            </div>
          </PopoverContent>
        </Popover>
      </div>
      {imageLoading ? <Progress size="sm" isIndeterminate aria-label={t('imageLoading')} /> : null}

      <div
        ref={previewViewportRef}
        className="sstv-composer-preview-viewport flex items-center justify-center overflow-hidden"
      >
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
          {selectedTextLayer ? (
            <SstvTextLayerInspector
              layer={selectedTextLayer}
              placement={inspectorPlacement}
              isOpen={inspectorOpen}
              onOpenChange={setInspectorOpen}
              shouldCloseOnInteractOutside={shouldCloseInspectorOnInteractOutside}
              canvasWidth={canvasRef.current?.width ?? mode?.width ?? 320}
              canvasHeight={canvasRef.current?.height ?? mode?.height ?? 240}
              onChange={(next) => setLayers((current) => current.map((layer) => layer.id === next.id ? next : layer))}
              onDelete={removeSelectedTextLayer}
            />
          ) : null}
          {selectedImageLayer ? (
            <SstvImageLayerInspector
              transform={selectedImageLayer}
              placement={inspectorPlacement}
              isOpen={inspectorOpen}
              onOpenChange={setInspectorOpen}
              shouldCloseOnInteractOutside={shouldCloseInspectorOnInteractOutside}
              onChange={(transform) => setLayers((current) => current.map((layer) => layer.id === selectedImageLayer.id ? { ...selectedImageLayer, ...transform } : layer))}
              onFit={(nextFit) => fitImageLayer(selectedImageLayer, nextFit)}
              cropZoom={cropZoomValue}
              isCropping={cropEditing}
              onCropZoom={updateSelectedImageCropZoom}
              onToggleCrop={toggleCropEditing}
              onFlipX={() => flipSelectedImage('x')}
              onFlipY={() => flipSelectedImage('y')}
              onDelete={removeSelectedTextLayer}
            />
          ) : null}
          {backgroundEditing && backgroundTransform ? (
            <SstvImageLayerInspector
              transform={backgroundTransform}
              placement={inspectorPlacement}
              isOpen={inspectorOpen}
              onOpenChange={setInspectorOpen}
              shouldCloseOnInteractOutside={shouldCloseInspectorOnInteractOutside}
              onChange={setBackgroundTransform}
              onFit={fitBackground}
              cropZoom={cropZoomValue}
              isCropping={cropEditing}
              onCropZoom={updateSelectedImageCropZoom}
              onToggleCrop={toggleCropEditing}
              onFlipX={() => flipSelectedImage('x')}
              onFlipY={() => flipSelectedImage('y')}
            />
          ) : null}
        </div>
      </div>
      {cropEditing ? <div className="flex-shrink-0 text-center text-[11px] text-default-500">{t('cropHint')}</div> : null}

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
