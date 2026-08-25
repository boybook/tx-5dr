import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Popover, PopoverContent, PopoverTrigger, Select, SelectItem, Slider, Switch } from '@heroui/react';
import { addToast } from '@heroui/toast';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faFloppyDisk, faRotateLeft, faSatelliteDish, faSliders } from '@fortawesome/free-solid-svg-icons';
import { UserRole, type ImageFaxCalibration, type ImagePaperBoundary, type ImageReceiveProfile } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';

import { useImageRadioControls, useImageRadioReceive } from '../../hooks/useImageRadio';
import { useHasMinRole } from '../../store/authStore';
import { useCurrentOperatorId } from '../../store/radioStore';
import { ScrollToBottomButton } from '../common/ScrollToBottomButton';
import { buildPaperLayout, paperBottomTarget, visiblePaperItems } from './imagePaperVirtualLayout';
import { ImagePaperRowStore, writePaperRowsToRgba } from './ImagePaperRowStore';

const PAPER_CHUNK_LINES = 256;

function boundaryHeight(boundary: ImagePaperBoundary): number {
  if (boundary.kind === 'initial') return 0;
  if (boundary.kind === 'vis' || boundary.kind === 'syncTiming' || boundary.kind === 'aptPhasing' || boundary.kind === 'manualMode' || boundary.kind === 'localTxStart') return 18;
  if (boundary.kind === 'protocolEnd' || boundary.kind === 'localTxEnd') return 10;
  return 4;
}

function boundaryColor(boundary: ImagePaperBoundary): string | null {
  if (boundary.kind === 'vis') return '#22c55e';
  if (boundary.kind === 'syncTiming' || boundary.kind === 'aptPhasing' || boundary.kind === 'manualMode') return '#22d3ee';
  if (boundary.kind === 'truncated') return '#f59e0b';
  if (boundary.kind === 'protocolObserved') return '#ef4444';
  if (boundary.kind === 'localTxStart') return '#ef4444';
  if (boundary.kind === 'localTxEnd') return '#71717a';
  return null;
}

function PaperDivider({ boundary }: { boundary: ImagePaperBoundary }) {
  const height = boundaryHeight(boundary);
  if (height === 0) return null;
  const color = boundaryColor(boundary);
  const diagnostic = boundary.kind === 'protocolObserved' || boundary.kind === 'truncated' || boundary.kind === 'discontinuity' || boundary.kind === 'reset';
  return (
    <div className="relative w-full shrink-0 bg-black" style={{ height: diagnostic ? 4 : Math.max(8, height) }}>
      {color ? <div className={diagnostic ? 'absolute bottom-0 left-0 top-0 w-[28%]' : 'absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2'} style={{ backgroundColor: color }} /> : null}
    </div>
  );
}

