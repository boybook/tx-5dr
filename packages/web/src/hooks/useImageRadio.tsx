import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { api } from '@tx5dr/core';
import type { ImagePaperBoundary, ImageRadioStatus, ImageReceiveProfile, ImageRxEvent, ImageSessionSummary, ImageSstvModeInfo, ImageTemplate, SstvTxCommandResult, SstvTxStatus } from '@tx5dr/contracts';

import { useConnection, useRadioModeState } from '../store/radioStore';
import { decodeImageRowBase64, ImagePaperRowStore } from '../components/image-radio/ImagePaperRowStore';

interface ImageRadioReceiveContextValue {
  session: ImageSessionSummary | null;
  pixelFormat: 'rgb8' | 'gray8';
  rowStore: ImagePaperRowStore;
  boundaries: ImagePaperBoundary[];
  segmentSnapshots: Map<string, string>;
}

interface ImageRadioControlContextValue {
  status: ImageRadioStatus | null;
  txStatus: SstvTxStatus | null;
  txCommandResult: SstvTxCommandResult | null;
  modes: ImageSstvModeInfo[];
  templates: ImageTemplate[];
  configureReceive: (profile: ImageReceiveProfile) => Promise<void>;
  saveCurrentPaper: (operatorId: string) => Promise<void>;
  refreshTemplates: (operatorId?: string) => Promise<void>;
}

type ImageRadioContextValue = ImageRadioReceiveContextValue & ImageRadioControlContextValue;

const ImageRadioReceiveContext = createContext<ImageRadioReceiveContextValue | null>(null);
const ImageRadioControlContext = createContext<ImageRadioControlContextValue | null>(null);

