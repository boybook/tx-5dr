/**
 * ResourceManager - 资源生命周期管理器
 *
 * 负责管理系统资源的启动、停止和依赖关系
 * 提供原子性保证：
 * 1. 按优先级和依赖关系顺序启动资源
 * 2. 启动失败时自动回滚已启动的资源
 * 3. 停止时按逆序清理资源
 * 4. 可选资源失败不影响其他资源
 * 5. 检测循环依赖
 */

import { RadioError, RadioErrorCode } from './errors/RadioError.js';
import { createLogger } from './logger.js';

const logger = createLogger('ResourceManager');

/**
 * 资源接口
 */
export interface IResource {
  /**
   * 资源名称（唯一标识）
   */
  name: string;

  /**
   * 启动资源
   */
  start(): Promise<void> | void;

  /**
   * 停止资源
   */
  stop(): Promise<void> | void;

  /**
   * 资源是否正在运行
   */
  isRunning(): boolean;
}

/**
 * 资源配置
 */
export interface ResourceConfig {
  /**
   * 资源实例
   */
  resource: IResource;

  /**
   * 优先级（数字越小优先级越高，先启动）
   * @default 100
   */
  priority?: number;

  /**
   * 依赖的资源名称列表
   * 这些资源必须先于当前资源启动
   */
  dependencies?: string[];

  /**
   * 是否为可选资源
   * 如果为 true，启动失败不会导致整体失败
   * @default false
   */
  optional?: boolean;

  /**
   * 启动超时（毫秒）
   * @default 30000 (30秒)
   */
  startTimeout?: number;

  /**
   * 停止超时（毫秒）
   * @default 10000 (10秒)
   */
  stopTimeout?: number;
}

/**
 * 简化的资源配置（函数形式）
 */
export interface SimplifiedResourceConfig {
  /**
   * 资源名称（唯一标识）
   */
  name: string;

  /**
   * 启动资源的函数
   */
  start: () => Promise<void> | void;

  /**
   * 停止资源的函数
   */
  stop: () => Promise<void> | void;

  /**
   * 优先级（数字越小优先级越高，先启动）
   * @default 100
   */
  priority?: number;

  /**
   * 依赖的资源名称列表
   * 这些资源必须先于当前资源启动
   */
  dependencies?: string[];

  /**
   * 是否为可选资源
   * 如果为 true，启动失败不会导致整体失败
   * @default false
   */
  optional?: boolean;

  /**
   * 启动超时（毫秒）
   * @default 30000 (30秒)
   */
  startTimeout?: number;

  /**
   * 停止超时（毫秒）
   * @default 10000 (10秒)
   */
  stopTimeout?: number;
}

/**
 * 资源状态
 */
export enum ResourceState {
  IDLE = 'idle',
  STARTING = 'starting',
  RUNNING = 'running',
  STOPPING = 'stopping',
  STOPPED = 'stopped',
  ERROR = 'error',
}

/**
 * 内部资源元数据
 */
interface ResourceMetadata extends ResourceConfig {
  state: ResourceState;
  error?: Error;
  startedAt?: number;
  stoppedAt?: number;
}

/**
 * ResourceManager 类
 *
 * 使用示例：
 *
 * ```typescript
 * const manager = new ResourceManager();
 *
 * // 注册资源
 * manager.register({
 *   resource: audioStream,
 *   priority: 1,
 * });
 *
 * manager.register({
 *   resource: radioManager,
 *   priority: 2,
 *   dependencies: ['audioStream'],
 * });
 *
 * manager.register({
 *   resource: spectrumAnalyzer,
 *   priority: 3,
 *   dependencies: ['audioStream'],
 *   optional: true,
 * });
 *
 * // 启动所有资源
 * try {
 *   await manager.startAll();
 * } catch (error) {
 *   // 启动失败，已自动回滚
 * }
 *
 * // 停止所有资源
 * await manager.stopAll();
 * ```
 */
export class ResourceManager {
  private resources: Map<string, ResourceMetadata> = new Map();
  private startedResources: string[] = [];

