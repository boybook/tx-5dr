import type { SyncStatus, SyncStatusProjection } from '@tx5dr/contracts';

const activeStates = new Set(['running', 'waiting', 'pausing']);
const terminalStates = new Set(['completed', 'partial_failure', 'failed']);
interface Preferences { launches: string[]; dismissed: string[]; notified: string[] }
/** Client presentation memory only. No provider state or execution policy is changed here. */
export class SyncPresentation {
  private preferences: Preferences;
  private baselines = new Set<string>();
  private recentLaunches = new Set<string>();
  constructor(private key: string, private storage?: Pick<Storage, 'getItem' | 'setItem'>) {
    this.preferences = { launches: [], dismissed: [], notified: [] };
    try {
      const raw = JSON.parse(storage?.getItem(key) ?? 'null') as Preferences | null;
      if (raw && ['launches', 'dismissed', 'notified'].every(field => Array.isArray(raw[field as keyof Preferences]) && raw[field as keyof Preferences].every(item => typeof item === 'string'))) this.preferences = raw;
    } catch { /* Storage restrictions do not prevent using synchronization. */ }
  }
  private save() {
    for (const field of ['launches', 'dismissed', 'notified'] as const) this.preferences[field] = this.preferences[field].slice(-200);
    try { this.storage?.setItem(this.key, JSON.stringify(this.preferences)); } catch { /* Best effort client preference. */ }
  }
  launched(provider: string, launchId: string) {
    const key = `${provider}:${launchId}`;
    this.preferences.launches.push(key); this.recentLaunches.add(key); this.save();
  }
  connectionLost() { this.baselines.clear(); this.recentLaunches.clear(); }
  private owned(provider: string, status: SyncStatus) { return !!status.launchId && this.preferences.launches.includes(`${provider}:${status.launchId}`); }
  dismiss(provider: string, status: SyncStatus) { this.preferences.dismissed.push(`${provider}:${status.operationId}`); this.save(); }
  observe(providers: Record<string, SyncStatusProjection>): Array<{ providerId: string; status: SyncStatus }> {
    const notices: Array<{ providerId: string; status: SyncStatus }> = [];
    for (const [providerId, projection] of Object.entries(providers)) {
      const status = projection.status;
      if (!projection.available) { this.baselines.delete(providerId); continue; }
      const baseline = this.baselines.has(providerId);
      this.baselines.add(providerId);
      if (!status || !terminalStates.has(status.state)) continue;
      const key = `${providerId}:${status.operationId}`;
      if (!baseline && !this.recentLaunches.has(`${providerId}:${status.launchId}`)) {
        this.preferences.notified.push(key); continue;
      }
      if (status.trigger === 'manual' && this.owned(providerId, status) && !this.preferences.notified.includes(key)) {
        this.preferences.notified.push(key); notices.push({ providerId, status });
      }
    }
    this.recentLaunches.clear(); this.save(); return notices;
  }
  view(providerId: string, projection?: SyncStatusProjection, connectionLost = false) {
    const status = projection?.status;
    const unavailable = connectionLost || !projection?.available;
    const manual = !!status && (status.trigger === 'manual' || status.resumable);
    const active = !!status && manual && activeStates.has(status.state);
    const owned = !!status && this.owned(providerId, status);
    // Rejected records will never retry on their own, so they need visible attention
    // even though the operation itself completed successfully.
    const issue = !!status && (status.failed > 0 || status.conflicts > 0 || status.rejected > 0
      || ['failed', 'partial_failure', 'interrupted'].includes(status.state) || !!status.automaticUpload?.failed);
    const dismissed = !!status && this.preferences.dismissed.includes(`${providerId}:${status.operationId}`);
    return { active: !unavailable && active, unavailable,
      badge: !!status && (issue || status.resumable && !active),
      showStrip: !!status && !dismissed && manual && (active || owned && (status.resumable || ['failed', 'partial_failure'].includes(status.state))),
    };
  }
}
export function createSyncPresentation(callsign: string): SyncPresentation {
  let storage: Storage | undefined;
  try { storage = window.sessionStorage; } catch { /* Optional browser storage. */ }
  return new SyncPresentation(`tx5dr:sync-ui:${callsign}`, storage);
}
