import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { it, expect } from 'vitest';
it('refuses update handoff when the engine cannot stop, even if persistence flush succeeds', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tx5dr-shutdown-test-'));
  try {
    const program = `
      const {createServer}=await import(${JSON.stringify(new URL('../server.ts', import.meta.url).href)});
      const {DigitalRadioEngine}=await import(${JSON.stringify(new URL('../DigitalRadioEngine.ts', import.meta.url).href)});
      const app=await createServer();
      const denied=await app.inject({method:'POST',url:'/api/system/internal/prepare-shutdown'});
      const engine=DigitalRadioEngine.getInstance(); const status=engine.getStatus();
      engine.getStatus=()=>({...status,isRunning:true}); engine.stop=async()=>{throw new Error('injected stop failure')};
      const result=await app.inject({method:'POST',url:'/api/system/internal/prepare-shutdown',headers:{'x-tx5dr-internal-token':'test-only-token'}});
      process.stdout.write('UPDATE_SHUTDOWN '+JSON.stringify({denied:denied.statusCode,status:result.statusCode,body:result.json()})+'\\n');
      process.exit(0);
    `;
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program], {
      timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NODE_ENV: 'test', RIGCTLD_ENABLED: 'false', TX5DR_INTERNAL_SHUTDOWN_TOKEN: 'test-only-token',
        TX5DR_CONFIG_DIR: path.join(directory, 'config'), TX5DR_DATA_DIR: path.join(directory, 'data'), TX5DR_CACHE_DIR: path.join(directory, 'cache'), TX5DR_LOGS_DIR: path.join(directory, 'logs') },
    });
    const line = result.stdout.split('\n').find(value => value.startsWith('UPDATE_SHUTDOWN '));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice('UPDATE_SHUTDOWN '.length))).toMatchObject({ denied: 403, status: 500, body: { success: false, errors: [{ name: 'engine', error: 'injected stop failure' }] } });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 35000);
