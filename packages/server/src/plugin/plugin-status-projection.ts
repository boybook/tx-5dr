import type { PluginStatus, PluginSystemSnapshot } from '@tx5dr/contracts';

/** Diagnostic text can contain station-wide details; only administrators receive it. */
export function projectPluginStatus(status: PluginStatus, includeDiagnostics: boolean): PluginStatus {
  if (includeDiagnostics) return status;
  const { autoDisableInfo: _info, lastError: _error, ...metadata } = status;
  return metadata;
}

export function projectPluginSnapshot(snapshot: PluginSystemSnapshot, includeDiagnostics: boolean): PluginSystemSnapshot {
  return { ...snapshot, plugins: snapshot.plugins.map((plugin) => projectPluginStatus(plugin, includeDiagnostics)) };
}
