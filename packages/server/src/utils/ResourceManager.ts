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
  register(config: ResourceConfig): void;
  /**
   * 注册资源（简化的函数形式）
   */
  register(config: SimplifiedResourceConfig): void;
  /**
   * 注册资源（实现）
   */
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
        message: `资源 "${name}" 已注册`,
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

    console.log(
      `📦 [ResourceManager] 注册资源: ${name} (优先级: ${priority}, 可选: ${optional})`
    );
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
        message: `无法取消注册运行中的资源 "${name}"`,
      });
    }

    this.resources.delete(name);
    console.log(`📦 [ResourceManager] 取消注册资源: ${name}`);
  }

  /**
   * 启动所有资源
   * 按优先级和依赖关系顺序启动
   * 如果任何必需资源启动失败，会自动回滚已启动的资源
   */
  async startAll(): Promise<void> {
    console.log(`🚀 [ResourceManager] 开始启动所有资源...`);

    // 检测循环依赖
    this.detectCircularDependencies();

    // 拓扑排序
    const startOrder = this.topologicalSort();

    console.log(
      `📋 [ResourceManager] 启动顺序: ${startOrder.join(' → ')}`
    );

    this.startedResources = [];

    try {
      for (const name of startOrder) {
        await this.startResource(name);
      }

      console.log(
        `✅ [ResourceManager] 所有资源启动成功 (${this.startedResources.length} 个)`
      );
    } catch (error) {
      console.error(`❌ [ResourceManager] 资源启动失败，开始回滚...`);
      await this.rollback();
      throw error;
    }
  }

  /**
   * 停止所有资源
   * 按启动的逆序停止
   */
  async stopAll(): Promise<void> {
    console.log(`🛑 [ResourceManager] 开始停止所有资源...`);

    // 按逆序停止
    const stopOrder = [...this.startedResources].reverse();

    console.log(
      `📋 [ResourceManager] 停止顺序: ${stopOrder.join(' → ')}`
    );

    const errors: Error[] = [];

    for (const name of stopOrder) {
      try {
        await this.stopResource(name);
      } catch (error) {
        console.error(
          `⚠️  [ResourceManager] 停止资源 "${name}" 失败:`,
          error
        );
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    this.startedResources = [];

    if (errors.length > 0) {
      console.warn(
        `⚠️  [ResourceManager] 停止完成，但有 ${errors.length} 个资源失败`
      );
    } else {
      console.log(`✅ [ResourceManager] 所有资源停止成功`);
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
        message: '无法清空：还有资源正在运行',
      });
    }

    this.resources.clear();
    console.log(`🗑️  [ResourceManager] 已清空所有资源注册`);
  }

  /**
   * 启动单个资源
   */
  private async startResource(name: string): Promise<void> {
    const metadata = this.resources.get(name);
    if (!metadata) {
      throw new RadioError({
        code: RadioErrorCode.RESOURCE_UNAVAILABLE,
        message: `未找到资源 "${name}"`,
      });
    }

    const { resource, optional, startTimeout = 30000 } = metadata;

    // 检查依赖是否已启动
    for (const depName of metadata.dependencies || []) {
      const depMetadata = this.resources.get(depName);
      if (!depMetadata || depMetadata.state !== ResourceState.RUNNING) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_STATE,
          message: `资源 "${name}" 依赖的资源 "${depName}" 未运行`,
        });
      }
    }

    // 如果已经在运行，跳过
    if (metadata.state === ResourceState.RUNNING) {
      console.log(`⏩ [ResourceManager] 资源 "${name}" 已在运行，跳过`);
      return;
    }

    metadata.state = ResourceState.STARTING;
    console.log(`▶️  [ResourceManager] 启动资源: ${name}`);

    try {
      // 使用超时保护
      await this.withTimeout(resource.start(), startTimeout, `启动资源 "${name}"`);

      metadata.state = ResourceState.RUNNING;
      metadata.startedAt = Date.now();
      this.startedResources.push(name);

      console.log(`✅ [ResourceManager] 资源 "${name}" 启动成功`);
    } catch (error) {
      metadata.state = ResourceState.ERROR;
      metadata.error = error instanceof Error ? error : new Error(String(error));

      if (optional) {
        console.warn(
          `⚠️  [ResourceManager] 可选资源 "${name}" 启动失败 (忽略):`,
          error
        );
        // 可选资源失败不抛出异常
        return;
      }

      console.error(`❌ [ResourceManager] 资源 "${name}" 启动失败:`, error);
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
    console.log(`⏸️  [ResourceManager] 停止资源: ${name}`);

    try {
      await this.withTimeout(resource.stop(), stopTimeout, `停止资源 "${name}"`);

      metadata.state = ResourceState.STOPPED;
      metadata.stoppedAt = Date.now();

      console.log(`✅ [ResourceManager] 资源 "${name}" 停止成功`);
    } catch (error) {
      metadata.state = ResourceState.ERROR;
      metadata.error = error instanceof Error ? error : new Error(String(error));

      console.error(`❌ [ResourceManager] 资源 "${name}" 停止失败:`, error);
      throw RadioError.from(error, RadioErrorCode.RESOURCE_CLEANUP_FAILED);
    }
  }

  /**
   * 回滚已启动的资源
   */
  private async rollback(): Promise<void> {
    console.log(
      `🔄 [ResourceManager] 回滚 ${this.startedResources.length} 个已启动的资源...`
    );

    const stopOrder = [...this.startedResources].reverse();

    for (const name of stopOrder) {
      try {
        await this.stopResource(name);
      } catch (error) {
        console.error(
          `⚠️  [ResourceManager] 回滚时停止资源 "${name}" 失败:`,
          error
        );
      }
    }

    this.startedResources = [];
    console.log(`✅ [ResourceManager] 回滚完成`);
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
          message: `检测到循环依赖: ${name}`,
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
          message: `检测到循环依赖: ${[...path, name].join(' → ')}`,
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
              message: `资源 "${name}" 依赖的资源 "${dep}" 未注册`,
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
                message: `${operationName} 超时 (${timeoutMs}ms)`,
              })
            ),
          timeoutMs
        )
      ),
    ]);
  }
}
