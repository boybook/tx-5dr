import type { HamlibConfig } from '@tx5dr/contracts';

export type RadioExecutionOperation =
  | { kind: 'connect'; config: HamlibConfig }
  | { kind: 'transmit'; source: string }
  | { kind: 'capability-write'; id: string }
  | { kind: 'mode-write' }
  | { kind: 'power' };
export interface RadioExecutionPolicy {
  assert(operation: RadioExecutionOperation): void;
  validateTransmission?(): Promise<void>;
}
let policy: RadioExecutionPolicy | undefined;

/** Optional process-scoped restriction installed by the composition root. */
export function installRadioExecutionPolicy(next: RadioExecutionPolicy): () => void {
  if (policy) throw new Error('Radio execution policy already installed');
  policy = next;
  return () => { if (policy === next) policy = undefined; };
}
export function assertRadioExecution(operation: RadioExecutionOperation): void { policy?.assert(operation); }

/** Optional device readback, followed by a fresh permission check before TX. */
export function prepareRadioTransmission(source: string): Promise<void> | undefined {
  const current = policy;
  const operation = { kind: 'transmit', source } as const;
  current?.assert(operation);
  if (!current?.validateTransmission) return;
  return current.validateTransmission().then(() => {
    if (policy !== current) throw new Error('Radio execution policy changed during transmission preparation');
    current.assert(operation);
  });
}
