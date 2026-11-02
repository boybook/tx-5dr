import net from 'node:net';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { RigctldServer, type RadioController, type RigctlMode } from '@tx5dr/rigctld-server';
import { HamlibConnection } from '../connections/HamlibConnection.js';

it('uses the native NET backend against an external protocol endpoint with delay, rejection and reconnect', async () => {
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = (listener.address() as net.AddressInfo).port; await new Promise<void>(resolve => listener.close(() => resolve()));
  let frequency = 14074000, mode: RigctlMode = 'USB', bandwidthHz = 3000, ptt = false;
  const writes: string[] = [];
  const controller: RadioController = {
    getFrequency: async () => frequency,
    setFrequency: async value => { await new Promise(resolve => setTimeout(resolve, 40)); frequency = value; writes.push('frequency'); },
    getMode: async () => ({ mode, bandwidthHz }),
    setMode: async (value, bandwidth) => { mode = value; bandwidthHz = bandwidth; writes.push('mode'); },
    getPTT: async () => ptt, setPTT: async value => { ptt = value; writes.push('ptt'); },
    getVFO: async () => 'VFOA', setVFO: async () => {},
    getInfo: async () => 'External protocol fixture',
  };
  const endpoint = new RigctldServer({ controller, port, identity: { rigModel: 1, modelName: 'Dummy', mfgName: 'Hamlib' } });
  const connection = new HamlibConnection();
  const config = { type: 'network' as const, network: { host: '127.0.0.1', port }, pttMethod: 'cat' as const };
  try {
    await endpoint.listen(); await connection.connect(config);
    writes.length = 0;
    await Promise.all([connection.setFrequency(7074000), connection.setMode('LSB', 2400)]);
    expect(writes.slice(0, 2)).toEqual(['frequency', 'mode']);
    expect(await connection.getFrequency()).toBe(7074000);
    expect(await connection.getMode()).toMatchObject({ mode: 'LSB', bandwidth: 2400 });
    await connection.setPTT(true); expect(await connection.getPTT()).toBe(true);
    await connection.setPTT(false); expect(await connection.getPTT()).toBe(false);
    endpoint.setReadOnly(true);
    await expect(connection.setFrequency(14080000)).rejects.toThrow();
    expect(frequency).toBe(7074000);
    await endpoint.close();
    await expect(connection.setPTT(true)).rejects.toThrow();
    await connection.disconnect('endpoint lost');
    endpoint.setReadOnly(false); await endpoint.listen(); await connection.connect(config);
    expect(await connection.getFrequency()).toBe(7074000);
  } finally { await connection.disconnect('protocol regression complete'); await endpoint.close(); }
}, 30000);
