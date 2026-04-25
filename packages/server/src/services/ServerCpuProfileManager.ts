import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  PluginDistribution,
  ServerCpuProfileHistoryEntry,
  ServerCpuProfileSource,
  ServerCpuProfileState,
  ServerCpuProfileStatus,
} from '@tx5dr/contracts';
import { tx5drPaths } from '../utils/app-paths.js';
import { resolveRuntimeDistribution, type RuntimeDetectionOptions } from '../utils/runtime-distribution.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ServerCpuProfileManager');
const HISTORY_LIMIT = 10;
const DEFAULT_CPU_INTERVAL_US = 1000;

interface RuntimePaths {
  configDir: string;
  dataDir: string;
  logsDir: string;
  cacheDir: string;
}

interface PersistedCaptureState {
  version: 1;
  state: Exclude<ServerCpuProfileState, 'idle' | 'env-override'>;
  source: 'guided-capture';
  distribution: PluginDistribution;
  captureId: string;
  requestedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  outputDir: string;
  profilePath: string | null;
}

interface PersistedHistoryFile {
  version: 1;
  entries: ServerCpuProfileHistoryEntry[];
}

interface LaunchSession {
  source: Exclude<ServerCpuProfileSource, 'inactive'>;
  captureId: string | null;
  distribution: PluginDistribution;
  outputDir: string;
  hostOutputDirHint?: string;
  profilePath: string | null;
  hostProfilePathHint?: string;
}

export interface BuildServerNodeArgsResult {
  args: string[];
  launchSession: LaunchSession | null;
}

export interface CompleteLaunchSessionOptions {
  launchSession: LaunchSession | null;
  exitCode: number | null;
  signal: NodeJS.Signals | string | null;
}

interface ServerCpuProfileManagerOptions extends RuntimeDetectionOptions {
  env?: NodeJS.ProcessEnv;
  paths?: RuntimePaths;
}

