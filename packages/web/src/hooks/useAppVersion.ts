import { useEffect, useState } from 'react';

/**
 * Resolve the current app version.
 * Priority: Electron preload (window.electronAPI.app.getVersion) > Vite-injected env > 'unknown'.
 */
export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(() => {
    const injected = (import.meta.env as { PACKAGE_VERSION?: string }).PACKAGE_VERSION;
    return typeof injected === 'string' && injected.length > 0 ? injected : null;
  });

  useEffect(() => {
    const getVersion = (window as unknown as {
      electronAPI?: { app?: { getVersion?: () => Promise<string> } };
    }).electronAPI?.app?.getVersion;
    if (!getVersion) return;
    let cancelled = false;
    getVersion()
      .then((v) => {
        if (!cancelled && typeof v === 'string' && v.length > 0) setVersion(v);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return version;
}
