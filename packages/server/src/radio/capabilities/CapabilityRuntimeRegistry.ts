import { EventEmitter } from 'eventemitter3';
import type {
  CapabilityDescriptor,
  CapabilityState,
  CapabilityValue,
} from '@tx5dr/contracts';
import type { IRadioConnection } from '../connections/IRadioConnection.js';
import { createLogger } from '../../utils/logger.js';
import { isRecoverableOptionalRadioError } from '../optionalRadioError.js';
import { CAPABILITY_DEFINITION_MAP, CAPABILITY_DEFINITIONS } from './definitions.js';
import type { CapabilityRuntimeEvents } from './types.js';

const logger = createLogger('CapabilityRuntimeRegistry');

function shouldEnforceDiscreteNumberOptions(descriptor: CapabilityDescriptor): boolean {
  // rf_power keeps Hamlib discrete metadata for the optional step slider, but
  // the default UI mode writes arbitrary 0-1 percentages.
  return descriptor.id !== 'rf_power';
}

export class CapabilityRuntimeRegistry extends EventEmitter<CapabilityRuntimeEvents> {
  private connection: IRadioConnection | null = null;
  private readonly supportedCapabilities = new Set<string>();
  private readonly valueCache = new Map<string, CapabilityState>();
  private readonly descriptorCache = new Map<string, CapabilityDescriptor>();
  private readonly pollingTimers = new Map<string, ReturnType<typeof setInterval>>();

  // PTT state: pause capability polling during TX to reduce USB serial bus load
  private _isPTTActive = false;
  private _isPTTCooldown = false;
  private _pttCooldownTimer: ReturnType<typeof setTimeout> | null = null;

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

  async onConnected(connection: IRadioConnection): Promise<void> {
    this.connection = connection;
    this.stopAllPolling();
    this.supportedCapabilities.clear();
    this.valueCache.clear();

    await this.resolveDescriptors(connection);

    logger.info('Probing radio capabilities');
    try {
      await this.probeCapabilities();
    } catch (error) {
      logger.warn('Capability probe encountered an unexpected error', error);
    }

    try {
      await this.readInitialValues();
    } catch (error) {
      logger.warn('Initial capability read encountered an unexpected error', error);
    }

    logger.info('Capability probe complete', {
      supported: Array.from(this.supportedCapabilities),
    });

    this.emit('capabilityList', this.getCapabilitySnapshot());
  }

  onDisconnected(): void {
    this.stopAllPolling();
    this.clearPTTState();
    this.connection = null;
    this.supportedCapabilities.clear();
    this.valueCache.clear();
    this.descriptorCache.clear();
    this.emit('capabilityList', { descriptors: [], capabilities: [] });
  }

  async refreshAll(): Promise<void> {
    if (!this.connection) return;
    logger.info('Refreshing all capability values');
    for (const definition of CAPABILITY_DEFINITIONS) {
      if (!this.supportedCapabilities.has(definition.id)) continue;
      const descriptor = this.descriptorCache.get(definition.id);
      if (!descriptor?.readable || !definition.read) continue;
      await this.pollCapabilityOnce(definition.id);
    }
    this.emit('capabilityList', this.getCapabilitySnapshot());
  }

  async refreshDescriptor(id: string): Promise<void> {
    const definition = CAPABILITY_DEFINITION_MAP.get(id);
    if (!definition) {
      throw new Error(`Unknown capability '${id}'`);
    }
    await this.refreshDescriptorIfNeeded(id, definition);
  }

  async writeCapability(id: string, value?: CapabilityValue, action?: boolean): Promise<void> {
    if (!this.connection) {
      throw new Error('Radio not connected');
    }

    const definition = CAPABILITY_DEFINITION_MAP.get(id);
    const descriptor = this.descriptorCache.get(id);
    if (!definition || !descriptor) {
      throw new Error(`Unknown capability '${id}'`);
    }

    if (!this.supportedCapabilities.has(id)) {
      throw new Error(`Capability '${id}' is not supported by current radio`);
    }

    if (action) {
      if (!definition.action) {
        throw new Error(`No action handler for capability '${id}'`);
      }

      logger.info(`Executing action: ${id}`);
      await definition.action(this.connection);
      return;
    }

    if (value === undefined) {
      throw new Error(`Value required for capability '${id}'`);
    }

    this.assertWriteValue(descriptor, value);

    if (!definition.write) {
      throw new Error(`No write handler for capability '${id}'`);
    }

    logger.info(`Writing capability: ${id}`, { value });
    await definition.write(this.connection, value);

    const optimisticState: CapabilityState = {
      id,
      supported: true,
      value,
      meta: this.valueCache.get(id)?.meta,
      updatedAt: Date.now(),
    };
    this.valueCache.set(id, optimisticState);
    this.emit('capabilityChanged', optimisticState);

    setTimeout(() => {
      void this.pollCapabilityOnce(id);
    }, 500);
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
    }

