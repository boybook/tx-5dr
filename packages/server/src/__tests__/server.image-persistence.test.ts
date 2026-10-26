import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const dirs: string[] = [];
const serverUrl = new URL('../server.ts', import.meta.url).href;
const engineUrl = new URL('../DigitalRadioEngine.ts', import.meta.url).href;
const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
const cases = [
  ['index.json', 'artifacts'], ['history.json', 'records'], ['templates.json', 'templates'],
  ['composer-backgrounds.json', 'backgrounds'], ['sstv-tx-preferences.json', 'preferences'],
] as const;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('server readiness with optional image persistence failures (isolated processes, no radio)', () => {
  it.each(cases)('serves core/status endpoints with %s damaged or unsupported', async (file, collection) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-startup-image-'));
    dirs.push(dir);
    for (const subdir of ['config', 'data/image-radio', 'cache', 'logs']) await mkdir(path.join(dir, subdir), { recursive: true });
    const damagedPath = path.join(dir, 'data/image-radio', file);
    // Both recoverable corruption and a failure that must remain unavailable are
    // exercised through the real createServer chain, not a mocked coordinator.
    for (const future of [false, true]) {
      const mode = future ? 'SSTV' : 'FAX';
      const raw = future ? JSON.stringify({ schemaVersion: 99, [collection]: [] }) : 'broken';
      await writeFile(damagedPath, raw);
      await writeFile(path.join(dir, 'config/runtime-state.json'), JSON.stringify({ lastEngineMode: 'image', lastImageFrequency: { frequency: 14230000, mode } }));
      const program = `
        const { createServer } = await import(${JSON.stringify(serverUrl)});
        const { DigitalRadioEngine } = await import(${JSON.stringify(engineUrl)});
        const app = await createServer();
        await app.listen({ host: '127.0.0.1', port: 0 });
        const core = await app.inject('/api/hello');
        const status = await app.inject('/api/image-radio/status');
        const history = await app.inject('/api/image-radio/history');
        process.stdout.write('IMAGE_BOOT_RESULT ' + JSON.stringify({ core: core.statusCode, status: status.statusCode,
          history: history.statusCode, persistence: status.json().status.persistence,
          mode: DigitalRadioEngine.getInstance().getStatus().currentMode.name }) + '\\n');
        await app.close();
        process.exit(0);
      `;
      const result = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program], {
        cwd: serverRoot, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, NODE_ENV: 'test', RIGCTLD_ENABLED: 'false',
          TX5DR_CONFIG_DIR: path.join(dir, 'config'), TX5DR_DATA_DIR: path.join(dir, 'data'),
          TX5DR_CACHE_DIR: path.join(dir, 'cache'), TX5DR_LOGS_DIR: path.join(dir, 'logs') },
      });
      const line = result.stdout.split('\n').find(line => line.startsWith('IMAGE_BOOT_RESULT '));
      expect(line).toBeDefined();
      const outcome = JSON.parse(line!.slice('IMAGE_BOOT_RESULT '.length));
      expect(outcome).toMatchObject({ core: 200, status: 200, history: future ? 503 : 200, persistence: { available: !future }, mode });
      if (future) expect(await readFile(damagedPath, 'utf8')).toBe(raw);
    }
  }, 65000);
});
