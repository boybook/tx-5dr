import { EventEmitter } from 'eventemitter3';
import type {
  CapabilityDescriptor,
  CapabilityState,
  CapabilityValue,
} from '@tx5dr/contracts';
import type { IRadioConnection } from '../connections/IRadioConnection.js';
import type { RadioIoQueueSnapshot } from '../connections/RadioIoQueue.js';
import { createLogger } from '../../utils/logger.js';
import { isRecoverableOptionalRadioError } from '../optionalRadioError.js';
import { CAPABILITY_DEFINITIONS } from './definitions.js';
import type { CapabilityRuntimeEvents, CapabilitySupportSource, CapabilityWriteResult, ProbeSupportResult, CapabilityDefinition, CapabilityGroupDefinition } from './types.js';

const logger = createLogger('CapabilityRuntimeRegistry');
const RADIO_IO_BACKPRESSURE_WARN_MS = 30_000;
const RADIO_IO_BACKPRESSURE_WARN_COOLDOWN_MS = 10_000;
const RADIO_IO_BACKPRESSURE_RESET_GRACE_MS = 5_000;

function shouldEnforceDiscreteNumberOptions(descriptor: CapabilityDescriptor): boolean {
  // rf_power keeps Hamlib discrete metadata for the optional step slider, but
  // the default UI mode writes arbitrary 0-1 percentages.
  return descriptor.id !== 'rf_power';
}

function formatInlineValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatQueueSnapshot(queue?: RadioIoQueueSnapshot | null): string {
  if (!queue) return 'queue=none';
  return [
    `label=${queue.label ?? 'radio-io'}`,
    `busy=${queue.busy}`,
    `backpressure=${queue.backpressure}`,
    `critical=${queue.criticalActive}`,
    `active=${queue.activeCount}`,
    `activeTask=${queue.activeTask ?? 'none'}`,
    `activeRunMs=${queue.activeRunMs ?? 'na'}`,
    `pending=${queue.pendingCount}`,
    `criticalPending=${queue.criticalPendingCount}`,
    `normalPending=${queue.normalPendingCount}`,
    `oldestPending=${queue.oldestPendingTask ?? 'none'}`,
    `oldestWaitMs=${queue.oldestPendingWaitMs ?? 'na'}`,
    `deduped=${queue.dedupedTaskCount}`,
  ].join(',');
}

export class CapabilityRuntimeRegistry extends EventEmitter<CapabilityRuntimeEvents> {
  private definitionMap = new Map(CAPABILITY_DEFINITIONS.map((definition) => [definition.id, definition]));
  private groups = new Map<string, CapabilityGroupDefinition>();
  private disposeBindings?: () => void;
  private bindingPollTimer?: ReturnType<typeof setInterval>;
  private epoch = 0;
  private descriptorRefreshQueued = false;
  private get definitions(): CapabilityDefinition[] { return [...this.definitionMap.values()]; }
  private connection: IRadioConnection | null = null;
  private readonly supportedCapabilities = new Set<string>();
  private readonly supportSources = new Map<string, CapabilitySupportSource>();
  private readonly valueCache = new Map<string, CapabilityState>();
  private readonly descriptorCache = new Map<string, CapabilityDescriptor>();
  private readonly pollingTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly activePolls = new Map<string, Promise<void>>();

  // PTT state: pause capability polling during TX to reduce USB serial bus load
  private _isPTTActive = false;
  private _isPTTCooldown = false;
  private _isOperatingStateMutation = false;
  private _pttCooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private radioIoBackpressureStartedAt: number | null = null;
  private lastRadioIoBackpressureSeenAt = 0;
  private lastRadioIoBackpressureWarnAt = 0;
  private splitPollSequence = 0;

  setPTTActive(active: boolean): void {
    if (active) {
      this._isPTTActive = true;
      if (this._pttCooldownTimer) {
        clearTimeout(this._pttCooldownTimer);
        this._pttCooldownTimer = null;
      }
      this._isPTTCooldown = false;
      logger.debug('Capability polling paused (PTT active)');
    } else {
      this._isPTTActive = false;
      this._isPTTCooldown = true;
      this._pttCooldownTimer = setTimeout(() => {
        this._isPTTCooldown = false;
        this._pttCooldownTimer = null;
        logger.debug('Capability polling cooldown ended');
      }, 2000);
      logger.debug('Capability polling cooldown started (PTT released)');
    }
  }

  setOperatingStateMutation(active: boolean): void {
    this._isOperatingStateMutation = active;
    logger.debug(`Capability polling ${active ? 'paused' : 'resumed'} for operating-state mutation`);
  }