  /**
   * 注册资源（IResource形式）
   */
  // eslint-disable-next-line no-dupe-class-members
  register(config: ResourceConfig): void;
  /**
   * 注册资源（简化的函数形式）
   */
  // eslint-disable-next-line no-dupe-class-members
  register(config: SimplifiedResourceConfig): void;
  /**
   * 注册资源（实现）
   */
  // eslint-disable-next-line no-dupe-class-members
  register(config: ResourceConfig | SimplifiedResourceConfig): void {
    let resource: IResource;
    let name: string;

    // 判断是哪种形式的配置
    if ('resource' in config) {
      // IResource 形式
      resource = config.resource;
      name = resource.name;
    } else {
      // 简化的函数形式，创建适配器
      name = config.name;
      let isRunningState = false;
      resource = {
        name: config.name,
        start: async () => {
          await config.start();
          isRunningState = true;
        },
        stop: async () => {
          await config.stop();
          isRunningState = false;
        },
        isRunning: () => isRunningState,
      };
    }

    const { priority = 100, dependencies = [], optional = false } = config;

    if (this.resources.has(name)) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_OPERATION,
        message: `Resource "${name}" is already registered`,
      });
    }

    this.resources.set(name, {
      resource,
      priority,
      dependencies,
      optional,
      startTimeout: config.startTimeout,
      stopTimeout: config.stopTimeout,
      state: ResourceState.IDLE,
    });

    logger.info(`Resource registered: ${name} (priority: ${priority}, optional: ${optional})`);
  }

  /**
   * 取消注册资源
   */
  unregister(name: string): void {
    const metadata = this.resources.get(name);
    if (!metadata) {
      return;
    }

    if (metadata.state === ResourceState.RUNNING) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_STATE,
        message: `Cannot unregister running resource "${name}"`,
      });
    }

    this.resources.delete(name);
    logger.info(`Resource unregistered: ${name}`);
  }

  /**
   * 启动所有资源
   * 按优先级和依赖关系顺序启动
   * 如果任何必需资源启动失败，会自动回滚已启动的资源
   */
  async startAll(): Promise<void> {
    logger.info('Starting all resources...');

    // 检测循环依赖
    this.detectCircularDependencies();

    // 拓扑排序
    const startOrder = this.topologicalSort();

    logger.info(`Start order: ${startOrder.join(' -> ')}`);

    this.startedResources = [];

    try {
      for (const name of startOrder) {
        await this.startResource(name);
      }

      logger.info(`All resources started successfully (${this.startedResources.length})`);
    } catch (error) {
      logger.error('Resource startup failed, rolling back...');
      await this.rollback();
      throw error;
    }
  }

  /**
   * 停止所有资源
   * 按启动的逆序停止
   */
  async stopAll(): Promise<void> {
    logger.info('Stopping all resources...');

    // 按逆序停止
    const stopOrder = [...this.startedResources].reverse();

    logger.info(`Stop order: ${stopOrder.join(' -> ')}`);

    const errors: Error[] = [];

    for (const name of stopOrder) {
      try {
        await this.stopResource(name);
      } catch (error) {
        logger.error(`Failed to stop resource "${name}":`, error);
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    this.startedResources = [];

    if (errors.length > 0) {
      logger.warn(`Stop complete with ${errors.length} resource failure(s)`);
    } else {
      logger.info('All resources stopped successfully');
    }
  }

  /**
   * 获取资源状态
   */
  getState(name: string): ResourceState | undefined {
    return this.resources.get(name)?.state;
  }

  /**
   * 获取所有资源状态
   */
  getAllStates(): Map<string, ResourceState> {
    const states = new Map<string, ResourceState>();
    for (const [name, metadata] of this.resources) {
      states.set(name, metadata.state);
    }
    return states;
  }

  /**
   * 清空所有资源注册
   */
  clear(): void {
    if (this.startedResources.length > 0) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_STATE,
        message: 'Cannot clear: some resources are still running',
      });
    }

    this.resources.clear();
    logger.info('All resource registrations cleared');
  }

  /**
   * 启动单个资源
   */
  private async startResource(name: string): Promise<void> {
    const metadata = this.resources.get(name);
    if (!metadata) {
      throw new RadioError({
        code: RadioErrorCode.RESOURCE_UNAVAILABLE,
        message: `Resource "${name}" not found`,
      });
    }

    const { resource, optional, startTimeout = 30000 } = metadata;

    // 检查依赖是否已启动
    for (const depName of metadata.dependencies || []) {
      const depMetadata = this.resources.get(depName);
      if (!depMetadata || depMetadata.state !== ResourceState.RUNNING) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_STATE,
          message: `Dependency "${depName}" of resource "${name}" is not running`,
        });
      }
    }

    // 如果已经在运行，跳过
    if (metadata.state === ResourceState.RUNNING) {
      logger.debug(`Resource "${name}" already running, skipping`);
      return;
    }

    metadata.state = ResourceState.STARTING;
    logger.info(`Starting resource: ${name}`);

    try {
      // 使用超时保护
      await this.withTimeout(resource.start(), startTimeout, `Starting resource "${name}"`);

      metadata.state = ResourceState.RUNNING;
      metadata.startedAt = Date.now();
      this.startedResources.push(name);

      logger.info(`Resource "${name}" started successfully`);
    } catch (error) {
      metadata.state = ResourceState.ERROR;
      metadata.error = error instanceof Error ? error : new Error(String(error));

      if (optional) {
        logger.warn(`Optional resource "${name}" failed to start (ignored):`, error);
        // 可选资源失败不抛出异常
        return;
      }

      logger.error(`Resource "${name}" failed to start:`, error);
      throw RadioError.from(error, RadioErrorCode.RESOURCE_UNAVAILABLE);
    }
  }

  /**
   * 停止单个资源
   */
  private async stopResource(name: string): Promise<void> {
    const metadata = this.resources.get(name);
    if (!metadata) {
      return;
    }

    const { resource, stopTimeout = 10000 } = metadata;

    // 如果已经停止，跳过
    if (metadata.state === ResourceState.STOPPED || metadata.state === ResourceState.IDLE) {
      return;
    }

    metadata.state = ResourceState.STOPPING;
    logger.info(`Stopping resource: ${name}`);

    try {
      await this.withTimeout(resource.stop(), stopTimeout, `Stopping resource "${name}"`);

      metadata.state = ResourceState.STOPPED;
      metadata.stoppedAt = Date.now();

      logger.info(`Resource "${name}" stopped successfully`);
    } catch (error) {
      metadata.state = ResourceState.ERROR;
      metadata.error = error instanceof Error ? error : new Error(String(error));

      logger.error(`Resource "${name}" failed to stop:`, error);
      throw RadioError.from(error, RadioErrorCode.RESOURCE_CLEANUP_FAILED);
    }
  }

  /**
   * 回滚已启动的资源
   */
  private async rollback(): Promise<void> {
    logger.info(`Rolling back ${this.startedResources.length} started resource(s)...`);

    const stopOrder = [...this.startedResources].reverse();

    for (const name of stopOrder) {
      try {
        await this.stopResource(name);
      } catch (error) {
        logger.error(`Failed to stop resource "${name}" during rollback:`, error);
      }
    }

    this.startedResources = [];
    logger.info('Rollback complete');
  }

  /**
   * 拓扑排序
   * 返回按依赖关系和优先级排序的资源名称列表
   */
  private topologicalSort(): string[] {
    const sorted: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (name: string) => {
      if (visited.has(name)) {
        return;
      }

      if (visiting.has(name)) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: `Circular dependency detected: ${name}`,
        });
      }

      visiting.add(name);

      const metadata = this.resources.get(name);
      if (metadata) {
        // 先访问依赖
        for (const dep of metadata.dependencies || []) {
          visit(dep);
        }
      }

      visiting.delete(name);
      visited.add(name);
      sorted.push(name);
    };

    // 按优先级排序资源列表
    const resourceList = Array.from(this.resources.entries()).sort(
      ([, a], [, b]) => (a.priority || 100) - (b.priority || 100)
    );

    for (const [name] of resourceList) {
      visit(name);
    }

    return sorted;
  }

  /**
   * 检测循环依赖
   */
  private detectCircularDependencies(): void {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const detectCycle = (name: string, path: string[]): boolean => {
      if (recursionStack.has(name)) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: `Circular dependency detected: ${[...path, name].join(' -> ')}`,
        });
      }

      if (visited.has(name)) {
        return false;
      }

      visited.add(name);
      recursionStack.add(name);

      const metadata = this.resources.get(name);
      if (metadata) {
        for (const dep of metadata.dependencies || []) {
          if (!this.resources.has(dep)) {
            throw new RadioError({
              code: RadioErrorCode.INVALID_CONFIG,
              message: `Dependency "${dep}" of resource "${name}" is not registered`,
            });
          }

          detectCycle(dep, [...path, name]);
        }
      }

      recursionStack.delete(name);
      return false;
    };

    for (const name of this.resources.keys()) {
      detectCycle(name, []);
    }
  }

  /**
   * 为操作添加超时保护
   */
  private withTimeout<T>(
    promise: Promise<T> | T,
    timeoutMs: number,
    operationName: string
  ): Promise<T> {
    return Promise.race([
      Promise.resolve(promise),
      new Promise<T>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new RadioError({
                code: RadioErrorCode.OPERATION_TIMEOUT,
                message: `${operationName} timed out (${timeoutMs}ms)`,
              })
            ),
          timeoutMs
        )
      ),
    ]);
  }
}