    const updatedState: CapabilityState = {
      id,
      supported,
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
      capabilities: this.buildSnapshot(),
    };
  }

  getCapabilityStates(): CapabilityState[] {
    return this.buildSnapshot();
  }

  getCapabilityDescriptors(): CapabilityDescriptor[] {
    if (this.descriptorCache.size === 0) {
      return [];
    }

    return CAPABILITY_DEFINITIONS
      .map((definition) => this.descriptorCache.get(definition.id))
      .filter((descriptor): descriptor is CapabilityDescriptor => Boolean(descriptor));
  }

  private async resolveDescriptors(connection: IRadioConnection): Promise<void> {
    this.descriptorCache.clear();

    for (const definition of CAPABILITY_DEFINITIONS) {
      const fallbackDescriptor = definition.descriptor;
      try {
        const descriptor = definition.resolveDescriptor
          ? await definition.resolveDescriptor(connection)
          : fallbackDescriptor;
        this.descriptorCache.set(definition.id, descriptor);
      } catch (error) {
        logger.debug(`Using fallback descriptor for capability ${definition.id}`, error);
        this.descriptorCache.set(definition.id, fallbackDescriptor);
      }
    }
  }

  private async probeCapabilities(): Promise<void> {
    if (!this.connection) return;

    for (const definition of CAPABILITY_DEFINITIONS) {
      try {
        const supported = await definition.probeSupport(this.connection);
        if (supported) {
          this.supportedCapabilities.add(definition.id);
          logger.debug(`Capability supported: ${definition.id}`);
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
    for (const definition of CAPABILITY_DEFINITIONS) {
      if (!this.supportedCapabilities.has(definition.id)) {
        continue;
      }

      const descriptor = this.descriptorCache.get(definition.id);
      if (!descriptor?.readable || !definition.read) {
        continue;
      }

      await this.pollCapabilityOnce(definition.id);
    }
  }

  private startPolling(): void {
    for (const definition of CAPABILITY_DEFINITIONS) {
      if (!this.supportedCapabilities.has(definition.id)) {
        continue;
      }

      const descriptor = this.descriptorCache.get(definition.id);
      if (!descriptor || descriptor.updateMode !== 'polling' || !descriptor.pollIntervalMs || !descriptor.readable || !definition.read) {
        continue;
      }

      const timer = setInterval(() => {
        void this.pollCapabilityOnce(definition.id);
      }, descriptor.pollIntervalMs);

      this.pollingTimers.set(definition.id, timer);
      logger.debug(`Started polling for ${definition.id} (interval: ${descriptor.pollIntervalMs}ms)`);
    }
  }

  private stopAllPolling(): void {
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
    if (this._pttCooldownTimer) {
      clearTimeout(this._pttCooldownTimer);
      this._pttCooldownTimer = null;
    }
  }

  private async pollCapabilityOnce(id: string): Promise<void> {
    if (!this.connection) return;

    if (this._isPTTActive || this._isPTTCooldown) {
      return;
    }

    if (this.connection.isCriticalOperationActive?.()) {
      logger.debug(`Skipping capability poll while critical radio operation is active: ${id}`);
      return;
    }

    const definition = CAPABILITY_DEFINITION_MAP.get(id);
    const descriptor = this.descriptorCache.get(id);
    if (!definition?.read || !descriptor?.readable) return;

    try {
      await this.refreshDescriptorIfNeeded(id, definition);
      const newValue = await definition.read(this.connection);
      const cached = this.valueCache.get(id);

      if (!cached || cached.value !== newValue) {
        const newState: CapabilityState = {
          id,
          supported: true,
          value: newValue,
          meta: cached?.meta,
          updatedAt: Date.now(),
        };

        if (id === 'tuner_switch') {
          const currentMeta = cached?.meta ?? {};
          newState.meta = currentMeta.status === 'tuning' ? currentMeta : { ...currentMeta, status: 'idle' };
        }

        this.valueCache.set(id, newState);

        if (cached) {
          logger.debug(`Capability changed: ${id}`, { value: newValue });
          this.emit('capabilityChanged', newState);
        }
      }
    } catch (error) {
      if (isRecoverableOptionalRadioError(error)) {
        this.markCapabilityUnsupported(id, error);
        return;
      }

      logger.debug(`Failed to poll capability ${id}`, error);
    }
  }

  private async refreshDescriptorIfNeeded(id: string, definition = CAPABILITY_DEFINITION_MAP.get(id)): Promise<void> {
    if (!this.connection || !definition?.resolveDescriptor) {
      return;
    }

    try {
      const nextDescriptor = await definition.resolveDescriptor(this.connection);
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
        value: null,
        updatedAt: Date.now(),
      });
    }
  }

  private buildSnapshot(): CapabilityState[] {
    if (this.descriptorCache.size === 0) {
      return [];
    }

    return CAPABILITY_DEFINITIONS
      .filter((definition) => this.descriptorCache.has(definition.id))
      .map((definition) => {
        const cached = this.valueCache.get(definition.id);
        if (cached) return cached;

        if (this.supportedCapabilities.has(definition.id)) {
          return {
            id: definition.id,
            supported: true,
            value: null,
            updatedAt: Date.now(),
          };
        }

        return {
          id: definition.id,
          supported: false,
          value: null,
          updatedAt: Date.now(),
        };
      });
  }

  private assertWriteValue(descriptor: CapabilityDescriptor, value: CapabilityValue): void {
    switch (descriptor.valueType) {
      case 'boolean':
        if (typeof value !== 'boolean') {
          throw new Error(`Capability '${descriptor.id}' expects a boolean value`);
        }
        return;
      case 'number':
        if (typeof value !== 'number') {
          throw new Error(`Capability '${descriptor.id}' expects a numeric value`);
        }
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
}