  async onConnected(connection: IRadioConnection): Promise<void> {
    const epoch = ++this.epoch;
    this.disposeBindings?.();
    this.disposeBindings = undefined;
    this.connection = connection;
    this.stopAllPolling();
    this.supportedCapabilities.clear();
    this.supportSources.clear();
    this.valueCache.clear();
    this.descriptorCache.clear();
    this.definitionMap = new Map(CAPABILITY_DEFINITIONS.map((definition) => [definition.id, definition]));
    this.groups.clear();
    const bindings = connection.getCapabilityBindings?.();
    for (const definition of bindings?.definitions ?? []) this.definitionMap.set(definition.id, definition);
    for (const group of bindings?.groups ?? []) this.groups.set(group.id, group);

    await this.resolveDescriptors(connection);
    if (epoch !== this.epoch) return;
    this.disposeBindings = bindings?.subscribe((states) => {
      if (epoch !== this.epoch) return;
      for (const state of states) this.setCapabilityState(state.id, state);
    }, () => {
      if (epoch !== this.epoch || this.descriptorRefreshQueued) return;
      this.descriptorRefreshQueued = true;
      queueMicrotask(() => {
        this.descriptorRefreshQueued = false;
        if (epoch !== this.epoch) return;
        void this.resolveDescriptors(connection).then(() => {
          if (epoch === this.epoch) this.emit('capabilityList', this.getCapabilitySnapshot());
        });
      });
    });

    logger.info('Probing radio capabilities');
    try {
      await this.probeCapabilities();
    } catch (error) {
      logger.warn('Capability probe encountered an unexpected error', error);
    }
    if (epoch !== this.epoch) return;

    try {
      await this.readInitialValues();
    } catch (error) {
      logger.warn('Initial capability read encountered an unexpected error', error);
    }
    if (epoch !== this.epoch) return;

    this.startPolling();

    logger.info('Capability probe complete', {
      supported: Array.from(this.supportedCapabilities),
    });

    this.emit('capabilityList', this.getCapabilitySnapshot());
  }

  onDisconnected(): void {
    this.epoch += 1;
    this.disposeBindings?.();
    this.disposeBindings = undefined;
    this.groups.clear();
    this.stopAllPolling();
    this.clearPTTState();
    this._isOperatingStateMutation = false;
    this.connection = null;
    this.supportedCapabilities.clear();
    this.supportSources.clear();
    this.valueCache.clear();
    this.descriptorCache.clear();
    this.activePolls.clear();
    this.emit('capabilityList', { descriptors: [], capabilities: [] });
  }

  async refreshAll(reason: 'manual' | 'automatic' = 'manual'): Promise<void> {
    if (!this.connection) return;
    const epoch = this.epoch;
    const visited = new Set<string>();
    logger.info('Refreshing all capability values');
    for (const definition of this.definitions) {
      if (!this.supportedCapabilities.has(definition.id)) continue;
      const descriptor = this.descriptorCache.get(definition.id);
      if (!descriptor?.readable || (!definition.read && !definition.readState)) continue;
      if (reason === 'automatic' && descriptor.updateMode === 'event') continue;
      const key = descriptor.writeGroup?.id ?? definition.id;
      if (visited.has(key)) continue;
      visited.add(key);
      await this.pollCapabilityOnce(definition.id, { source: reason });
      if (epoch !== this.epoch) return;
    }
    this.emit('capabilityList', this.getCapabilitySnapshot());
  }

  async refreshDescriptor(id: string): Promise<void> {
    const epoch = this.epoch;
    const definition = this.definitionMap.get(id);
    if (!definition) {
      throw new Error(`Unknown capability '${id}'`);
    }
    await this.refreshDescriptorIfNeeded(id, definition);
    if (epoch !== this.epoch) return;
    await this.pollCapabilityOnce(id);
  }

  /** Re-run support probing after a late model/profile-identification event. */
  async reprobeCapability(id: string): Promise<void> {
    if (!this.connection) return;
    const epoch = this.epoch;
    const definition = this.definitionMap.get(id);
    if (!definition) throw new Error(`Unknown capability '${id}'`);
    const result = this.normalizeProbeResult(await definition.probeSupport(this.connection));
    if (epoch !== this.epoch) return;
    if (result.supported) {
      this.supportedCapabilities.add(id);
      if (result.source) this.supportSources.set(id, result.source);
      await this.refreshDescriptorIfNeeded(id, definition);
      if (epoch !== this.epoch) return;
      await this.pollCapabilityOnce(id);
      if (epoch !== this.epoch) return;
      this.emit('capabilityList', this.getCapabilitySnapshot());
    }
  }

