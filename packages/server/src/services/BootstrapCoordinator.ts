import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'eventemitter3';
import type {
  BootstrapLifecycle,
  BootstrapPhaseId,
  BootstrapPhaseState,
  BootstrapPhaseStatus,
  BootstrapStatus,
} from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('BootstrapCoordinator');

const PHASE_DEFINITIONS: Array<Pick<BootstrapPhaseStatus, 'id' | 'label' | 'description' | 'retryable' | 'userVisible'>> = [
  {
    id: 'config-auth',
    label: '基础配置与登录',
    description: '读取配置文件并准备本地访问令牌',
    userVisible: false,
  },
  {
    id: 'core-http',
    label: '本地服务',
    description: '启动本地 HTTP/WebSocket 服务',
    userVisible: false,
  },
  {
    id: 'engine-bootstrap',
    label: '电台引擎',
    description: '装配数字电台引擎和运行时服务',
    userVisible: true,
  },
  {
    id: 'audio-device-discovery',
    label: '音频设备',
    description: '发现输入/输出音频设备',
    retryable: true,
    userVisible: true,
  },
  {
    id: 'logbook-prewarm',
    label: '日志本',
    description: '后台准备操作员日志本',
    retryable: true,
    userVisible: true,
  },
  {
    id: 'plugin-bootstrap',
    label: '插件',
    description: '加载插件和自动化策略',
    retryable: true,
    userVisible: true,
  },
  {
    id: 'ntp-initial-check',
    label: '时间校准',
    description: '启动时间校准服务',
    retryable: true,
    userVisible: true,
  },
  {
    id: 'active-profile-autostart',
    label: '自动启动电台',
    description: '按上次配置自动启动当前 Profile',
    retryable: true,
    userVisible: true,
  },
];

const TERMINAL_PHASE_STATES = new Set<BootstrapPhaseState>(['ready', 'skipped', 'warning', 'failed', 'timed_out']);

export class BootstrapCoordinator extends EventEmitter<{ statusChanged: (status: BootstrapStatus) => void }> {
  private static instance: BootstrapCoordinator | null = null;
  private bootSessionId = randomUUID();
  private startedAt = Date.now();
  private readonly phases = new Map<BootstrapPhaseId, BootstrapPhaseStatus>();
  private lifecycle: BootstrapLifecycle = 'booting';
  private completedAt: number | undefined;

  private constructor() {
    super();
    this.resetState();
  }

  private resetState(): void {
    this.bootSessionId = randomUUID();
    this.startedAt = Date.now();
    this.lifecycle = 'booting';
    this.completedAt = undefined;
    this.phases.clear();
    const now = Date.now();
    for (const phase of PHASE_DEFINITIONS) {
      this.phases.set(phase.id, {
        ...phase,
        state: 'pending',
        updatedAt: now,
      });
    }
  }

  static getInstance(): BootstrapCoordinator {
    if (!this.instance) {
      this.instance = new BootstrapCoordinator();
    }
    return this.instance;
  }

  getStatus(): BootstrapStatus {
    const now = Date.now();
    const phases = Array.from(this.phases.values());
    const summary = {
      total: phases.length,
      pending: phases.filter(phase => phase.state === 'pending').length,
      running: phases.filter(phase => phase.state === 'running').length,
      ready: phases.filter(phase => phase.state === 'ready').length,
      skipped: phases.filter(phase => phase.state === 'skipped').length,
      warning: phases.filter(phase => phase.state === 'warning').length,
      failed: phases.filter(phase => phase.state === 'failed').length,
      timedOut: phases.filter(phase => phase.state === 'timed_out').length,
    };
    return {
      bootSessionId: this.bootSessionId,
      lifecycle: this.lifecycle,
      startedAt: this.startedAt,
      updatedAt: now,
      completedAt: this.completedAt,
      durationMs: (this.completedAt ?? now) - this.startedAt,
      blockingReady: false,
      phases,
      summary,
    };
  }

  startPhase(id: BootstrapPhaseId, message?: string): void {
    this.updatePhase(id, 'running', { message, startedAt: Date.now(), completedAt: undefined });
  }

