import { useEffect, useState } from 'react';

export interface BuildInfo {
  channel: 'release' | 'nightly';
  version: string;
  commit: string;
  commitShort: string;
  tag: string;
  buildTimestamp: string;
}

/**
 * Resolve build info exposed by Electron preload (channel / commit / timestamp).
 * Returns null when running in browser mode or before the IPC resolves.
 */
export function useBuildInfo(): BuildInfo | null {
  const [info, setInfo] = useState<BuildInfo | null>(null);

  useEffect(() => {
    const getBuildInfo = (window as unknown as {
      electronAPI?: { app?: { getBuildInfo?: () => Promise<BuildInfo> } };
    }).electronAPI?.app?.getBuildInfo;
    if (!getBuildInfo) return;
    let cancelled = false;
    getBuildInfo()
      .then((value) => {
        if (!cancelled && value && typeof value === 'object') setInfo(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return info;
}

/**
 * Whether the build info represents an actual packaged build (CI overwrites
 * the generated buildInfo.ts; dev runs leave the placeholder "development").
 */
export function isPackagedBuild(info: BuildInfo | null): boolean {
  return !!info && info.commitShort !== 'development' && info.commit !== 'development';
}