  async writeCapability(id: string, value?: CapabilityValue, action?: boolean, sessionId?: string): Promise<void> {
    if (!this.connection) {
      throw new Error('Radio not connected');
    }

    const definition = this.definitionMap.get(id);
    const descriptor = this.descriptorCache.get(id);
    if (!definition || !descriptor) {
      throw new Error(`Unknown capability '${id}'`);
    }
    const epoch = this.epoch;
    this.assertWritable(descriptor, sessionId);
    if (descriptor.writeGroup) throw new Error(`Capability '${id}' requires a complete group submission`);

    if (!this.supportedCapabilities.has(id)) {
      throw new Error(`Capability '${id}' is not supported by current radio`);
    }

    this.assertCapabilityAvailable(id);

    if (action) {
      if (!definition.action) {
        throw new Error(`No action handler for capability '${id}'`);
      }

      logger.info(`Executing action: ${id}`);
      try {
        await definition.action(this.connection);
        if (epoch !== this.epoch) throw new Error('Radio capability session changed');
        this.markCapabilityAvailable(id, this.valueCache.get(id)?.value ?? null, true);
      } catch (error) {
        if (epoch !== this.epoch) throw error;
        if (isRecoverableOptionalRadioError(error)) {
          this.markCapabilityUnavailable(id, error);
          throw new Error(`Capability '${id}' is currently unavailable`);
        }
        throw error;
      }
      return;
    }

    if (value === undefined) {
      throw new Error(`Value required for capability '${id}'`);
    }

    this.assertWriteValue(descriptor, value);

    if (!definition.write) {
      throw new Error(`No write handler for capability '${id}'`);
    }

    const isSplitWrite = id === 'split_enabled';
    const writeStartedAt = Date.now();
    logger.info(`Writing capability: ${id} value=${formatInlineValue(value)}`);
    if (isSplitWrite) {
      logger.info(
        `Split capability write started value=${formatInlineValue(value)} cachedValue=${formatInlineValue(this.valueCache.get(id)?.value)} cachedMeta=${formatInlineValue(this.valueCache.get(id)?.meta)} ${formatQueueSnapshot(this.connection.getRadioIoQueueSnapshot?.())}`,
      );
    }

    let writeResult: CapabilityWriteResult | void;
    try {
      writeResult = await definition.write(this.connection, value);
      if (epoch !== this.epoch) throw new Error('Radio capability session changed');
      if (isSplitWrite) {
        logger.info(
          `Split capability write completed value=${formatInlineValue(value)} durationMs=${Date.now() - writeStartedAt} ${formatQueueSnapshot(this.connection.getRadioIoQueueSnapshot?.())}`,
        );
      }
    } catch (error) {
      if (epoch !== this.epoch) throw error;
      if (isSplitWrite) {
        logger.warn(
          `Split capability write failed value=${formatInlineValue(value)} durationMs=${Date.now() - writeStartedAt} error=${error instanceof Error ? error.message : String(error)} ${formatQueueSnapshot(this.connection.getRadioIoQueueSnapshot?.())}`,
        );
      }

      if (isRecoverableOptionalRadioError(error)) {
        this.markCapabilityUnavailable(id, error);
        throw new Error(`Capability '${id}' is currently unavailable`);
      }
      throw error;
    }

    const appliedValue = writeResult?.confirmed === false ? this.valueCache.get(id)?.value ?? null : writeResult?.value ?? value;
    const optimisticState: CapabilityState = {
      id,
      supported: true,
      availability: 'available',
      value: appliedValue,
      meta: { ...this.valueCache.get(id)?.meta, ...writeResult?.meta },
      updatedAt: Date.now(),
    };
    this.valueCache.set(id, optimisticState);
    this.emit('capabilityChanged', optimisticState);
    if (definition.readState) return; // This binding has already confirmed its actual state.

    if (id === 'split_enabled') {
      logger.info(`Split capability write readback requested value=${formatInlineValue(value)} ${formatQueueSnapshot(this.connection.getRadioIoQueueSnapshot?.())}`);
      await this.pollCapabilityOnce(id, { queueAfterActive: true, source: 'write-readback' });
      logger.info(
        `Split capability write readback completed value=${formatInlineValue(value)} cachedValue=${formatInlineValue(this.valueCache.get(id)?.value)} cachedMeta=${formatInlineValue(this.valueCache.get(id)?.meta)} ${formatQueueSnapshot(this.connection.getRadioIoQueueSnapshot?.())}`,
      );
      return;
    }

    setTimeout(() => {
      if (epoch === this.epoch) void this.pollCapabilityOnce(id);
    }, 500);
  }