export function ImageRadioProvider({ children }: { children: ReactNode }) {
  const connection = useConnection();
  const radioMode = useRadioModeState();
  const [status, setStatus] = useState<ImageRadioStatus | null>(null);
  const [txStatus, setTxStatus] = useState<SstvTxStatus | null>(null);
  const [txCommandResult, setTxCommandResult] = useState<SstvTxCommandResult | null>(null);
  const [session, setSession] = useState<ImageSessionSummary | null>(null);
  const [pixelFormat, setPixelFormat] = useState<'rgb8' | 'gray8'>('rgb8');
  const [modes, setModes] = useState<ImageSstvModeInfo[]>([]);
  const [templates, setTemplates] = useState<ImageTemplate[]>([]);
  const [boundaries, setBoundaries] = useState<ImagePaperBoundary[]>([]);
  const [segmentSnapshots, setSegmentSnapshots] = useState(new Map<string, string>());
  const sessionRef = useRef<ImageSessionSummary | null>(null);
  const rowStoreRef = useRef(new ImagePaperRowStore());
  const segmentSnapshotUrlsRef = useRef(new Set<string>());

  const applyStatus = useCallback((value: ImageRadioStatus | null) => {
    setStatus(value);
    const current = value?.currentSession;
    if (!current) return;
    if (sessionRef.current?.sessionId !== current.sessionId) {
      rowStoreRef.current.clear();
      setBoundaries([]);
      for (const url of segmentSnapshotUrlsRef.current) URL.revokeObjectURL(url);
      segmentSnapshotUrlsRef.current.clear();
      setSegmentSnapshots(new Map());
      setPixelFormat(current.family === 'fax' ? 'gray8' : 'rgb8');
    }
    sessionRef.current = current;
    setSession(current);
  }, []);

  const refreshTemplates = useCallback(async (operatorId?: string) => {
    const result = await api.getImageTemplates(operatorId);
    if (result.success) setTemplates(result.templates);
  }, []);

  const configureReceive = useCallback(async (profile: ImageReceiveProfile) => {
    const result = await api.setImageReceiveProfile(profile);
    if (result.success) setStatus(result.status);
  }, []);

  const saveCurrentPaper = useCallback(async (operatorId: string) => {
    const current = sessionRef.current;
    if (!current) return;
    await api.saveCurrentImagePaper({ requestId: crypto.randomUUID(), operatorId, expectedRevision: current.revision });
  }, []);

  useEffect(() => {
    if (radioMode.engineMode !== 'image') return;
    void api.getImageRadioStatus().then((result) => applyStatus(result.status));
    void api.getImageRadioModes().then((result) => setModes(result.modes));
  }, [applyStatus, radioMode.engineMode]);

  useEffect(() => {
    const service = connection.state.radioService;
    if (!service || !connection.state.isReady || radioMode.engineMode !== 'image') return;
    const ws = service.wsClientInstance;
    const onStatus = (value: ImageRadioStatus) => applyStatus(value);
    const onTxStatus = (value: SstvTxStatus) => setTxStatus(value);
    const onTxCommandResult = (value: SstvTxCommandResult) => setTxCommandResult(value);
    const onRxEvent = (event: ImageRxEvent) => {
      if (event.type === 'paperStarted') {
        rowStoreRef.current.clear();
        sessionRef.current = event.session;
        setSession(event.session);
        setPixelFormat(event.pixelFormat);
        setBoundaries([]);
      } else if (event.type === 'boundary') {
        if (event.boundary.kind === 'truncated') {
          rowStoreRef.current.deleteBefore(event.boundary.lineIndex);
        }
        setBoundaries((current) => [...current.filter((item) => item.boundaryId !== event.boundary.boundaryId), event.boundary].sort((a, b) => a.lineIndex - b.lineIndex || a.timestamp - b.timestamp));
        setSession((current) => {
          if (!current) return current;
          const next = {
            ...current, revision: event.revision, codecMode: event.boundary.codecMode, width: event.boundary.width,
            firstAvailableLine: event.boundary.kind === 'truncated' ? event.boundary.lineIndex : current.firstAvailableLine,
          };
          sessionRef.current = next;
          return next;
        });
      } else if (event.type === 'rows') {
        for (const row of event.rows) {
          rowStoreRef.current.set(row.rowIndex, {
            width: row.width,
            pixels: decodeImageRowBase64(row.dataBase64),
            rowRevision: row.rowRevision,
          });
        }
        setSession((current) => {
          if (!current) return current;
          const next = { ...current, revision: event.revision, receivedLines: Math.max(current.receivedLines, ...event.rows.map((row) => row.rowIndex + 1)) };
          sessionRef.current = next;
          return next;
        });
      } else if (event.type === 'snapshotRequired') {
        void api.getImagePaperManifest().then(async (result) => {
          if (!result.success) return;
          sessionRef.current = result.manifest.session;
          setSession(result.manifest.session);
          setBoundaries(result.manifest.boundaries);
          const snapshots = new Map<string, string>();
          await Promise.all(result.manifest.segments.filter((segment) => segment.endLine > segment.startLine).map(async (segment) => {
            const blob = await api.getImagePaperSegmentSnapshot(segment.boundaryId);
            snapshots.set(segment.boundaryId, URL.createObjectURL(blob));
          }));
          setSegmentSnapshots((current) => {
            for (const url of current.values()) URL.revokeObjectURL(url);
            segmentSnapshotUrlsRef.current = new Set(snapshots.values());
            return snapshots;
          });
        }).catch(() => undefined);
      } else if (event.type === 'imageAborted') {
        setSession((current) => {
          if (!current) return current;
          const next = { ...current, revision: event.revision };
          sessionRef.current = next;
          return next;
        });
      }
    };
    ws.onWSEvent('imageRadioStatus', onStatus);
    ws.onWSEvent('imageRxEvent', onRxEvent);
    ws.onWSEvent('sstvTxStatus', onTxStatus);
    ws.onWSEvent('sstvTxCommandResult', onTxCommandResult);
    service.subscribeImageRx(true);
    return () => {
      service.subscribeImageRx(false);
      ws.offWSEvent('imageRadioStatus', onStatus);
      ws.offWSEvent('imageRxEvent', onRxEvent);
      ws.offWSEvent('sstvTxStatus', onTxStatus);
      ws.offWSEvent('sstvTxCommandResult', onTxCommandResult);
    };
  }, [applyStatus, connection.state.isReady, connection.state.radioService, radioMode.engineMode]);

  useEffect(() => () => {
    for (const url of segmentSnapshotUrlsRef.current) URL.revokeObjectURL(url);
  }, []);

  const receiveValue = useMemo(() => ({
    session, pixelFormat, rowStore: rowStoreRef.current, boundaries, segmentSnapshots,
  }), [session, pixelFormat, boundaries, segmentSnapshots]);
  const controlValue = useMemo(() => ({
    status, txStatus, txCommandResult,
    modes, templates, refreshTemplates,
    configureReceive, saveCurrentPaper,
  }), [status, txStatus, txCommandResult, modes, templates, refreshTemplates, configureReceive, saveCurrentPaper]);

  return (
    <ImageRadioControlContext.Provider value={controlValue}>
      <ImageRadioReceiveContext.Provider value={receiveValue}>{children}</ImageRadioReceiveContext.Provider>
    </ImageRadioControlContext.Provider>
  );
}

export function useImageRadio(): ImageRadioContextValue {
  return { ...useImageRadioReceive(), ...useImageRadioControls() };
}

export function useImageRadioReceive(): ImageRadioReceiveContextValue {
  const value = useContext(ImageRadioReceiveContext);
  if (!value) throw new Error('useImageRadioReceive must be used inside ImageRadioProvider');
  return value;
}

export function useImageRadioControls(): ImageRadioControlContextValue {
  const value = useContext(ImageRadioControlContext);
  if (!value) throw new Error('useImageRadioControls must be used inside ImageRadioProvider');
  return value;
}
