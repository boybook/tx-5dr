import { EventEmitter } from 'eventemitter3';
import { describe, expect, it, vi } from 'vitest';
import { RadioError, RadioErrorCode } from '../../../../utils/errors/RadioError.js';
import { LocalHamlibTransport } from '../HamlibTransport.js';
import { ProcessHamlibTransport } from '../ProcessHamlibTransport.js';

vi.mock('../HamlibEndpoint.js', () => ({
  HamlibEndpoint: class extends EventEmitter {
    publishSnapshot() {}
    async call(operation: string) {
      if (operation !== 'getFrequency') return undefined;
      const error = new RadioError({ code: RadioErrorCode.OPERATION_TIMEOUT, message: 'native call hung', context: { hamlibHostFatal: true } });
      this.emit('fault', error);
      throw error;
    }
  },
}));

describe('LocalHamlibTransport', () => {
  it('cannot bypass an unresolved in-process call by opening either execution mode', async () => {
    const original = new LocalHamlibTransport();
    await expect(original.call('getFrequency', [])).rejects.toThrow('native call hung');
    await original.close();
    const local = new LocalHamlibTransport();
    await expect(local.call('getFrequency', [])).rejects.toMatchObject({ context: { restartRequired: true } });
    const isolated = new ProcessHamlibTransport();
    await expect(isolated.call('connect', [{ type: 'serial', serial: { path: '/dev/null', rigModel: 1 } }, undefined])).rejects.toMatchObject({ context: { restartRequired: true } });
    expect(isolated.diagnostics.pid).toBeUndefined();
    await isolated.close();
  });
});
