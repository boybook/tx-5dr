import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const root = path.resolve(process.argv[2]);
const node = process.argv[3] || process.execPath;
const identity = JSON.parse(await fs.readFile(path.join(root, 'packages/server/dist/generated/buildInfo.json')));
if (process.env.SOURCE_SHA && identity.commit !== process.env.SOURCE_SHA) throw new Error('Packaged source identity mismatch');
let runtimeEnv = process.env;
if (identity.distribution === 'electron') {
  const require = createRequire(import.meta.url);
  const { buildChildRuntimeEnv } = require(path.join(root, 'packages/electron-main/dist/nativeRuntime.js'));
  runtimeEnv = buildChildRuntimeEnv({ resourcesRoot: path.dirname(root), triplet: `${process.platform}-${process.arch}` });
}
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'tx5dr-package-smoke-'));
const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const token = crypto.randomBytes(32).toString('hex');
let output = '';
const child = spawn(node, [path.join(root, 'packages/server/dist/index.js')], {
  cwd: path.join(root, 'packages/server/dist'), env: { ...runtimeEnv, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1',
    TX5DR_CONFIG_DIR: path.join(temporary, 'config'), TX5DR_DATA_DIR: path.join(temporary, 'data'),
    TX5DR_CACHE_DIR: path.join(temporary, 'cache'), TX5DR_LOGS_DIR: path.join(temporary, 'logs'),
    TX5DR_INTERNAL_SHUTDOWN_TOKEN: token, NODE_PATH: path.join(root, 'node_modules') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(child, 'exit');
child.stdout.on('data', data => { output = (output + data).slice(-12000); });
child.stderr.on('data', data => { output = (output + data).slice(-12000); });
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`Packaged server exited: ${child.exitCode}\n${output}`);
    try { const response = await fetch(`http://127.0.0.1:${port}/api/hello`, { signal: AbortSignal.timeout(500) }); if (response.ok) { ready = true; break; } } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error(`Packaged server startup timeout\n${output}`);
  const response = await fetch(`http://127.0.0.1:${port}/api/system/internal/prepare-shutdown`, { method: 'POST', headers: { 'x-tx5dr-internal-token': token }, signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`Packaged server shutdown preparation failed: ${response.status}`);
  process.stdout.write(`Packaged server startup and persistence drain passed: ${identity.version} ${identity.commit}\n`);
} finally {
  child.kill('SIGTERM');
  let timer;
  await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 45000); })]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await fs.rm(temporary, { recursive: true, force: true });
}
