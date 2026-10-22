import { createHamlibTransport, type HamlibExecutionMode } from '../HamlibConnection.js';
import type { HamlibOperation } from './hamlib-protocol.js';
import { HAMLIB_OPERATIONS } from './hamlib-protocol.js';
import type { z } from 'zod';

const cache = new Map<string, Promise<unknown>>();

async function query(operation: 'listSupportedRigs' | 'getRigMetadata', args: unknown[], mode: HamlibExecutionMode): Promise<unknown> {
  const key = `${mode}:${operation}:${args.join(',')}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = (async () => {
      const transport = createHamlibTransport(mode);
      try { return await transport.call(operation, args); }
      finally { await transport.close(); }
    })();
    cache.set(key, pending);
    void pending.catch(() => cache.delete(key));
  }
  return pending;
}

export async function listHamlibRigs(mode: HamlibExecutionMode = 'process') {
  return query('listSupportedRigs', [], mode) as Promise<z.infer<typeof HAMLIB_OPERATIONS.listSupportedRigs.result>>;
}

export async function getHamlibRigMetadata(model: number, mode: HamlibExecutionMode = 'process') {
  return query('getRigMetadata' satisfies HamlibOperation, [model], mode) as Promise<z.infer<typeof HAMLIB_OPERATIONS.getRigMetadata.result>>;
}
