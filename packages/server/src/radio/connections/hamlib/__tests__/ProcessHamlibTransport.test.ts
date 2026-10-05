import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { ProcessHamlibTransport } from '../ProcessHamlibTransport.js';

const hosts = new Set<ProcessHamlibTransport>();
const entry = { path: fileURLToPath(new URL('./fixtures/worker.ts', import.meta.url)), execArgv: ['--import', 'tsx'] };
const host = () => {
  const value = new ProcessHamlibTransport({ entry, shutdownGraceMs: 20, heartbeatTimeoutMs: 300 });
  hosts.add(value);
  return value;
};
const config = (mode: string) => ({ type: 'network', network: { host: mode, port: 4532 } });
afterEach(async () => { await Promise.all([...hosts].map(value => value.close())); hosts.clear(); });

describe('ProcessHamlibTransport', () => {
  it('rejects invalid operation arguments without starting a worker', async () => {
    const transport = host();
    await expect(transport.call('getFrequency', [1])).rejects.toThrow();
    expect(transport.diagnostics.pid).toBeUndefined();
  });

  it('ignores old generations and terminates its process on close', async () => {
    const transport = host();
    await transport.call('connect', [config('normal'), undefined]);
    await expect(transport.call('getFrequency', [])).resolves.toBe(7100000);
    const pid = transport.diagnostics.pid as number;
    await transport.close();
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it.each(['hang', 'block', 'crash'])('recovers from %s only after the old process has exited', async mode => {
    const transport = host();
    await transport.call('connect', [config(mode), undefined]);
    const pid = transport.diagnostics.pid as number;
    const oldGeneration = transport.generation;
    await expect(transport.call('getFrequency', [])).rejects.toMatchObject({ context: { hamlibHostFatal: true } });
    const replacement = host();
    await replacement.call('connect', [config('normal'), undefined]);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(replacement.generation).not.toBe(oldGeneration);
    await expect(replacement.call('getFrequency', [])).resolves.toBe(7100000);
  });

  it('transports binary spectrum while control replies keep making progress', async () => {
    const transport = host();
    const frames: Buffer[] = [];
    transport.on('event', event => { if (event.event === 'spectrumLine') frames.push(event.args[0].data); });
    await transport.call('connect', [config('normal'), undefined]);
    await transport.call('startManagedSpectrum', [undefined]);
    await new Promise(resolve => setTimeout(resolve, 100));
    await expect(transport.call('getFrequency', [])).resolves.toBe(7100000);
    await transport.call('stopManagedSpectrum', []);
    expect(frames.length).toBeGreaterThan(0);
    expect(Buffer.isBuffer(frames[0])).toBe(true);
    expect(frames[0].length).toBe(2048);
  });
});
