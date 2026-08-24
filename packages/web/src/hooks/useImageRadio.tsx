import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { api } from '@tx5dr/core';
import type { ImageArtifact, ImagePaperBoundary, ImageRadioStatus, ImageReceiveProfile, ImageRxEvent, ImageSessionSummary, ImageSstvModeInfo, ImageTemplate, SstvTxStatus } from '@tx5dr/contracts';

import { useConnection, useRadioModeState } from '../store/radioStore';

interface ImageRadioContextValue {
  status: ImageRadioStatus | null;
  txStatus: SstvTxStatus | null;
  session: ImageSessionSummary | null;
  pixelFormat: 'rgb8' | 'gray8';
  rowsRef: React.MutableRefObject<Map<number, { width: number; pixels: Uint8Array }>>;
  boundaries: ImagePaperBoundary[];
  segmentSnapshots: Map<string, string>;
  renderRevision: number;
  modes: ImageSstvModeInfo[];
  artifacts: ImageArtifact[];
  templates: ImageTemplate[];
  configureReceive: (profile: ImageReceiveProfile) => Promise<void>;
  saveCurrentPaper: (operatorId: string) => Promise<void>;
  refreshArtifacts: () => Promise<void>;
  refreshTemplates: (operatorId?: string) => Promise<void>;
}

const ImageRadioContext = createContext<ImageRadioContextValue | null>(null);

export function ImageRadioProvider({ children }: { children: ReactNode }) {
  const connection = useConnection();
  const radioMode = useRadioModeState();
  const [status, setStatus] = useState<ImageRadioStatus | null>(null);
  const [txStatus, setTxStatus] = useState<SstvTxStatus | null>(null);
  const [session, setSession] = useState<ImageSessionSummary | null>(null);
  const [pixelFormat, setPixelFormat] = useState<'rgb8' | 'gray8'>('rgb8');
  const [renderRevision, setRenderRevision] = useState(0);
  const [modes, setModes] = useState<ImageSstvModeInfo[]>([]);
  const [artifacts, setArtifacts] = useState<ImageArtifact[]>([]);
  const [templates, setTemplates] = useState<ImageTemplate[]>([]);
  const [boundaries, setBoundaries] = useState<ImagePaperBoundary[]>([]);
  const [segmentSnapshots, setSegmentSnapshots] = useState(new Map<string, string>());
  const sessionRef = useRef<ImageSessionSummary | null>(null);
  const rowsRef = useRef(new Map<number, { width: number; pixels: Uint8Array }>());
  const rafRef = useRef<number | null>(null);
  const segmentSnapshotUrlsRef = useRef(new Set<string>());

  const scheduleRender = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setRenderRevision((value) => value + 1);
    });
  }, []);

  const applyStatus = useCallback((value: ImageRadioStatus | null) => {
    setStatus(value);
    const current = value?.currentSession;
    if (!current) return;
    if (sessionRef.current?.sessionId !== current.sessionId) {
      rowsRef.current.clear();
      setBoundaries([]);
      for (const url of segmentSnapshotUrlsRef.current) URL.revokeObjectURL(url);
      segmentSnapshotUrlsRef.current.clear();
      setSegmentSnapshots(new Map());
      setPixelFormat(current.family === 'fax' ? 'gray8' : 'rgb8');
    }
    sessionRef.current = current;
    setSession(current);
    scheduleRender();
  }, [scheduleRender]);

  const refreshArtifacts = useCallback(async () => {
    if (radioMode.engineMode !== 'image') return;
    const family = radioMode.currentMode?.name === 'FAX' ? 'fax' : 'sstv';
    const result = await api.getImageArtifacts({ family, direction: 'rx', limit: 50 });
    if (result.success) setArtifacts(result.artifacts);
  }, [radioMode.currentMode?.name, radioMode.engineMode]);

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
    await refreshArtifacts();
  }, [refreshArtifacts]);

  useEffect(() => {
    if (radioMode.engineMode !== 'image') return;
    void api.getImageRadioStatus().then((result) => applyStatus(result.status));
    void api.getImageRadioModes().then((result) => setModes(result.modes));
    void refreshArtifacts();
  }, [applyStatus, radioMode.engineMode, refreshArtifacts]);

  useEffect(() => {
    const service = connection.state.radioService;
    if (!service || !connection.state.isReady || radioMode.engineMode !== 'image') return;
    const ws = service.wsClientInstance;
    const onStatus = (value: ImageRadioStatus) => applyStatus(value);
    const onTxStatus = (value: SstvTxStatus) => setTxStatus(value);
    const onRxEvent = (event: ImageRxEvent) => {
      if (event.type === 'paperStarted') {
        rowsRef.current.clear();
        sessionRef.current = event.session;
        setSession(event.session);
        setPixelFormat(event.pixelFormat);
        setBoundaries([]);
        scheduleRender();
      } else if (event.type === 'boundary') {
        if (event.boundary.kind === 'truncated') {
          for (const line of rowsRef.current.keys()) if (line < event.boundary.lineIndex) rowsRef.current.delete(line);
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
        scheduleRender();
      } else if (event.type === 'rows') {
        for (const row of event.rows) rowsRef.current.set(row.rowIndex, { width: row.width, pixels: Uint8Array.from(atob(row.dataBase64), (char) => char.charCodeAt(0)) });
        setSession((current) => {
          if (!current) return current;
          const next = { ...current, revision: event.revision, receivedLines: Math.max(current.receivedLines, ...event.rows.map((row) => row.rowIndex + 1)) };
          sessionRef.current = next;
          return next;
        });
        scheduleRender();
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
          scheduleRender();
        }).catch(() => undefined);
      } else if (event.type === 'imageCompleted' || event.type === 'captureSaved') {
        void refreshArtifacts();
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
    service.subscribeImageRx(true);
    return () => {
      service.subscribeImageRx(false);
      ws.offWSEvent('imageRadioStatus', onStatus);
      ws.offWSEvent('imageRxEvent', onRxEvent);
      ws.offWSEvent('sstvTxStatus', onTxStatus);
    };
  }, [applyStatus, connection.state.isReady, connection.state.radioService, radioMode.engineMode, refreshArtifacts, scheduleRender]);

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    for (const url of segmentSnapshotUrlsRef.current) URL.revokeObjectURL(url);
  }, []);

  const value = useMemo(() => ({
    status, txStatus, session, pixelFormat, rowsRef, boundaries, segmentSnapshots, renderRevision,
    modes, artifacts, templates, refreshArtifacts, refreshTemplates,
    configureReceive, saveCurrentPaper,
  }), [status, txStatus, session, pixelFormat, boundaries, segmentSnapshots, renderRevision, modes, artifacts, templates, refreshArtifacts, refreshTemplates, configureReceive, saveCurrentPaper]);

  return <ImageRadioContext.Provider value={value}>{children}</ImageRadioContext.Provider>;
}

export function useImageRadio(): ImageRadioContextValue {
  const value = useContext(ImageRadioContext);
  if (!value) throw new Error('useImageRadio must be used inside ImageRadioProvider');
  return value;
}