  async writeCapabilityGroup(groupId: string, values: Record<string, CapabilityValue>, sessionId: string): Promise<void> {
    const group = this.groups.get(groupId);
    if (!this.connection || !group) throw new Error(`Unknown capability group '${groupId}'`);
    if (Object.keys(values).length !== group.members.length || !group.members.every((id) => Object.prototype.hasOwnProperty.call(values, id))) {
      throw new Error(`Capability group '${groupId}' requires exactly its declared members`);
    }
    for (const id of group.members) {
      const descriptor = this.descriptorCache.get(id);
      if (!descriptor || descriptor.writeGroup?.id !== groupId || !this.supportedCapabilities.has(id)) throw new Error(`Capability '${id}' is not supported`);
      this.assertWritable(descriptor, sessionId);
      if (descriptor.sessionId !== sessionId) throw new Error('Radio capability session changed');
      this.assertCapabilityAvailable(id);
      this.assertWriteValue(descriptor, values[id]);
    }
    const epoch = this.epoch;
    await group.write(values);
    if (epoch !== this.epoch) throw new Error('Radio capability session changed');
    for (const id of group.members) {
      if (epoch !== this.epoch) throw new Error('Radio capability session changed');
      await this.pollCapabilityOnce(id, { source: 'write-readback' });
    }
  }

  updateCapabilityMeta(
    id: string,
    updater: (currentMeta: CapabilityState['meta']) => CapabilityState['meta'],
  ): void {
    const currentState = this.valueCache.get(id);
    if (!currentState) {
      return;
    }

    const updatedState: CapabilityState = {
      ...currentState,
      meta: updater(currentState.meta),
      updatedAt: Date.now(),
    };
    this.valueCache.set(id, updatedState);
    this.emit('capabilityChanged', updatedState);
  }

  setCapabilityState(
    id: string,
    nextState: {
      supported?: boolean;
      value: CapabilityState['value'];
      meta?: CapabilityState['meta'];
      availability?: CapabilityState['availability'];
      availabilityReason?: CapabilityState['availabilityReason'];
      lastError?: string;
    },
  ): void {
    const descriptor = this.descriptorCache.get(id);
    if (!descriptor) {
      return;
    }

    const supported = nextState.supported ?? this.supportedCapabilities.has(id);
    if (supported) {
      this.supportedCapabilities.add(id);
    } else {
      this.supportedCapabilities.delete(id);
      this.supportSources.delete(id);
    }

    const updatedState: CapabilityState = {
      id,
      supported,
      availability: nextState.availability ?? (supported ? 'available' : 'unknown'),
      availabilityReason: nextState.availabilityReason,
      lastError: nextState.lastError,
      value: nextState.value,
      meta: nextState.meta,
      updatedAt: Date.now(),
    };
    this.valueCache.set(id, updatedState);
    this.emit('capabilityChanged', updatedState);
  }

  getCapabilitySnapshot(): { descriptors: CapabilityDescriptor[]; capabilities: CapabilityState[] } {
    return {
      descriptors: this.getCapabilityDescriptors(),
      capabilities: this.getCapabilityStates(),
    };
  }

  getCapabilityStates(): CapabilityState[] {
    return structuredClone(this.buildSnapshot());
  }

  /** A detached cached state for one control; reading it never performs protocol I/O. */
  getCapabilityState(id: string): CapabilityState | undefined {
    return this.descriptorCache.has(id) ? structuredClone(this.cachedState(id)) : undefined;
  }

  getCapabilityDescriptors(): CapabilityDescriptor[] {
    if (this.descriptorCache.size === 0) {
      return [];
    }

    return structuredClone(this.definitions
      .map((definition) => this.descriptorCache.get(definition.id))
      .filter((descriptor): descriptor is CapabilityDescriptor => Boolean(descriptor)));
  }

  private async resolveDescriptors(connection: IRadioConnection): Promise<void> {
    const epoch = this.epoch;

    for (const definition of this.definitions) {
      const fallbackDescriptor = definition.descriptor;
      try {
        const descriptor = definition.resolveDescriptor
          ? await definition.resolveDescriptor(connection)
          : fallbackDescriptor;
        if (epoch !== this.epoch) return;
        this.descriptorCache.set(definition.id, descriptor);
      } catch (error) {
        if (epoch !== this.epoch) return;
        logger.debug(`Using fallback descriptor for capability ${definition.id}`, error);
        this.descriptorCache.set(definition.id, fallbackDescriptor);
      }
    }
  }

