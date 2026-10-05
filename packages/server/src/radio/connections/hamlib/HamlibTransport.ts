import { EventEmitter } from 'eventemitter3';
import type { HamlibEndpointEvents } from './HamlibEndpoint.js';
import { decodeHamlibResult, type HamlibOperation, type HamlibSnapshot } from './hamlib-protocol.js';
import type { HamlibEndpoint } from './HamlibEndpoint.js';
import { RadioError, RadioErrorCode } from '../../../utils/errors/RadioError.js';

const retiringHosts = new Set<Promise<void>>();
export async function waitForHamlibHostRetirement(): Promise<void> { await Promise.all(retiringHosts); }
export function trackHamlibHostRetirement(retirement: Promise<void>): void {
  retiringHosts.add(retirement);
  void retirement.then(() => retiringHosts.delete(retirement), () => {});
}

export abstract class HamlibTransport extends EventEmitter<HamlibEndpointEvents> {
  abstract readonly mode: 'process' | 'in-process';
  abstract call(operation: HamlibOperation, args: unknown[]): Promise<unknown>;
  abstract close(): Promise<void>;
  abstract get diagnostics(): Record<string, unknown>;
}

let inProcessFailure: Error | null = null;
export function assertHamlibHostAvailable(): void { if (inProcessFailure) throw inProcessFailure; }

export class LocalHamlibTransport extends HamlibTransport {
  readonly mode = 'in-process' as const;
  private endpoint: Promise<HamlibEndpoint> | null = null;
  private stopped = false;

  get diagnostics(): Record<string, unknown> { return { executionMode: this.mode, pid: process.pid, restartRequired: Boolean(inProcessFailure) }; }

  private async getEndpoint(): Promise<HamlibEndpoint> {
    assertHamlibHostAvailable();
    if (this.stopped) throw new Error('Hamlib transport is closed');
    this.endpoint ??= waitForHamlibHostRetirement().then(() => {
      assertHamlibHostAvailable();
      if (this.stopped) throw new Error('Hamlib transport is closed');
      return import('./HamlibEndpoint.js');
    }).then(({ HamlibEndpoint }) => {
      const endpoint = new HamlibEndpoint();
      endpoint.on('snapshot', (snapshot: HamlibSnapshot) => this.emit('snapshot', snapshot));
      endpoint.on('event', event => this.emit('event', event));
      endpoint.on('fault', error => {
        const original = RadioError.from(error);
        inProcessFailure = new RadioError({ code: RadioErrorCode.OPERATION_TIMEOUT, message: original.message,
          userMessageKey: 'radio:error.hamlibHostFailed', context: { ...original.context,
            executionMode: 'in-process', restartRequired: true, hamlibHostFatal: true, stateUncertain: true } });
        this.emit('fault', inProcessFailure);
      });
      endpoint.publishSnapshot();
      return endpoint;
    });
    return this.endpoint;
  }

  async call(operation: HamlibOperation, args: unknown[]): Promise<unknown> {
    const endpoint = await this.getEndpoint();
    return decodeHamlibResult(operation, await endpoint.call(operation, args));
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (!this.endpoint || inProcessFailure) return;
    const endpoint = await this.endpoint;
    await endpoint.call('disconnect', ['transport stopped']);
    endpoint.removeAllListeners();
  }
}
