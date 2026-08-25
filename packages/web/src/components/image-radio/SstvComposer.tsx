import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, ButtonGroup, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Progress, Select, SelectItem, Slider } from '@heroui/react';
import { addToast } from '@heroui/toast';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faImage, faPaperPlane, faPlus, faSave, faStop, faTrash } from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import type { ImageTemplateTextLayer } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';

import { useImageRadioControls } from '../../hooks/useImageRadio';
import { useConnection, useCurrentOperatorId, useOperators, useRadioModeState } from '../../store/radioStore';
import { fitComposerBackgroundSize } from './composerBackground';
import { sstvTxErrorTranslationKey } from './sstvTxCommand';

type TextLayer = ImageTemplateTextLayer;
type PreparedSstvTx = { artifactId: string; operatorId: string; mode: string; expectedFrequency: number };

export function SstvComposer() {
  const { t } = useTranslation('image');
  const { status, modes, templates, refreshTemplates, txStatus, txCommandResult } = useImageRadioControls();
  const connection = useConnection();
  const radio = useRadioModeState();
  const { currentOperatorId } = useCurrentOperatorId();
  const { operators } = useOperators();
  const operator = operators.find((item) => item.id === currentOperatorId) ?? operators[0];
  const operatorId = operator?.id;
  const [selectedMode, setSelectedMode] = useState('robot36');
  const [layers, setLayers] = useState<TextLayer[]>([]);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
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
  const [sending, setSending] = useState(false);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [captureConfirmOpen, setCaptureConfirmOpen] = useState(false);
  const [previewSize, setPreviewSize] = useState<{ width: number; height: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const backgroundRef = useRef<ImageBitmap | null>(null);
  const backgroundSaveGenerationRef = useRef(0);
  const previewViewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const preparedTxRef = useRef<PreparedSstvTx | null>(null);
  const operatorIdRef = useRef(operatorId);
  operatorIdRef.current = operatorId;
  const mode = modes.find((item) => item.mode === selectedMode) ?? modes.find((item) => item.mode === 'robot36') ?? modes[0];
  const durationSeconds = mode ? Math.ceil(mode.lineSeconds * mode.height) : 0;
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
    RSV: rsv, UTC: new Date().toISOString().slice(11, 16), FREQ: radio.currentRadioFrequency ? `${(radio.currentRadioFrequency / 1e6).toFixed(3)}` : '', NOTE: note,
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
      context.textAlign = layer.align; context.textBaseline = 'middle';
      while (fontPx > 8 && context.measureText(text).width > width) { fontPx -= 1; context.font = `700 ${fontPx}px sans-serif`; }
      context.font = `700 ${fontPx}px sans-serif`;
      const textX = layer.align === 'left' ? x : layer.align === 'right' ? x + width : x + width / 2;
      const textY = y + height / 2;
      if (layer.strokeColor) { context.strokeStyle = layer.strokeColor; context.lineWidth = Math.max(2, fontPx / 12); context.strokeText(text, textX, textY, width); }
      context.fillStyle = layer.color; context.fillText(text, textX, textY, width);
      if (showSelection && layer.id === selectedLayerId) {
        context.strokeStyle = '#38bdf8'; context.lineWidth = 2; context.setLineDash([5, 4]); context.strokeRect(x, y, width, height); context.setLineDash([]);
      }
    }
  }, [background, fit, layers, mode, resolveText, selectedLayerId]);

  useEffect(() => { draw(); }, [draw]);

  const applyTemplate = (id: string) => {
    const template = templates.find((item) => item.id === id);
    if (!template) return;
    setSelectedTemplateId(id);
    setLayers(template.layers.map((layer) => ({ ...layer })));
    setSelectedLayerId(null);
  };

  const addTextLayer = () => {
    const layer = { id: crypto.randomUUID(), text: '{NOTE}', x: 0.1, y: 0.4, width: 0.8, height: 0.16, fontSize: 0.09, color: '#ffffff', strokeColor: '#000000', align: 'center' as const };
    setLayers((current) => [...current, layer]);
    setSelectedLayerId(layer.id);
  };

  const removeSelectedTextLayer = () => {
    if (!selectedLayerId) return;
    const selectedIndex = layers.findIndex((layer) => layer.id === selectedLayerId);
    if (selectedIndex < 0) return;
    const remainingLayers = layers.filter((layer) => layer.id !== selectedLayerId);
    const adjacentLayer = remainingLayers[Math.min(selectedIndex, remainingLayers.length - 1)];
    if (dragRef.current?.id === selectedLayerId) dragRef.current = null;
    setLayers(remainingLayers);
    setSelectedLayerId(adjacentLayer?.id ?? null);
  };

  const saveTemplate = async () => {
    if (!operatorId || !templateName.trim()) return;
    try {
      await api.saveImageTemplate({
        id: crypto.randomUUID(), operatorId, name: templateName.trim(), builtIn: false,
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
    if (file.size > 5 * 1024 * 1024 || !/^image\/(png|jpeg|webp)$/.test(file.type)) return;
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

  const pointerPosition = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  };
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = pointerPosition(event);
    const layer = [...layers].reverse().find((item) => point.x >= item.x && point.x <= item.x + item.width && point.y >= item.y && point.y <= item.y + item.height);
    if (!layer) return;
    setSelectedLayerId(layer.id); dragRef.current = { id: layer.id, dx: point.x - layer.x, dy: point.y - layer.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current; if (!drag) return;
    const point = pointerPosition(event);
    setLayers((current) => current.map((layer) => layer.id === drag.id ? { ...layer, x: Math.max(0, Math.min(1 - layer.width, point.x - drag.dx)), y: Math.max(0, Math.min(1 - layer.height, point.y - drag.dy)) } : layer));
  };

  const dispatchPreparedTx = (prepared: PreparedSstvTx, interruptActiveCapture: boolean) => {
    const service = connection.state.radioService;
    if (!service || !connection.state.isReady) throw new Error('IMAGE_CONNECTION_UNAVAILABLE');
    const requestId = crypto.randomUUID();
    preparedTxRef.current = prepared;
    setPendingRequestId(requestId);
    setSending(true);
    service.startSstvTx({ requestId, ...prepared, interruptActiveCapture });
  };

  const send = async (interruptActiveCapture = false) => {
    if (!mode || !operatorId || !radio.currentRadioFrequency || !canvasRef.current) return;
    if (status?.rxCaptureActive && !interruptActiveCapture) {
      setCaptureConfirmOpen(true);
      return;
    }
    setSending(true);
    try {
      if (!connection.state.radioService || !connection.state.isReady) throw new Error('IMAGE_CONNECTION_UNAVAILABLE');
      setSelectedLayerId(null); draw(false);
      const blob = await new Promise<Blob>((resolve, reject) => canvasRef.current?.toBlob((value) => value ? resolve(value) : reject(new Error('PNG render failed')), 'image/png'));
      const upload = await api.uploadSstvArtifact({ file: blob, operatorId, mode: mode.mode, frequency: radio.currentRadioFrequency, radioMode: radio.currentRadioMode ?? undefined });
      dispatchPreparedTx({ operatorId, artifactId: upload.artifact.id, mode: mode.mode, expectedFrequency: radio.currentRadioFrequency }, interruptActiveCapture);
    } catch (error) {
      addToast({ title: error instanceof Error ? error.message : t('sendFailed'), color: 'danger' });
      setSending(false);
    }
  };

  const confirmCaptureInterrupt = () => {
    setCaptureConfirmOpen(false);
    const prepared = preparedTxRef.current;
    if (prepared) {
      try {
        dispatchPreparedTx(prepared, true);
      } catch (error) {
        addToast({ title: error instanceof Error ? error.message : t('sendFailed'), color: 'danger' });
        setSending(false);
      }
      return;
    }
    void send(true);
  };

  useEffect(() => {
    if (!pendingRequestId || txCommandResult?.requestId !== pendingRequestId) return;
    setPendingRequestId(null);
    if (txCommandResult.accepted) return;
    setSending(false);
    if (txCommandResult.errorCode === 'IMAGE_RX_CAPTURE_CONFIRM_REQUIRED') {
      setCaptureConfirmOpen(true);
      return;
    }
    preparedTxRef.current = null;
    addToast({ title: t(sstvTxErrorTranslationKey(txCommandResult.errorCode)), color: 'danger' });
  }, [pendingRequestId, t, txCommandResult]);

  useEffect(() => {
    if (!pendingRequestId) return;
    if (txStatus?.requestId === pendingRequestId && txStatus.phase !== 'idle') {
      setPendingRequestId(null);
      return;
    }
    const timeout = window.setTimeout(() => {
      setPendingRequestId(null);
      preparedTxRef.current = null;
      setSending(false);
      addToast({ title: t('txAckTimeout'), color: 'danger' });
    }, 5_000);
    return () => window.clearTimeout(timeout);
  }, [pendingRequestId, t, txStatus?.phase, txStatus?.requestId]);

  useEffect(() => {
    if (txStatus?.phase === 'completed' || txStatus?.phase === 'error' || txStatus?.phase === 'cancelled' || txStatus?.phase === 'ptt_unknown') {
      setSending(false);
      setPendingRequestId(null);
      preparedTxRef.current = null;
    }
  }, [txStatus?.phase]);

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
          className="relative overflow-hidden rounded-md border border-default-200 bg-black"
          style={{
            width: previewSize ? `${previewSize.width}px` : '100%',
            height: previewSize ? `${previewSize.height}px` : 'auto',
            aspectRatio: mode ? `${mode.width} / ${mode.height}` : '4 / 3',
          }}
        >
          <canvas ref={canvasRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => { dragRef.current = null; }} className="h-full w-full touch-none object-contain" />
        </div>
      </div>

      <div className="grid flex-shrink-0 gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 9rem), 1fr))' }}>
        <Input size="sm" label={t('to')} value={hisCall} onValueChange={(value) => setHisCall(value.toUpperCase())} />
        <Input size="sm" label="RSV" value={rsv} onValueChange={setRsv} />
        <Input size="sm" label={t('note')} value={note} onValueChange={setNote} />
      </div>

      {selectedLayer ? (
        <div className="flex flex-shrink-0 items-center gap-2 border-l-2 border-primary-400 pl-2">
          <div className="grid min-w-0 flex-1 gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 12rem), 1fr))' }}>
            <Input size="sm" label={t('layerText')} value={selectedLayer.text} onValueChange={(value) => setLayers((current) => current.map((layer) => layer.id === selectedLayer.id ? { ...layer, text: value } : layer))} />
            <Slider size="sm" minValue={0.03} maxValue={0.25} step={0.01} value={selectedLayer.fontSize} onChange={(value) => setLayers((current) => current.map((layer) => layer.id === selectedLayer.id ? { ...layer, fontSize: Number(value) } : layer))} label={t('textSize')} />
          </div>
          <Button isIconOnly size="sm" variant="light" color="danger" className="shrink-0" onPress={removeSelectedTextLayer} aria-label={t('deleteText')} title={t('deleteText')}>
            <FontAwesomeIcon icon={faTrash} />
          </Button>
        </div>
      ) : null}

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
      </div>

      {sending ? <Progress size="sm" value={txProgress} aria-label={t('transmitting')} className="flex-shrink-0" /> : null}
      <div className="flex flex-shrink-0 items-center gap-2 pb-2">
        <Button color="danger" className="min-h-11 flex-1" isLoading={sending && txStatus?.phase !== 'on_air'} isDisabled={!mode || !operatorId || sending} onPress={() => void send()} startContent={<FontAwesomeIcon icon={faPaperPlane} />}>{t('sendImage')} · {durationSeconds}s</Button>
        {txStatus?.phase === 'on_air' || txStatus?.phase === 'draining' ? <Button isIconOnly className="min-h-11 min-w-11" color="danger" variant="flat" onPress={() => operatorId && txStatus.sessionId && connection.state.radioService?.cancelSstvTx({ requestId: crypto.randomUUID(), operatorId, sessionId: txStatus.sessionId, expectedRevision: txStatus.revision })} aria-label={t('stop')}><FontAwesomeIcon icon={faStop} /></Button> : null}
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
    <Modal isOpen={captureConfirmOpen} onClose={() => { if (!sending) setCaptureConfirmOpen(false); }} size="sm" placement="center">
      <ModalContent>
        <ModalHeader>{t('interruptReceiveTitle')}</ModalHeader>
        <ModalBody>
          <p className="text-sm text-default-600">{t('interruptReceiveConfirm')}</p>
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={() => { setCaptureConfirmOpen(false); preparedTxRef.current = null; }}>{t('common:button.cancel')}</Button>
          <Button color="danger" onPress={confirmCaptureInterrupt}>{t('interruptAndSend')}</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
    </>
  );
}