function parsePositiveInt(rawValue: string | undefined): number | null {
  const parsed = Number.parseInt(rawValue ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function ensureCpuprofileFileName(fileName: string): string {
  return fileName.endsWith('.cpuprofile') ? fileName : `${fileName}.cpuprofile`;
}

function buildCaptureId(): string {
  return `cpu-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildProfileFileName(captureId: string): string {
  return `tx5dr-server-${captureId}.cpuprofile`;
}

function buildRecommendedStartAction(distribution: PluginDistribution): string {
  switch (distribution) {
    case 'electron':
      return 'Restart app to start capture';
    case 'docker':
      return 'docker restart tx5dr';
    case 'linux-service':
      return 'sudo tx5dr restart';
    default:
      return 'Restart the server normally to start capture';
  }
}

function buildRecommendedFinishAction(distribution: PluginDistribution): string {
  switch (distribution) {
    case 'electron':
      return 'Restart app to finish capture';
    case 'docker':
      return 'docker restart tx5dr';
    case 'linux-service':
      return 'sudo tx5dr restart';
    default:
      return 'Restart the server normally to finish capture';
  }
}

export class ServerCpuProfileManager {
  private readonly env: NodeJS.ProcessEnv;
  private readonly paths: RuntimePaths;
  private readonly distribution: PluginDistribution;
  private readonly outputDir: string;
  private readonly stateFilePath: string;
  private readonly historyFilePath: string;

  private constructor(options: {
    env: NodeJS.ProcessEnv;
    paths: RuntimePaths;
    distribution: PluginDistribution;
  }) {
    this.env = options.env;
    this.paths = options.paths;
    this.distribution = options.distribution;
    this.outputDir = path.join(this.paths.logsDir, 'diagnostics', 'cpu');
    this.stateFilePath = path.join(this.paths.dataDir, 'diagnostics', 'cpu-profile-state.json');
    this.historyFilePath = path.join(this.paths.dataDir, 'diagnostics', 'cpu-profile-history.json');
  }

  static async create(options: ServerCpuProfileManagerOptions = {}): Promise<ServerCpuProfileManager> {
    const env = options.env ?? process.env;
    const paths = options.paths ?? await ServerCpuProfileManager.resolvePaths();
    const distribution = resolveRuntimeDistribution(paths.dataDir, {
      env,
      hasDockerEnvFile: options.hasDockerEnvFile,
    });

    return new ServerCpuProfileManager({ env, paths, distribution });
  }

  private static async resolvePaths(): Promise<RuntimePaths> {
    const [configDir, dataDir, logsDir, cacheDir] = await Promise.all([
      tx5drPaths.getConfigDir(),
      tx5drPaths.getDataDir(),
      tx5drPaths.getLogsDir(),
      tx5drPaths.getCacheDir(),
    ]);

    return { configDir, dataDir, logsDir, cacheDir };
  }

  private getHostOutputDirHint(outputDir = this.outputDir): string | undefined {
    if (this.distribution === 'docker' && outputDir === '/app/data/logs/diagnostics/cpu') {
      return './data/logs/diagnostics/cpu';
    }

    return undefined;
  }

  private getHostProfilePathHint(profilePath: string | null, outputDir = this.outputDir): string | undefined {
    if (!profilePath) {
      return undefined;
    }

    const hostOutputDirHint = this.getHostOutputDirHint(outputDir);
    if (!hostOutputDirHint || !profilePath.startsWith(outputDir)) {
      return undefined;
    }

    return `${hostOutputDirHint}${profilePath.slice(outputDir.length)}`;
  }

  private getDefaultStatus(state: ServerCpuProfileState = 'idle'): ServerCpuProfileStatus {
    return {
      state,
      source: state === 'env-override' ? 'env-override' : 'inactive',
      distribution: this.distribution,
      outputDir: this.outputDir,
      hostOutputDirHint: this.getHostOutputDirHint(),
      captureId: null,
      requestedAt: null,
      startedAt: null,
      completedAt: null,
      profilePath: null,
      hostProfilePathHint: undefined,
      recommendedStartAction: buildRecommendedStartAction(this.distribution),
      recommendedFinishAction: buildRecommendedFinishAction(this.distribution),
    };
  }

  private getEnvOverride(): {
    enabled: boolean;
    outputDir: string;
    profilePath: string | null;
    args: string[];
  } {
    if (this.env.TX5DR_SERVER_CPU_PROFILE !== '1') {
      return { enabled: false, outputDir: this.outputDir, profilePath: null, args: [] };
    }

    const outputDir = this.env.TX5DR_SERVER_CPU_PROFILE_DIR?.trim() || this.outputDir;
    const requestedName = this.env.TX5DR_SERVER_CPU_PROFILE_NAME?.trim();
    const fileName = requestedName ? ensureCpuprofileFileName(requestedName) : null;
    const interval = parsePositiveInt(this.env.TX5DR_SERVER_CPU_PROFILE_INTERVAL);
    const args = [
      '--cpu-prof',
      `--cpu-prof-dir=${outputDir}`,
      ...(fileName ? [`--cpu-prof-name=${fileName}`] : []),
      ...(interval ? [`--cpu-prof-interval=${interval}`] : [`--cpu-prof-interval=${DEFAULT_CPU_INTERVAL_US}`]),
    ];

    return {
      enabled: true,
      outputDir,
      profilePath: fileName ? path.join(outputDir, fileName) : null,
      args,
    };
  }

  private async ensureRuntimeDirs(): Promise<void> {
    await fs.mkdir(this.outputDir, { recursive: true });
    await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
  }

  private async readState(): Promise<PersistedCaptureState | null> {
    try {
      const raw = await fs.readFile(this.stateFilePath, 'utf-8');
      return JSON.parse(raw) as PersistedCaptureState;
    } catch {
      return null;
    }
  }

  private async writeState(state: PersistedCaptureState | null): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
    if (!state) {
      await fs.rm(this.stateFilePath, { force: true });
      return;
    }

    await fs.writeFile(this.stateFilePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  }

  private async readHistory(): Promise<PersistedHistoryFile> {
    try {
      const raw = await fs.readFile(this.historyFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedHistoryFile;
      return {
        version: 1,
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      };
    } catch {
      return {
        version: 1,
        entries: [],
      };
    }
  }

  private async appendHistory(entry: ServerCpuProfileHistoryEntry): Promise<void> {
    const history = await this.readHistory();
    history.entries = [entry, ...history.entries].slice(0, HISTORY_LIMIT);
    await fs.mkdir(path.dirname(this.historyFilePath), { recursive: true });
    await fs.writeFile(this.historyFilePath, `${JSON.stringify(history, null, 2)}\n`, 'utf-8');
  }

  private toStatus(state: PersistedCaptureState): ServerCpuProfileStatus {
    return {
      state: state.state,
      source: state.source,
      distribution: state.distribution,
      outputDir: state.outputDir,
      hostOutputDirHint: this.getHostOutputDirHint(state.outputDir),
      captureId: state.captureId,
      requestedAt: state.requestedAt,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      profilePath: state.profilePath,
      hostProfilePathHint: this.getHostProfilePathHint(state.profilePath, state.outputDir),
      recommendedStartAction: buildRecommendedStartAction(state.distribution),
      recommendedFinishAction: buildRecommendedFinishAction(state.distribution),
    };
  }

  async getStatus(): Promise<ServerCpuProfileStatus> {
    await this.ensureRuntimeDirs();

    const envOverride = this.getEnvOverride();
    if (envOverride.enabled) {
      return {
        ...this.getDefaultStatus('env-override'),
        source: 'env-override',
        outputDir: envOverride.outputDir,
        hostOutputDirHint: this.getHostOutputDirHint(envOverride.outputDir),
        profilePath: envOverride.profilePath,
        hostProfilePathHint: this.getHostProfilePathHint(envOverride.profilePath, envOverride.outputDir),
      };
    }

    const state = await this.readState();
    return state ? this.toStatus(state) : this.getDefaultStatus();
  }

  async armGuidedCapture(): Promise<ServerCpuProfileStatus> {
    await this.ensureRuntimeDirs();

    const envOverride = this.getEnvOverride();
    if (envOverride.enabled) {
      return this.getStatus();
    }

    const captureId = buildCaptureId();
    const outputDir = this.outputDir;
    const state: PersistedCaptureState = {
      version: 1,
      state: 'armed',
      source: 'guided-capture',
      distribution: this.distribution,
      captureId,
      requestedAt: Date.now(),
      startedAt: null,
      completedAt: null,
      outputDir,
      profilePath: path.join(outputDir, buildProfileFileName(captureId)),
    };
    await this.writeState(state);
    return this.toStatus(state);
  }

  async cancelGuidedCapture(): Promise<ServerCpuProfileStatus> {
    const envOverride = this.getEnvOverride();
    if (envOverride.enabled) {
      return this.getStatus();
    }

    const state = await this.readState();
    if (state?.state === 'armed') {
      await this.writeState(null);
      return this.getDefaultStatus();
    }

    return state ? this.toStatus(state) : this.getDefaultStatus();
  }

  async dismissResult(): Promise<ServerCpuProfileStatus> {
    const envOverride = this.getEnvOverride();
    if (envOverride.enabled) {
      return this.getStatus();
    }

    const state = await this.readState();
    if (state && (state.state === 'completed' || state.state === 'interrupted' || state.state === 'missing')) {
      await this.writeState(null);
      return this.getDefaultStatus();
    }

    return state ? this.toStatus(state) : this.getDefaultStatus();
  }

  async buildServerNodeArgs(): Promise<BuildServerNodeArgsResult> {
    await this.ensureRuntimeDirs();

    const envOverride = this.getEnvOverride();
    if (envOverride.enabled) {
      await fs.mkdir(envOverride.outputDir, { recursive: true });
      return {
        args: envOverride.args,
        launchSession: {
          source: 'env-override',
          captureId: null,
          distribution: this.distribution,
          outputDir: envOverride.outputDir,
          hostOutputDirHint: this.getHostOutputDirHint(envOverride.outputDir),
          profilePath: envOverride.profilePath,
          hostProfilePathHint: this.getHostProfilePathHint(envOverride.profilePath, envOverride.outputDir),
        },
      };
    }

    const state = await this.readState();
    if (!state) {
      return { args: [], launchSession: null };
    }

    if (state.state === 'running') {
      const interrupted: PersistedCaptureState = {
        ...state,
        state: 'interrupted',
        completedAt: Date.now(),
      };
      await this.writeState(interrupted);
      await this.appendHistory(this.toStatus(interrupted) as ServerCpuProfileHistoryEntry);
      return { args: [], launchSession: null };
    }

    if (state.state !== 'armed') {
      return { args: [], launchSession: null };
    }

    const nextState: PersistedCaptureState = {
      ...state,
      state: 'running',
      startedAt: Date.now(),
      completedAt: null,
      profilePath: state.profilePath || path.join(state.outputDir, buildProfileFileName(state.captureId)),
    };
    await fs.mkdir(nextState.outputDir, { recursive: true });
    await this.writeState(nextState);

    return {
      args: [
        '--cpu-prof',
        `--cpu-prof-dir=${nextState.outputDir}`,
        `--cpu-prof-name=${path.basename(nextState.profilePath!)}`,
        `--cpu-prof-interval=${DEFAULT_CPU_INTERVAL_US}`,
      ],
      launchSession: {
        source: 'guided-capture',
        captureId: nextState.captureId,
        distribution: nextState.distribution,
        outputDir: nextState.outputDir,
        hostOutputDirHint: this.getHostOutputDirHint(nextState.outputDir),
        profilePath: nextState.profilePath,
        hostProfilePathHint: this.getHostProfilePathHint(nextState.profilePath, nextState.outputDir),
      },
    };
  }

  async completeLaunchSession(options: CompleteLaunchSessionOptions): Promise<void> {
    const launchSession = options.launchSession;
    if (!launchSession) {
      return;
    }

    if (launchSession.source !== 'guided-capture') {
      return;
    }

    const state = await this.readState();
    if (!state || state.state !== 'running' || state.captureId !== launchSession.captureId) {
      return;
    }

    const profilePath = launchSession.profilePath;
    const hasProfile = profilePath ? await fs.access(profilePath).then(() => true).catch(() => false) : false;

    const nextState: PersistedCaptureState = {
      ...state,
      state: hasProfile
        ? 'completed'
        : options.exitCode === 0 && !options.signal
          ? 'missing'
          : 'interrupted',
      completedAt: Date.now(),
      profilePath,
    };

    await this.writeState(nextState);
    await this.appendHistory(this.toStatus(nextState) as ServerCpuProfileHistoryEntry);

    logger.info('server cpu profile session completed', {
      captureId: state.captureId,
      state: nextState.state,
      profilePath,
      exitCode: options.exitCode,
      signal: options.signal,
    });
  }
}

