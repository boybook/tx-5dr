import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { RemoteStationProfile } from './stationProfiles.js';

/**
 * Owns the single remote-station gateway child process
 * (`packages/client-tools/src/remote-gateway.js`). At most one remote gateway
 * runs at a time; it is independent of the embedded station's own gateway.
 */

export interface RemoteGatewayPaths {
  readyFile: string;
  logFile: string;
}

export function buildRemoteGatewayEnv(
  profile: Pick<RemoteStationProfile, 'url' | 'gatewayPort' | 'tls'>,
  paths: RemoteGatewayPaths,
): Record<string, string> {
  const env: Record<string, string> = {
    PORT: String(profile.gatewayPort),
    TARGET: profile.url,
    TX5DR_REMOTE_GATEWAY_READY_FILE: paths.readyFile,
    TX5DR_REMOTE_GATEWAY_LOG_FILE: paths.logFile,
  };
  if (profile.tls?.fingerprint256 && profile.url.startsWith('https:')) {
    env.TX5DR_UPSTREAM_TLS_FINGERPRINT = profile.tls.fingerprint256;
  }
  return env;
}

export interface RemoteGatewayReadyState {
  pid: number;
  httpOk: boolean;
  httpPort: number | null;
  error: { code: string | null; message: string } | null;
}

export class RemoteGatewayStartError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'RemoteGatewayStartError';
  }
}

export interface RemoteGatewaySupervisorOptions {
  paths: RemoteGatewayPaths;
  spawn: (env: Record<string, string>) => ChildProcess;
  stop: (child: ChildProcess) => Promise<void>;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
}

function readReadyFile(file: string, pid: number | undefined): RemoteGatewayReadyState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RemoteGatewayReadyState>;
    if (typeof parsed.pid !== 'number' || parsed.pid !== pid) return null;
    return {
      pid: parsed.pid,
      httpOk: parsed.httpOk === true,
      httpPort: typeof parsed.httpPort === 'number' ? parsed.httpPort : null,
      error: parsed.error ?? null,
    };
  } catch {
    return null;
  }
}

export class RemoteGatewaySupervisor {
  private child: ChildProcess | null = null;
  private profileKey: string | null = null;

  constructor(private readonly options: RemoteGatewaySupervisorOptions) {}

  /** Key identifying the gateway configuration currently running, if any. */
  get runningKey(): string | null {
    return this.child && this.child.exitCode === null ? this.profileKey : null;
  }

  static keyFor(profile: Pick<RemoteStationProfile, 'id' | 'url' | 'gatewayPort' | 'tls'>): string {
    return [profile.id, profile.url, profile.gatewayPort, profile.tls?.fingerprint256 ?? ''].join('|');
  }

  /** Starts (or keeps) the gateway for the profile and resolves once it listens. */
  async ensure(profile: Pick<RemoteStationProfile, 'id' | 'url' | 'gatewayPort' | 'tls'>): Promise<void> {
    const key = RemoteGatewaySupervisor.keyFor(profile);
    if (this.runningKey === key) return;
    await this.stop();

    fs.mkdirSync(path.dirname(this.options.paths.readyFile), { recursive: true });
    fs.rmSync(this.options.paths.readyFile, { force: true });
    const child = this.options.spawn(buildRemoteGatewayEnv(profile, this.options.paths));
    this.child = child;
    this.profileKey = key;

    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 10_000);
    const interval = this.options.pollIntervalMs ?? 100;
    for (;;) {
      const ready = readReadyFile(this.options.paths.readyFile, child.pid);
      if (ready?.httpOk) return;
      if (ready && !ready.httpOk) {
        await this.stop();
        throw new RemoteGatewayStartError(ready.error?.message ?? 'remote gateway failed to start', ready.error?.code ?? 'GATEWAY_START_FAILED');
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        this.child = null;
        this.profileKey = null;
        throw new RemoteGatewayStartError('remote gateway exited during startup', 'GATEWAY_EXITED');
      }
      if (Date.now() > deadline) {
        await this.stop();
        throw new RemoteGatewayStartError('remote gateway did not become ready', 'GATEWAY_TIMEOUT');
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.profileKey = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      await this.options.stop(child);
    }
  }
}
