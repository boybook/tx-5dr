/**
 * Open an external URL.
 * In Electron we route through shell.openExternal (system default browser);
 * in plain browsers we use window.open with a noopener fallback.
 */
export function openExternal(url: string): void {
  if (!url) return;
  const api = (window as unknown as {
    electronAPI?: { shell?: { openExternal?: (u: string) => Promise<void> } };
  }).electronAPI?.shell?.openExternal;
  if (api) {
    void api(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
