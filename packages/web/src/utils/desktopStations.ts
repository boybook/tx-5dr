import { useEffect, useState } from 'react';
import {
  DesktopCurrentStationSchema,
  DesktopStationProbeResultSchema,
  DesktopStationsStateSchema,
  type DesktopCurrentStation,
  type DesktopStationProbeResult,
  type DesktopStationsState,
} from '@tx5dr/contracts';
import { createLogger } from './logger';

const logger = createLogger('DesktopStations');

/**
 * Access to the desktop shell's station manager bridge. Values crossing the
 * process boundary are decoded with the contracts schemas before use.
 */

function stationsBridge() {
  return typeof window === 'undefined' ? undefined : window.electronAPI?.stations;
}

/** Strips Electron's IPC wrapper from an error message. */
export function describeBridgeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export function canManageStations(): boolean {
  return typeof stationsBridge()?.subscribe === 'function';
}

export async function openStationManager(): Promise<void> {
  await stationsBridge()?.openManager?.();
}

export async function probeStationAddress(url: string): Promise<DesktopStationProbeResult> {
  const probe = stationsBridge()?.probe;
  if (!probe) throw new Error('station_management_unavailable');
  return DesktopStationProbeResultSchema.parse(await probe(url));
}

export async function saveStation(input: { id?: string; label: string; url: string; trustFingerprint256?: string | null }): Promise<string> {
  const save = stationsBridge()?.save;
  if (!save) throw new Error('station_management_unavailable');
  return (await save(input)).id;
}

export async function removeStation(id: string): Promise<void> {
  await stationsBridge()?.remove?.(id);
}

export async function openStation(id: string): Promise<void> {
  await stationsBridge()?.connect?.(id);
}

export async function trustStationCertificate(id: string, fingerprint256: string): Promise<void> {
  await stationsBridge()?.trustCertificate?.(id, fingerprint256);
}

/** Live station manager state; null until the first snapshot arrives. */
export function useDesktopStations(): DesktopStationsState | null {
  const [state, setState] = useState<DesktopStationsState | null>(null);
  useEffect(() => {
    const subscribe = stationsBridge()?.subscribe;
    if (!subscribe) return undefined;
    let dispose: (() => Promise<void>) | null = null;
    let cancelled = false;
    subscribe((next) => {
      const parsed = DesktopStationsStateSchema.safeParse(next);
      if (parsed.success) setState(parsed.data);
      else logger.warn('ignored invalid station state', parsed.error.issues);
    }).then((unsubscribe) => {
      if (cancelled) void unsubscribe();
      else dispose = unsubscribe;
    }).catch(error => logger.warn('station state subscription failed', error));
    return () => {
      cancelled = true;
      if (dispose) void dispose();
    };
  }, []);
  return state;
}

/** The desktop station this page belongs to, or null outside the desktop shell. */
export function useCurrentDesktopStation(): DesktopCurrentStation | null {
  const [station, setStation] = useState<DesktopCurrentStation | null>(null);
  useEffect(() => {
    const getCurrent = stationsBridge()?.getCurrent;
    if (!getCurrent) return;
    let cancelled = false;
    getCurrent()
      .then((value) => {
        const parsed = DesktopCurrentStationSchema.safeParse(value);
        if (!cancelled && parsed.success) setStation(parsed.data);
      })
      .catch(error => logger.debug('current station unavailable', error));
    return () => { cancelled = true; };
  }, []);
  return station;
}