const PaperChunk = memo(function PaperChunk({
  startLine, endLine, displayWidth, sourceWidth, pixelFormat, rowStore,
  snapshot, snapshotStartLine, markers, contentRevision, isTail, source,
  calibration,
}: {
  startLine: number; endLine: number; displayWidth: number; sourceWidth: number; pixelFormat: 'rgb8' | 'gray8';
  rowStore: ImagePaperRowStore;
  snapshot?: HTMLImageElement; snapshotStartLine: number;
  markers: ImagePaperBoundary[]; contentRevision: number; isTail: boolean; source: 'rx' | 'localTx';
  calibration?: ImageFaxCalibration;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageDataRef = useRef<ImageData | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const height = Math.max(1, endLine - startLine);
    if (!canvas) return;
    if (canvas.width !== displayWidth) canvas.width = displayWidth;
    if (canvas.height !== height) canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return;
    context.fillStyle = '#000'; context.fillRect(0, 0, displayWidth, height);
    if (snapshot?.complete && snapshot.naturalWidth > 0) {
      const sourceY = Math.max(0, startLine - snapshotStartLine);
      context.drawImage(snapshot, 0, sourceY, snapshot.naturalWidth, height, 0, 0, displayWidth, height);
    }

    if (!imageDataRef.current || imageDataRef.current.width !== sourceWidth || imageDataRef.current.height !== height) {
      imageDataRef.current = new ImageData(sourceWidth, height);
    }
    writePaperRowsToRgba(imageDataRef.current.data, sourceWidth, startLine, endLine, pixelFormat, rowStore, snapshot ? undefined : calibration, snapshotStartLine);
    if (sourceWidth === displayWidth && !snapshot) {
      context.putImageData(imageDataRef.current, 0, 0);
    } else {
      let sourceCanvas = sourceCanvasRef.current;
      if (!sourceCanvas) {
        sourceCanvas = document.createElement('canvas');
        sourceCanvasRef.current = sourceCanvas;
      }
      if (sourceCanvas.width !== sourceWidth) sourceCanvas.width = sourceWidth;
      if (sourceCanvas.height !== height) sourceCanvas.height = height;
      const sourceContext = sourceCanvas.getContext('2d', { alpha: true });
      if (!sourceContext) return;
      sourceContext.putImageData(imageDataRef.current, 0, 0);
      context.drawImage(sourceCanvas, 0, 0, sourceWidth, height, 0, 0, displayWidth, height);
    }
    if (!isTail) {
      imageDataRef.current = null;
      if (sourceCanvasRef.current) {
        sourceCanvasRef.current.width = 1;
        sourceCanvasRef.current.height = 1;
      }
      sourceCanvasRef.current = null;
    }
  }, [calibration, contentRevision, displayWidth, endLine, isTail, pixelFormat, rowStore, snapshot, snapshotStartLine, sourceWidth, startLine]);
  return (
    <div className="relative h-full w-full">
      <canvas ref={canvasRef} className="block h-auto w-full [image-rendering:auto]" style={{ contentVisibility: 'auto', containIntrinsicSize: `auto ${Math.max(1, endLine - startLine)}px` }} />
      {source === 'localTx' ? <div className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-danger" /> : null}
      {markers.map((marker) => {
        const color = boundaryColor(marker);
        if (!color || marker.lineIndex < startLine || marker.lineIndex >= endLine) return null;
        return <div key={marker.boundaryId} className="pointer-events-none absolute left-0 h-[3px] w-[28%]" style={{ top: `${(marker.lineIndex - startLine) / Math.max(1, endLine - startLine) * 100}%`, backgroundColor: color }} />;
      })}
    </div>
  );
}, (previous, next) => (
  previous.startLine === next.startLine
  && previous.endLine === next.endLine
  && previous.displayWidth === next.displayWidth
  && previous.sourceWidth === next.sourceWidth
  && previous.pixelFormat === next.pixelFormat
  && previous.rowStore === next.rowStore
  && previous.snapshot === next.snapshot
  && previous.snapshotStartLine === next.snapshotStartLine
  && previous.contentRevision === next.contentRevision
  && previous.isTail === next.isTail
  && previous.source === next.source
  && previous.calibration?.revision === next.calibration?.revision
  && previous.markers.length === next.markers.length
  && previous.markers.every((marker, index) => marker.boundaryId === next.markers[index]?.boundaryId && marker.lineIndex === next.markers[index]?.lineIndex)
));

