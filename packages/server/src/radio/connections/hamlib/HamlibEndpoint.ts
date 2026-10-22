import { EventEmitter } from 'eventemitter3';
import { HamLib } from 'hamlib';
import { HamlibRuntime } from './HamlibRuntime.js';
import { HAMLIB_OPERATIONS, HamlibEventSchema, deserializeHamlibError, encodeHamlibResult, serializeHamlibError, type HamlibEvent, type HamlibOperation, type HamlibSnapshot } from './hamlib-protocol.js';
import { RadioError } from '../../../utils/errors/RadioError.js';

export interface HamlibEndpointEvents {
  snapshot: (snapshot: HamlibSnapshot) => void;
  event: (event: HamlibEvent) => void;
  fault: (error: Error) => void;
}

export class HamlibEndpoint extends EventEmitter<HamlibEndpointEvents> {
  readonly runtime = new HamlibRuntime();

  constructor() {
    super();
    this.runtime.diagnostics.on('snapshot', snapshot => this.emit('snapshot', snapshot));
    this.runtime.diagnostics.on('fault', error => this.emit('fault', error));
    const forward = (event: HamlibEvent['event'], args: unknown[]) => {
      this.publishSnapshot();
      this.emit('event', HamlibEventSchema.parse({ event, args }));
    };
    this.runtime.on('stateChanged', state => forward('stateChanged', [state]));
    this.runtime.on('connected', () => forward('connected', []));
    this.runtime.on('disconnected', reason => forward('disconnected', [reason]));
    this.runtime.on('error', error => forward('error', [serializeHamlibError(error)]));
    this.runtime.on('frequencyChanged', frequency => forward('frequencyChanged', [frequency]));
    this.runtime.on('meterData', data => forward('meterData', [data]));
    this.runtime.on('meterCapabilitiesChanged', data => forward('meterCapabilitiesChanged', [data]));
  }

  publishSnapshot(): void { this.emit('snapshot', this.runtime.getSnapshot()); }

  async call(operation: HamlibOperation, input: unknown[]): Promise<unknown> {
    const args = HAMLIB_OPERATIONS[operation].args.parse(input);
    const fault = this.runtime.getSnapshot().fault;
    if (fault && operation !== 'disconnect') throw deserializeHamlibError(fault);
    try {
      let result: unknown;
      if (operation === 'startManagedSpectrum') {
        await this.runtime.startManagedSpectrum(line => {
          this.emit('event', HamlibEventSchema.parse({ event: 'spectrumLine', args: [line] }));
        }, args[0] as Parameters<HamlibRuntime['startManagedSpectrum']>[1]);
      } else if (operation === 'listSupportedRigs') {
        result = HamLib.getSupportedRigs();
      } else if (operation === 'getRigMetadata') {
        const model = args[0] as number;
        result = { fields: HamLib.getConfigSchemaForModel(model), portCaps: HamLib.getPortCapsForModel(model) };
      } else {
        // The schema catalog is the sole dispatch allowlist; private methods are never addressable.
        const method = (this.runtime as unknown as Record<HamlibOperation, (...args: unknown[]) => unknown>)[operation];
        if (typeof method !== 'function') throw new Error(`Unsupported Hamlib operation: ${operation}`);
        result = await method.apply(this.runtime, args);
      }
      return encodeHamlibResult(operation, result);
    } catch (error) {
      if (error instanceof Error && error.message.includes('HAMLIB_GLOBAL_LOCK_TIMEOUT')) {
        this.emit('fault', RadioError.from(error));
      }
      throw error;
    } finally {
      this.publishSnapshot();
    }
  }
}