  private async probeCapabilities(): Promise<void> {
    if (!this.connection) return;
    const connection = this.connection;
    const epoch = this.epoch;

    for (const definition of this.definitions) {
      try {
        const probeResult = await definition.probeSupport(connection);
        if (epoch !== this.epoch) return;
        const { supported, source } = this.normalizeProbeResult(probeResult);
        if (supported) {
          this.supportedCapabilities.add(definition.id);
          if (source) {
            this.supportSources.set(definition.id, source);
          }
          logger.debug(`Capability supported: ${definition.id}`, { source });
        }
      } catch (error) {
        if (isRecoverableOptionalRadioError(error)) {
          logger.debug(`Capability not supported: ${definition.id} (recoverable probe failure)`);
          continue;
        }

        logger.warn(`Capability probe failed for ${definition.id}`, error);
      }
    }
  }

  private async readInitialValues(): Promise<void> {
    const epoch = this.epoch;
    for (const definition of this.definitions) {
      if (epoch !== this.epoch) return;
      if (!this.supportedCapabilities.has(definition.id)) {
        continue;
      }

      const descriptor = this.descriptorCache.get(definition.id);
      if (!descriptor || (!definition.readState && (!descriptor.readable || !definition.read))) {
        continue;
      }

      await this.pollCapabilityOnce(definition.id, { source: 'initial' });
    }
  }

  private startPolling(): void {
    const bindingIds: string[] = [];
    for (const definition of this.definitions) {
      if (!this.supportedCapabilities.has(definition.id)) {
        continue;
      }

      const descriptor = this.descriptorCache.get(definition.id);
      if (!descriptor || descriptor.updateMode !== 'polling' || !descriptor.pollIntervalMs || !descriptor.readable || (!definition.read && !definition.readState)) {
        continue;
      }
      if (definition.readState) { bindingIds.push(definition.id); continue; }

      const timer = setInterval(() => {
        void this.pollCapabilityOnce(definition.id);
      }, descriptor.pollIntervalMs);

      this.pollingTimers.set(definition.id, timer);
      logger.debug(`Started polling for ${definition.id} (interval: ${descriptor.pollIntervalMs}ms)`);
    }
    if (bindingIds.length) {
      const epoch = this.epoch;
      let running = false;
      this.bindingPollTimer = setInterval(() => {
        if (running || epoch !== this.epoch) return;
        running = true;
        void (async () => {
          const visited = new Set<string>();
          for (const id of bindingIds) {
            if (epoch !== this.epoch) break;
            const key = this.descriptorCache.get(id)?.writeGroup?.id ?? id;
            if (visited.has(key)) continue;
            visited.add(key);
            await this.pollCapabilityOnce(id, { source: 'polling' });
          }
        })().finally(() => { running = false; });
      }, 10_000);
    }
  }

  private stopAllPolling(): void {
    if (this.bindingPollTimer) clearInterval(this.bindingPollTimer);
    this.bindingPollTimer = undefined;
    for (const [id, timer] of this.pollingTimers) {
      clearInterval(timer);
      logger.debug(`Stopped polling for ${id}`);
    }
    this.pollingTimers.clear();
    this.clearPTTState();
  }

  private clearPTTState(): void {
    this._isPTTActive = false;
    this._isPTTCooldown = false;
    this.radioIoBackpressureStartedAt = null;
    this.lastRadioIoBackpressureSeenAt = 0;
    this.lastRadioIoBackpressureWarnAt = 0;
    this.activePolls.clear();
    if (this._pttCooldownTimer) {
      clearTimeout(this._pttCooldownTimer);
      this._pttCooldownTimer = null;
    }
  }

  private async pollCapabilityOnce(
    id: string,
    options: { queueAfterActive?: boolean; source?: string } = {},
  ): Promise<void> {
    const epoch = this.epoch;
    const activePoll = this.activePolls.get(id);
    if (activePoll) {
      if (id === 'split_enabled') {
        logger.info('Split capability poll already active', {
          source: options.source ?? 'polling',
          queueAfterActive: Boolean(options.queueAfterActive),
        });
      }

      if (options.queueAfterActive) {
        try {
          await activePoll;
        } catch {
          // The follow-up poll below will surface the latest state/error.
        }
        if (epoch !== this.epoch) return;
        return this.pollCapabilityOnce(id, { ...options, queueAfterActive: false });
      }
      return;
    }

    const poll = this.runCapabilityPoll(id, options);
    this.activePolls.set(id, poll);
    try {
      await poll;
    } finally {
      if (this.activePolls.get(id) === poll) {
        this.activePolls.delete(id);
      }
    }
  }

