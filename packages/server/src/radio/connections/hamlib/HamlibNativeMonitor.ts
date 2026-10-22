import type { HamLib } from 'hamlib';
import type { HamlibConfig } from '@tx5dr/contracts';
import type { z } from 'zod';
import type { HamlibActivitySchema } from './hamlib-protocol.js';
import { RadioError, RadioErrorCode } from '../../../utils/errors/RadioError.js';

type Activity = z.infer<typeof HamlibActivitySchema>;
type PortDefaults = { timeout?: number; retry?: number; writeDelay?: number; postWriteDelay?: number };
// Instrument only the declared native I/O surface, including the spectrum controller's calls.
const NATIVE_IO_METHODS = [
  'close', 'getAgcLevels', 'getAttenuatorValues', 'getAvailableCtcssTones', 'getAvailableDcsCodes',
  'getConf', 'getCtcssTone', 'getDcd', 'getDcsCode', 'getFilterList', 'getFrequency', 'getFrequencyRanges',
  'getFunction', 'getLevel', 'getLockMode', 'getMaxRit', 'getMaxXit', 'getMode', 'getSupportedModes', 'getRfPowerStepTable', 'getPassbandNarrow',
  'getPassbandNormal', 'getPassbandWide', 'getPowerstat', 'getPreampValues', 'getPtt', 'getRepeaterOffset',
  'getRepeaterShift', 'getRit', 'getSplit', 'getSplitFreq', 'getSupportedFunctions', 'getSupportedLevels',
  'getSupportedParms', 'getSupportedVfoOps', 'getTuningStep', 'getTuningSteps', 'getXit', 'open', 'sendMorse', 'sendRaw',
  'sendRawWrite', 'setConf', 'setCtcssTone', 'setDcsCode', 'setFrequency', 'setFunction', 'setLevel',
  'setLockMode', 'setMode', 'setPowerstat', 'setPtt', 'setPttType', 'setRepeaterOffset', 'setRepeaterShift',
  'setRit', 'setSplit', 'setSplitFreq', 'setSplitFreqMode', 'setSplitMode', 'setTuningStep', 'setXit',
  'stopMorse', 'vfoOperation', 'waitMorse', 'getSpectrumCapabilities', 'startSpectrumStream', 'stopSpectrumStream',
] as const satisfies readonly (keyof HamLib)[];

export function nativeOperationBudget(operation: string, args: readonly unknown[], config?: HamlibConfig, defaults?: PortDefaults): number {
  const backend = config?.serial?.backendConfig;
  const timeout = Number(backend?.timeout ?? config?.serial?.serialConfig?.timeout ?? defaults?.timeout ?? 0);
  const retry = Number(backend?.retry ?? config?.serial?.serialConfig?.retry ?? defaults?.retry ?? 0);
  const delay = Number(backend?.write_delay ?? config?.serial?.serialConfig?.write_delay ?? defaults?.writeDelay ?? 0)
    + Number(backend?.post_write_delay ?? config?.serial?.serialConfig?.post_write_delay ?? defaults?.postWriteDelay ?? 0);
  const configured = Number.isFinite(timeout) && Number.isFinite(retry) && Number.isFinite(delay)
    ? Math.max(0, timeout) * (Math.max(0, retry) + 1) + Math.max(0, delay) + 1000 : 0;
  let minimum = 5000;
  if (operation === 'open' || operation === 'vfoOperation') minimum = 10000;
  if (operation === 'setPowerstat') minimum = args[0] === 1 ? 20000 : 8000;
  if (operation === 'waitMorse') minimum = 120000;
  return Math.max(minimum, configured);
}

export class HamlibNativeMonitor {
  private sequence = 0;
  private active = new Map<number, Activity>();
  private fault: RadioError | null = null;
  private portDefaults: PortDefaults | undefined;

  constructor(
    private readonly config: () => HamlibConfig | undefined,
    private readonly changed: () => void,
    private readonly failed: (error: RadioError) => void,
  ) {}

  get activities(): Activity[] { return [...this.active.values()]; }
  get failure(): RadioError | null { return this.fault; }
  assertUsable(): void { if (this.fault) throw this.fault; }
  setPortDefaults(defaults: PortDefaults): void { this.portDefaults = defaults; }
  budget(operation: string, args: readonly unknown[] = []): number { return nativeOperationBudget(operation, args, this.config(), this.portDefaults); }

  poison(error: unknown, operation: string): void {
    if (this.fault) return;
    this.fault = new RadioError({ code: RadioErrorCode.OPERATION_TIMEOUT,
      message: `Hamlib host failed during ${operation}: ${error instanceof Error ? error.message : String(error)}`,
      userMessage: 'Hamlib stopped making progress', userMessageKey: 'radio:error.hamlibHostFailed',
      context: { operation, protocol: 'hamlib', hamlibHostFatal: true, stateUncertain: true } });
    this.failed(this.fault);
    this.changed();
  }

  async run<T>(operation: string, task: () => T | Promise<T>, args: readonly unknown[] = []): Promise<T> {
    this.assertUsable();
    const id = ++this.sequence;
    const timeoutMs = this.budget(operation, args);
    this.active.set(id, { id, operation, timeoutMs, startedAt: Date.now() });
    this.changed();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.poison(new Error(`native operation exceeded ${timeoutMs}ms`), operation);
        reject(this.fault);
      }, timeoutMs);
    });
    // Only native settlement clears activity; a timeout cannot make late I/O safe.
    const native = Promise.resolve().then(task).finally(() => {
      this.active.delete(id);
      if (timer) clearTimeout(timer);
      this.changed();
    });
    try {
      return await Promise.race([native, deadline]);
    } catch (error) {
      if (error instanceof Error && error.message.includes('HAMLIB_GLOBAL_LOCK_TIMEOUT')) this.poison(error, operation);
      throw error;
    }
  }

  instrument<T extends object>(rig: T): T {
    for (const method of NATIVE_IO_METHODS) {
      const original = (rig as unknown as HamLib)[method];
      if (typeof original !== 'function') continue;
      Object.defineProperty(rig, method, { configurable: true, value: (...args: unknown[]) =>
        this.run(method, () => (original as (...args: unknown[]) => unknown).apply(rig, args), args) });
    }
    return rig;
  }
}
