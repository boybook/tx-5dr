import type { PluginStatus, PluginSystemSnapshot } from '@tx5dr/contracts';

/** Diagnostic text can contain station-wide details; only administrators receive it. */
export function projectPluginStatus(status: PluginStatus, includeDiagnostics: boolean): PluginStatus {
  if (includeDiagnostics) return status;
  const { autoDisableInfo: _info, lastError: _error, ...metadata } = status;
  return metadata;
}

export function projectPluginSnapshot(snapshot: PluginSystemSnapshot, includeDiagnostics: boolean): PluginSystemSnapshot {
  const projected = {
    ...snapshot,
    plugins: snapshot.plugins.map((plugin) => projectPluginStatus(plugin, includeDiagnostics)),
  };
  if (!includeDiagnostics && snapshot.loadFailures) {
    projected.loadFailures = snapshot.loadFailures.map(({ message: _message, ...summary }) => summary);
  }
  return projected;
}