  private async runCapabilityPoll(
    id: string,
    options: { source?: string } = {},
  ): Promise<void> {
    if (!this.connection) return;
    const connection = this.connection;
    const epoch = this.epoch;

    const isSplitPoll = id === 'split_enabled';
    const splitPollId = isSplitPoll ? ++this.splitPollSequence : 0;
    const splitPollStartedAt = Date.now();

    if (this._isPTTActive || this._isPTTCooldown) {
      if (isSplitPoll) {
        logger.info('Split capability poll skipped: PTT guard active', {
          pollId: splitPollId,
          source: options.source ?? 'polling',
          pttActive: this._isPTTActive,
          pttCooldown: this._isPTTCooldown,
        });
      }
      return;
    }

    if (this._isOperatingStateMutation) {
      logger.debug(`Skipping capability poll while operating-state mutation is active: ${id}`);
      return;
    }

    if (this.shouldSkipForRadioIoBackpressure(id)) {
      return;
    }

    if (this.connection.isCriticalOperationActive?.()) {
      if (isSplitPoll) {
        logger.info(
          `Split capability poll queued despite critical radio operation active pollId=${splitPollId} source=${options.source ?? 'polling'} ${formatQueueSnapshot(this.connection.getRadioIoQueueSnapshot?.())}`,
        );
      } else {
        logger.debug(`Skipping capability poll while critical radio operation is active: ${id}`);
        return;
      }
    }

    const definition = this.definitionMap.get(id);
    const descriptor = this.descriptorCache.get(id);
    if (!definition || !descriptor || (!definition.readState && (!definition.read || !descriptor.readable))) return;

    try {
      if (definition.readState) {
        const state = await definition.readState(connection, options.source === 'manual' || options.source === 'polling');
        if (epoch === this.epoch) this.setCapabilityState(id, state);
        return;
      }
      if (isSplitPoll) {
        logger.info(
          `Split capability poll started pollId=${splitPollId} source=${options.source ?? 'polling'} cachedValue=${formatInlineValue(this.valueCache.get(id)?.value)} cachedMeta=${formatInlineValue(this.valueCache.get(id)?.meta)} ${formatQueueSnapshot(this.connection.getRadioIoQueueSnapshot?.())}`,
        );
      }

      const newValue = await definition.read!(connection);
      if (epoch !== this.epoch) return;
      const cached = this.valueCache.get(id);

      // Read additional metadata (e.g. split TX frequency) if supported
      let mergedMeta = cached?.meta;
      if (definition.readMeta) {
        try {
          const extraMeta = await definition.readMeta(connection);
          if (epoch !== this.epoch) return;
          if (extraMeta) {
            mergedMeta = { ...(mergedMeta ?? {}), ...extraMeta };
          }
        } catch (metaError) {
          if (isSplitPoll) {
            logger.info(
              `Split capability poll meta read failed pollId=${splitPollId} source=${options.source ?? 'polling'} error=${metaError instanceof Error ? metaError.message : String(metaError)}`,
            );
          }
          logger.debug(`readMeta failed for ${id}`, metaError);
        }
      }

      const changed = !cached
        || cached.value !== newValue
        || cached.availability !== 'available'
        || Boolean(cached.lastError)
        || JSON.stringify(cached.meta) !== JSON.stringify(mergedMeta);

      if (isSplitPoll) {
        logger.info(
          `Split capability poll completed pollId=${splitPollId} source=${options.source ?? 'polling'} durationMs=${Date.now() - splitPollStartedAt} value=${formatInlineValue(newValue)} meta=${formatInlineValue(mergedMeta)} cachedValue=${formatInlineValue(cached?.value)} cachedMeta=${formatInlineValue(cached?.meta)} changed=${changed} ${formatQueueSnapshot(this.connection.getRadioIoQueueSnapshot?.())}`,
        );
      }

      if (changed) {
        const newState: CapabilityState = {
          id,
          supported: true,
          availability: 'available',
          value: newValue,
          meta: mergedMeta,
          updatedAt: Date.now(),
        };

        if (id === 'tuner_switch') {
          const currentMeta = mergedMeta ?? {};
          newState.meta = currentMeta.status === 'tuning' ? currentMeta : { ...currentMeta, status: 'idle' };
        }

        this.valueCache.set(id, newState);

        if (cached) {
          logger.debug(`Capability changed: ${id}`, { value: newValue });
          this.emit('capabilityChanged', newState);
        }
      }

      if (id === 'tuner_switch') {
        this.markRelatedTunerActionAvailable();
      }
    } catch (error) {
      if (epoch !== this.epoch) return;
      if (isSplitPoll) {
        logger.warn(
          `Split capability poll failed pollId=${splitPollId} source=${options.source ?? 'polling'} durationMs=${Date.now() - splitPollStartedAt} error=${error instanceof Error ? error.message : String(error)} ${formatQueueSnapshot(this.connection.getRadioIoQueueSnapshot?.())}`,
        );
      }

      if (isRecoverableOptionalRadioError(error)) {
        if (this.supportedCapabilities.has(id)) {
          this.markCapabilityUnavailable(id, error);
        } else {
          this.markCapabilityUnsupported(id, error);
        }
        return;
      }

      logger.debug(`Failed to poll capability ${id}`, error);
    }
  }