  completePhase(id: BootstrapPhaseId, message?: string): void {
    this.updatePhase(id, 'ready', { message, completedAt: Date.now() });
  }

  skipPhase(id: BootstrapPhaseId, message?: string): void {
    this.updatePhase(id, 'skipped', { message, completedAt: Date.now() });
  }

  warnPhase(id: BootstrapPhaseId, message?: string): void {
    this.updatePhase(id, 'warning', { message, completedAt: Date.now() });
  }

  timeoutPhase(id: BootstrapPhaseId, message?: string): void {
    this.updatePhase(id, 'timed_out', { message, completedAt: Date.now() });
  }

  failPhase(id: BootstrapPhaseId, message?: string): void {
    this.updatePhase(id, 'failed', { message, completedAt: Date.now() });
  }

  finalizeIfSettled(): void {
    this.recomputeLifecycle();
  }

  async runPhase<T>(
    id: BootstrapPhaseId,
    operation: () => Promise<T> | T,
    options: { timeoutMs?: number; pendingMessage?: string; successMessage?: string; failureMessage?: string } = {},
  ): Promise<T> {
    this.startPhase(id, options.pendingMessage);
    let timeoutHandle: NodeJS.Timeout | null = null;
    let timedOut = false;
    if (options.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        this.timeoutPhase(id, `${this.getPhaseLabel(id)} 准备时间较长，仍在后台继续`);
      }, options.timeoutMs);
    }
    try {
      const result = await operation();
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.completePhase(id, options.successMessage ?? (timedOut ? '后台准备已完成' : undefined));
      return result;
    } catch (error) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const message = options.failureMessage ?? (error instanceof Error ? error.message : String(error));
      this.failPhase(id, message);
      throw error;
    }
  }

  private updatePhase(
    id: BootstrapPhaseId,
    state: BootstrapPhaseState,
    patch: Partial<Pick<BootstrapPhaseStatus, 'message' | 'startedAt' | 'completedAt'>>,
  ): void {
    if (this.lifecycle === 'completed' || this.lifecycle === 'dismissed') {
      return;
    }

    const existing = this.phases.get(id);
    if (!existing) {
      logger.warn('Unknown bootstrap phase update ignored', { id, state });
      return;
    }

    const now = Date.now();
    const startedAt = patch.startedAt ?? existing.startedAt;
    const completedAt = patch.completedAt;
    this.phases.set(id, {
      ...existing,
      ...patch,
      state,
      startedAt,
      completedAt,
      durationMs: completedAt && startedAt ? completedAt - startedAt : undefined,
      updatedAt: now,
    });
    logger.info('bootstrap phase updated', { id, state, message: patch.message });
    this.recomputeLifecycle();
    this.emit('statusChanged', this.getStatus());
  }

  private recomputeLifecycle(): void {
    if (this.lifecycle === 'completed' || this.lifecycle === 'dismissed') {
      return;
    }

    const phases = Array.from(this.phases.values());
    const settled = phases.every(phase => TERMINAL_PHASE_STATES.has(phase.state));
    if (!settled) {
      this.lifecycle = phases.some(phase => phase.state === 'failed' || phase.state === 'timed_out' || phase.state === 'warning')
        ? 'degraded'
        : 'booting';
      this.completedAt = undefined;
      return;
    }

    const finishedAt = Date.now();
    if (phases.some(phase => phase.state === 'failed')) {
      this.lifecycle = 'failed';
      this.completedAt = finishedAt;
    } else if (phases.some(phase => phase.state === 'timed_out' || phase.state === 'warning')) {
      this.lifecycle = 'degraded';
      this.completedAt = finishedAt;
    } else {
      this.lifecycle = 'completed';
      this.completedAt = finishedAt;
    }
  }

  private getPhaseLabel(id: BootstrapPhaseId): string {
    return this.phases.get(id)?.label ?? id;
  }

  resetForTests(): void {
    this.resetState();
  }
}

export const bootstrapCoordinator = BootstrapCoordinator.getInstance();