function FaxCalibrationPopover({
  calibration, width, disabled, onApply, onReset,
}: {
  calibration: ImageFaxCalibration; width: number; disabled: boolean;
  onApply: (autoEnabled: boolean, phasePixels: number, clockPpm: number) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation('image');
  const [autoEnabled, setAutoEnabled] = useState(calibration.autoEnabled);
  const [phasePixels, setPhasePixels] = useState(calibration.manualPhasePixels);
  const [clockPpm, setClockPpm] = useState(calibration.manualClockPpm);
  useEffect(() => {
    setAutoEnabled(calibration.autoEnabled);
    setPhasePixels(calibration.manualPhasePixels);
    setClockPpm(calibration.manualClockPpm);
  }, [calibration]);
  const latest = calibration.autoPoints.at(-1);
  const indicator = latest?.status === 'locked' || latest?.status === 'tracking' ? 'bg-success' : latest ? 'bg-warning' : 'bg-default-500';
  return (
    <Popover placement="bottom-start">
      <PopoverTrigger>
        <Button isIconOnly size="sm" variant="light" className="relative h-7 min-h-7 w-7 min-w-7 text-white data-[hover=true]:bg-white/15" aria-label={t('faxCalibration', { defaultValue: 'FAX' })} title={latest ? `${latest.status} · ${latest.clockPpm.toFixed(1)} ppm` : t('faxCalibration', { defaultValue: 'FAX' })}>
          <FontAwesomeIcon icon={faSliders} />
          <span className={`absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full ${indicator}`} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(20rem,calc(100vw-1rem))] gap-3 p-3">
        <Switch size="sm" isSelected={autoEnabled} isDisabled={disabled} onValueChange={setAutoEnabled}>{t('auto')}</Switch>
        <Slider size="sm" label="Phase" value={phasePixels} minValue={-width / 2} maxValue={width / 2} step={1} isDisabled={disabled} onChange={(value) => setPhasePixels(Number(value))} />
        <Slider size="sm" label="ppm" value={clockPpm} minValue={-5000} maxValue={5000} step={1} isDisabled={disabled} onChange={(value) => setClockPpm(Number(value))} />
        <div className="flex justify-end gap-2">
          <Button isIconOnly size="sm" variant="flat" isDisabled={disabled} onPress={onReset} aria-label="Reset" title="Reset"><FontAwesomeIcon icon={faRotateLeft} /></Button>
          <Button isIconOnly size="sm" variant="flat" isDisabled={disabled} onPress={() => onApply(autoEnabled, phasePixels, clockPpm)} aria-label="Apply" title="Apply"><FontAwesomeIcon icon={faCheck} /></Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function ImageReceiveCanvas() {
  const { t } = useTranslation('image');
  const canConfigure = useHasMinRole(UserRole.OPERATOR);
  const { currentOperatorId } = useCurrentOperatorId();
  const { session, rowStore, boundaries, segmentSnapshots, faxCalibrations } = useImageRadioReceive();
  const { status, txStatus, modes, configureReceive, saveCurrentPaper, setFaxCalibration, resetFaxCalibration } = useImageRadioControls();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followTailRef = useRef(true);
  const snapshotImagesRef = useRef(new Map<string, HTMLImageElement>());
  const scrollFrameRef = useRef<number | null>(null);
  const [isChangingProfile, setIsChangingProfile] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [imageRevision, setImageRevision] = useState(0);
  const [followingTail, setFollowingTail] = useState(true);
  const [viewport, setViewport] = useState({ width: 1, height: 1, scrollTop: 0 });

  const selectedMode = useMemo(() => {
    const profile = status?.receiveProfile;
    if (!profile) return 'auto';
    if (profile.strategy === 'auto') return 'auto';
    if (profile.family === 'sstv') return profile.mode;
    return `${profile.ioc}-${profile.lpm}-${profile.modulation}`;
  }, [status?.receiveProfile]);
  const activeFaxCalibration = useMemo(() => {
    if (session?.family !== 'fax') return undefined;
    return [...boundaries].reverse().map((boundary) => faxCalibrations.get(boundary.boundaryId)).find(Boolean);
  }, [boundaries, faxCalibrations, session?.family]);

  const changeProfile = async (key: string) => {
    const family = status?.receiveProfile?.family;
    if (!family) return;
    setIsChangingProfile(true);
    try {
      let profile: ImageReceiveProfile;
      if (family === 'sstv') {
        profile = key === 'auto' ? { family: 'sstv', strategy: 'auto' } : { family: 'sstv', strategy: 'manual', mode: key };
      } else if (key === 'auto') {
        profile = { family: 'fax', strategy: 'auto' };
      } else {
        const [ioc, lpm, modulation] = key.split('-') as ['ioc288' | 'ioc576', string, 'fm' | 'am'];
        profile = { family: 'fax', strategy: 'manual', ioc, lpm: Number(lpm), modulation, centerHz: 1900, deviationHz: 400 };
      }
      await configureReceive(profile);
    } catch {
      addToast({ title: t('modeChangeFailed'), color: 'danger' });
    } finally {
      setIsChangingProfile(false);
    }
  };

  useEffect(() => {
    if (segmentSnapshots.size === 0) return;
    let cancelled = false;
    snapshotImagesRef.current.clear();
    const images = [...segmentSnapshots].map(([boundaryId, url]) => new Promise<void>((resolve) => {
      const image = new Image();
      snapshotImagesRef.current.set(boundaryId, image);
      image.onload = () => resolve();
      image.onerror = () => resolve();
      image.src = url;
    }));
    void Promise.all(images).then(() => { if (!cancelled) setImageRevision((value) => value + 1); });
    return () => { cancelled = true; };
  }, [segmentSnapshots]);

  const paperSections = useMemo(() => {
    void imageRevision;
    if (!session) return [];
    const markerKinds = new Set(['protocolObserved', 'truncated']);
    const ordered = boundaries.filter((boundary) => boundary.lineIndex >= session.firstAvailableLine).sort((a, b) => a.lineIndex - b.lineIndex || a.timestamp - b.timestamp);
    const structural = ordered.filter((boundary) => !markerKinds.has(boundary.kind));
    const markers = ordered.filter((boundary) => markerKinds.has(boundary.kind));
    return structural.flatMap((boundary, index) => {
      const startLine = Math.max(boundary.lineIndex, session.firstAvailableLine);
      const endLine = Math.max(startLine, structural[index + 1]?.lineIndex ?? session.receivedLines);
      const chunks = [];
      for (let start = startLine; start < endLine; start += PAPER_CHUNK_LINES) {
        chunks.push({ startLine: start, endLine: Math.min(endLine, start + PAPER_CHUNK_LINES) });
      }
      return [{
        boundary, displayWidth: boundary.width, chunks,
        calibration: faxCalibrations.get(boundary.boundaryId),
        snapshot: snapshotImagesRef.current.get(boundary.boundaryId),
        markers: markers.filter((marker) => marker.lineIndex >= startLine && marker.lineIndex < endLine),
      }];
    });
  }, [boundaries, faxCalibrations, imageRevision, session]);

  const paperLayout = useMemo(() => {
    return buildPaperLayout(
      paperSections.map((section) => ({ ...section, data: section })),
      viewport.width,
      boundaryHeight,
    );
  }, [paperSections, viewport.width]);

  const paperOffset = Math.max(0, viewport.height - paperLayout.height);
  const overscan = Math.min(256, viewport.height * 0.35);
  const visibleItems = visiblePaperItems(paperLayout.items, paperOffset, viewport.scrollTop, viewport.height, overscan);
  const txActive = txStatus?.phase === 'preparing' || txStatus?.phase === 'waiting_for_lease'
    || txStatus?.phase === 'keying' || txStatus?.phase === 'on_air' || txStatus?.phase === 'draining';

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const updateSize = () => setViewport((current) => ({ ...current, width: Math.max(1, element.clientWidth), height: Math.max(1, element.clientHeight), scrollTop: element.scrollTop }));
    updateSize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateSize);
    observer?.observe(element);
    window.addEventListener('resize', updateSize);
    return () => { observer?.disconnect(); window.removeEventListener('resize', updateSize); };
  }, []);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !followTailRef.current) return;
    const target = paperBottomTarget(paperLayout.height, viewport.height);
    element.scrollTop = target;
    setViewport((current) => current.scrollTop === target ? current : { ...current, scrollTop: target });
  }, [boundaries, imageRevision, paperLayout.height, session?.receivedLines, viewport.height]);

  const handleScroll = () => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const atTail = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 2;
      followTailRef.current = atTail;
      setFollowingTail(atTail);
      setViewport((current) => ({ ...current, scrollTop: viewport.scrollTop }));
    });
  };

  const handleSave = async () => {
    if (!currentOperatorId || !session) return;
    setIsSaving(true);
    try {
      await saveCurrentPaper(currentOperatorId);
      addToast({ title: t('paperSaved'), color: 'success' });
    } catch {
      addToast({ title: t('paperSaveFailed'), color: 'danger' });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-black">
      {!session ? (
        <div className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center">
          <div className="flex h-28 w-28 items-center justify-center rounded-full border border-default-700 text-default-500">
            <FontAwesomeIcon icon={faSatelliteDish} className={status?.rxState === 'searching' ? 'text-3xl motion-safe:animate-pulse' : 'text-3xl'} />
          </div>
        </div>
      ) : null}
      <div ref={scrollRef} onScroll={handleScroll} className="h-full w-full overflow-x-hidden overflow-y-auto">
        <div className="relative w-full" style={{ height: `${Math.max(viewport.height, paperLayout.height)}px` }}>
          {visibleItems.map((item) => (
            <div key={item.key} className="absolute inset-x-0" style={{ top: `${paperOffset + item.top}px`, height: `${item.height}px` }}>
              {item.kind === 'divider' ? <PaperDivider boundary={item.boundary} /> : (
                <PaperChunk
                  startLine={item.startLine} endLine={item.endLine}
                  displayWidth={item.data.displayWidth} sourceWidth={item.data.boundary.width}
                  pixelFormat={item.data.boundary.pixelFormat} rowStore={rowStore}
                  snapshotStartLine={item.data.boundary.lineIndex}
                  markers={item.data.markers} snapshot={item.data.snapshot}
                  contentRevision={rowStore.rangeRevision(item.startLine, item.endLine) + imageRevision}
                  isTail={item.endLine === session.receivedLines}
                  source={item.data.boundary.source ?? 'rx'}
                  calibration={item.data.calibration}
                />
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-2 top-2 z-[2] flex items-start justify-between gap-2">
        <div className="pointer-events-auto flex h-8 min-w-0 items-center gap-1 rounded-medium bg-black/70 px-1 text-xs text-white">
          {session ? <span className="max-w-36 truncate px-1 font-mono">{txActive ? `TX · ${txStatus?.mode ?? session.codecMode ?? t('auto')}` : `${session.codecMode ?? t('auto')} · ${session.receivedLines}`}</span> : null}
          {activeFaxCalibration ? <FaxCalibrationPopover calibration={activeFaxCalibration} width={session?.width ?? 1810} disabled={!canConfigure} onApply={(autoEnabled, phasePixels, clockPpm) => setFaxCalibration(activeFaxCalibration, autoEnabled, phasePixels, clockPpm)} onReset={() => resetFaxCalibration(activeFaxCalibration)} /> : null}
          <Button isIconOnly size="sm" variant="light" className="h-7 min-h-7 w-7 min-w-7 text-white data-[hover=true]:bg-white/15" isDisabled={!session || !currentOperatorId || isSaving} isLoading={isSaving} onPress={() => void handleSave()} aria-label={t('savePaper')} title={t('savePaper')}>
            <FontAwesomeIcon icon={faFloppyDisk} />
          </Button>
        </div>
        {status?.receiveProfile ? (
          <Select
            aria-label={t('receiveMode')} size="sm" variant="flat" disallowEmptySelection
            isDisabled={!canConfigure || isChangingProfile} selectedKeys={new Set([selectedMode])}
            onSelectionChange={(keys) => void changeProfile(String(Array.from(keys)[0] ?? 'auto'))}
            className="pointer-events-auto w-40 sm:w-48"
            classNames={{
              trigger: 'h-8 min-h-8 bg-black/70 text-white data-[hover=true]:bg-black/80 [&_[data-slot=value]]:!text-white',
              value: 'text-xs !text-white',
              selectorIcon: 'text-white',
            }}
          >
            <SelectItem key="auto" textValue={t('auto')}>{t('auto')}</SelectItem>
            {status.receiveProfile.family === 'sstv'
              ? modes.map((mode) => <SelectItem key={mode.mode} textValue={mode.name}>{mode.name}</SelectItem>)
              : [
                <SelectItem key="ioc576-120-fm">IOC576 · 120 · FM</SelectItem>,
                <SelectItem key="ioc288-120-fm">IOC288 · 120 · FM</SelectItem>,
                <SelectItem key="ioc576-120-am">IOC576 · 120 · AM</SelectItem>,
              ]}
          </Select>
        ) : null}
      </div>
      {!followingTail ? (
        <ScrollToBottomButton iconOnly className="absolute bottom-3 right-3 z-[3]" label={t('followLatest')} onPress={() => { followTailRef.current = true; setFollowingTail(true); if (scrollRef.current) { const target = Math.max(0, scrollRef.current.scrollHeight - scrollRef.current.clientHeight); scrollRef.current.scrollTop = target; setViewport((current) => ({ ...current, scrollTop: target })); } }} />
      ) : null}
    </div>
  );
}