  private shouldSkipForRadioIoBackpressure(id: string): boolean {
    if (id === 'split_enabled') {
      return false;
    }

    const snapshot = this.connection?.getRadioIoQueueSnapshot?.();
    const now = Date.now();
    if (!snapshot?.backpressure) {
      if (
        this.radioIoBackpressureStartedAt !== null
        && now - this.lastRadioIoBackpressureSeenAt > RADIO_IO_BACKPRESSURE_RESET_GRACE_MS
      ) {
        this.radioIoBackpressureStartedAt = null;
      }
      return false;
    }

    this.lastRadioIoBackpressureSeenAt = now;
    if (this.radioIoBackpressureStartedAt === null) {
      this.radioIoBackpressureStartedAt = now;
    }

    const pauseDurationMs = now - this.radioIoBackpressureStartedAt;
    const context = {
      reason: 'capability-polling',
      capabilityId: id,
      pauseDurationMs,
      ...snapshot,
    };

    logger.debug('Skipping capability poll while radio I/O queue is busy', context);

    if (
      pauseDurationMs >= RADIO_IO_BACKPRESSURE_WARN_MS
      && now - this.lastRadioIoBackpressureWarnAt >= RADIO_IO_BACKPRESSURE_WARN_COOLDOWN_MS
    ) {
      this.lastRadioIoBackpressureWarnAt = now;
      logger.warn('Serial CAT queue remains busy; low-priority polling paused', context);
    }

    return true;
  }

  private async refreshDescriptorIfNeeded(id: string, definition = this.definitionMap.get(id)): Promise<void> {
    if (!this.connection || !definition?.resolveDescriptor) {
      return;
    }

    const epoch = this.epoch;
    try {
      const nextDescriptor = await definition.resolveDescriptor(this.connection);
      if (epoch !== this.epoch) return;
      const currentDescriptor = this.descriptorCache.get(id);
      if (!currentDescriptor) {
        this.descriptorCache.set(id, nextDescriptor);
        this.emit('capabilityList', this.getCapabilitySnapshot());
        return;
      }

      if (JSON.stringify(currentDescriptor) === JSON.stringify(nextDescriptor)) {
        return;
      }

      this.descriptorCache.set(id, nextDescriptor);
      logger.debug(`Capability descriptor refreshed: ${id}`);
      this.emit('capabilityList', this.getCapabilitySnapshot());
    } catch (error) {
      logger.debug(`Failed to refresh descriptor for ${id}`, error);
    }
  }

  private markCapabilityUnsupported(id: string, error: unknown): void {
    const hadCachedState = this.valueCache.has(id);
    const hadPollingTimer = this.pollingTimers.has(id);

    this.supportedCapabilities.delete(id);
    this.supportSources.delete(id);
    this.valueCache.delete(id);

    const timer = this.pollingTimers.get(id);
    if (timer) {
      clearInterval(timer);
      this.pollingTimers.delete(id);
    }

    logger.info(`Capability downgraded to unsupported: ${id}`, {
      reason: error instanceof Error ? error.message : String(error),
    });

    if (hadCachedState || hadPollingTimer) {
      this.emit('capabilityChanged', {
        id,
        supported: false,
        availability: 'unknown',
        value: null,
        lastError: this.formatCapabilityError(error),
        updatedAt: Date.now(),
      });
    }
  }

  private markCapabilityUnavailable(id: string, error: unknown): void {
    const cached = this.valueCache.get(id);
    const unavailableState: CapabilityState = {
      id,
      supported: true,
      availability: 'unavailable',
      availabilityReason: 'runtime_error',
      lastError: this.formatCapabilityError(error),
      value: null,
      meta: cached?.meta,
      updatedAt: Date.now(),
    };

    this.supportedCapabilities.add(id);
    this.valueCache.set(id, unavailableState);
    logger.info(`Capability temporarily unavailable: ${id}`, {
      reason: unavailableState.lastError,
      source: this.supportSources.get(id),
    });
    this.emit('capabilityChanged', unavailableState);
  }

  private markCapabilityAvailable(id: string, value: CapabilityState['value'], emit = false): void {
    const cached = this.valueCache.get(id);
    const availableState: CapabilityState = {
      id,
      supported: true,
      availability: 'available',
      value,
      meta: cached?.meta,
      updatedAt: Date.now(),
    };
    this.valueCache.set(id, availableState);
    if (emit) {
      this.emit('capabilityChanged', availableState);
    }
  }

  private markRelatedTunerActionAvailable(): void {
    const id = 'tuner_tune';
    if (!this.supportedCapabilities.has(id)) {
      return;
    }

    const cached = this.valueCache.get(id);
    if (cached?.availability !== 'unavailable') {
      return;
    }

    const availableState: CapabilityState = {
      id,
      supported: true,
      availability: 'available',
      value: null,
      meta: cached.meta,
      updatedAt: Date.now(),
    };
    this.valueCache.set(id, availableState);
    this.emit('capabilityChanged', availableState);
  }

  private buildSnapshot(): CapabilityState[] {
    if (this.descriptorCache.size === 0) {
      return [];
    }

    return this.definitions
      .filter((definition) => this.descriptorCache.has(definition.id))
      .map((definition) => this.cachedState(definition.id));
  }

  private cachedState(id: string): CapabilityState {
    const cached = this.valueCache.get(id);
    if (cached) return cached;
    const supported = this.supportedCapabilities.has(id);
    return { id, supported, availability: supported ? 'available' : 'unknown', value: null, updatedAt: Date.now() };
  }

  private normalizeProbeResult(result: ProbeSupportResult): { supported: boolean; source?: CapabilitySupportSource } {
    if (typeof result === 'boolean') {
      return { supported: result, source: result ? 'runtime-probe' : undefined };
    }
    return result;
  }

  private assertCapabilityAvailable(id: string): void {
    const cached = this.valueCache.get(id);
    if (cached?.availability === 'unavailable') {
      throw new Error(`Capability '${id}' is currently unavailable`);
    }
  }

  private formatCapabilityError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private assertWriteValue(descriptor: CapabilityDescriptor, value: CapabilityValue): void {
    switch (descriptor.valueType) {
      case 'boolean':
        if (typeof value !== 'boolean') {
          throw new Error(`Capability '${descriptor.id}' expects a boolean value`);
        }
        return;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error(`Capability '${descriptor.id}' expects a numeric value`);
        }
        if ((descriptor.limits?.min !== undefined && value < descriptor.limits.min)
          || (descriptor.limits?.max !== undefined && value > descriptor.limits.max)) throw new Error(`Capability '${descriptor.id}' value out of range`);
        if (descriptor.range && (value < descriptor.range.min || value > descriptor.range.max)) {
          throw new Error(`Capability '${descriptor.id}' value out of range`);
        }
        if (
          shouldEnforceDiscreteNumberOptions(descriptor)
          && descriptor.discreteOptions
          && descriptor.discreteOptions.length > 0
        ) {
          const matched = descriptor.discreteOptions.some((option) => option.value === value);
          if (!matched) {
            throw new Error(`Capability '${descriptor.id}' received an unsupported discrete numeric value`);
          }
        }
        return;
      case 'enum': {
        if (typeof value !== 'string' && typeof value !== 'number') {
          throw new Error(`Capability '${descriptor.id}' expects an enum value`);
        }
        if (descriptor.options && descriptor.options.length > 0) {
          const matched = descriptor.options.some((option) => option.value === value);
          if (!matched) {
            throw new Error(`Capability '${descriptor.id}' received an unsupported enum value`);
          }
        }
        return;
      }
      case 'action':
        throw new Error(`Capability '${descriptor.id}' is action-only`);
      default:
        throw new Error(`Unsupported capability value type for '${descriptor.id}'`);
    }
  }

  private assertWritable(descriptor: CapabilityDescriptor, sessionId?: string): void {
    if (!descriptor.writable) throw new Error(`Capability '${descriptor.id}' is read-only`);
    if (sessionId !== undefined && descriptor.sessionId !== sessionId) throw new Error('Radio capability session changed');
    if (descriptor.requiresIdle && (this._isPTTActive || this._isOperatingStateMutation || this.connection?.isCriticalOperationActive?.())) {
      throw new Error(`Capability '${descriptor.id}' requires an idle radio`);
    }
  }
}
