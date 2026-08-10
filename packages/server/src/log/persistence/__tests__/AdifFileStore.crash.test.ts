import { fork } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AdifFileStore,
  type AdifFileStoreFaultPoint,
} from '../AdifFileStore.js';

type CrashOperation = 'append' | 'rewrite';

interface CrashChildMessage {
  type: 'reached' | 'failed';
  point?: AdifFileStoreFaultPoint;
  message?: string;
}

const CRASH_HARNESS_TIMEOUT_MS = 15_000;
const crashChildEntry = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'adif-file-store-crash-child.ts',
);

function adifRecord(call: string, id = call): string {
  return `<CALL:${call.length}>${call}<APP_TX5DR_ID:${id.length}>${id}`
    + '<QSO_DATE:8>20260810<TIME_ON:6>010203<MODE:3>FT8<FREQ:9>14.074000<EOR>';
}

async function killChildAtFaultPoint(
  filePath: string,
  operation: CrashOperation,
  point: AdifFileStoreFaultPoint,
  payload: Buffer,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = fork(
      crashChildEntry,
      [filePath, operation, point, payload.toString('base64')],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: 'test' },
        execArgv: ['--import', 'tsx'],
        serialization: 'advanced',
        silent: true,
      },
    );
    let reached = false;
    let stderr = '';
    let settled = false;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => { stderr += String(chunk); });

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeAllListeners();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`Crash child did not reach ${point}: ${stderr}`));
    }, CRASH_HARNESS_TIMEOUT_MS);

    child.on('message', (value: unknown) => {
      const message = value as Partial<CrashChildMessage> | undefined;
      if (message?.type === 'failed') {
        child.kill('SIGKILL');
        finish(new Error(message.message ?? `Crash child failed before ${point}`));
        return;
      }
      if (message?.type !== 'reached' || message.point !== point) return;
      reached = true;
      if (!child.kill('SIGKILL')) {
        finish(new Error(`Could not SIGKILL crash child at ${point}`));
      }
    });
    child.once('error', error => finish(error));
    child.once('exit', (code, signal) => {
      const killedAsRequested = signal === 'SIGKILL' || process.platform === 'win32';
      if (!reached || !killedAsRequested) {
        finish(new Error(
          `Crash child exited before deterministic kill at ${point} (code=${code}, signal=${signal}): ${stderr}`,
        ));
        return;
      }
      finish();
    });
  });
}

describe('AdifFileStore process-crash durability', () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  async function createLogbook(content: string): Promise<{ directory: string; filePath: string }> {
    const directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-adif-crash-'));
    tempDirectories.push(directory);
    const filePath = path.join(directory, 'station.adi');
    await writeFile(filePath, content);
    return { directory, filePath };
  }

  it.each([
    ['append-after-write', false],
    ['append-after-fsync', true],
  ] as const)('reopens a complete append after SIGKILL at %s', async (point, mustContainAppend) => {
    const original = `${adifRecord('BG5QA')}`;
    const appended = `\n${adifRecord('BG5QB')}\n`;
    const { directory, filePath } = await createLogbook(original);

    await killChildAtFaultPoint(filePath, 'append', point, Buffer.from(appended));

    const reopened = new AdifFileStore(filePath);
    const firstOpen = await reopened.open();
    const content = await readFile(filePath, 'utf8');
    expect([original, original + appended]).toContain(content);
    expect(firstOpen.scan?.incompleteTailRange).toBeUndefined();
    expect(firstOpen.scan?.records).toHaveLength(content === original ? 1 : 2);
    if (mustContainAppend) expect(content).toBe(original + appended);
    await reopened.close();

    const converged = new AdifFileStore(filePath);
    await expect(converged.open()).resolves.toMatchObject({ status: 'ready' });
    await converged.close();
    expect(await readFile(filePath, 'utf8')).toBe(content);
    expect(await readdir(directory)).toEqual(['station.adi']);
  }, 30_000);

  it.each([
    ['rewrite-after-last-good-rename', 'old'],
    ['rewrite-after-main-rename', 'new'],
  ] as const)('converges a SIGKILLed rewrite at %s to one complete version', async (point, expectedVersion) => {
    const original = `${adifRecord('BG5RA')}\n`;
    const replacement = `${adifRecord('BG5RB')}\n`;
    const { filePath } = await createLogbook(original);

    await killChildAtFaultPoint(filePath, 'rewrite', point, Buffer.from(replacement));

    const reopened = new AdifFileStore(filePath);
    const firstOpen = await reopened.open();
    const expected = expectedVersion === 'old' ? original : replacement;
    expect(await readFile(filePath, 'utf8')).toBe(expected);
    expect(firstOpen.scan?.records).toHaveLength(1);
    expect(firstOpen.scan?.incompleteTailRange).toBeUndefined();
    await reopened.close();

    const converged = new AdifFileStore(filePath);
    await expect(converged.open()).resolves.toMatchObject({ status: 'ready' });
    await converged.close();
    expect(await readFile(filePath, 'utf8')).toBe(expected);
    expect((await readdir(converged.recoveryDirectory)).sort()).toEqual(['last-good.adi']);
  }, 30_000);

  it('keeps artifacts bounded through 100 rewrite and interrupted-recovery cycles', async () => {
    const first = `${adifRecord('BG5SA')}\n`;
    const second = `${adifRecord('BG5SB')}\n`;
    const { directory, filePath } = await createLogbook(first);
    const paths = new AdifFileStore(filePath);
    const topLevelUnknown = path.join(directory, 'operator-notes.keep');
    const recoveryUnknown = path.join(paths.recoveryDirectory, 'manual-recovery.keep');
    await writeFile(topLevelUnknown, 'operator-owned');
    await mkdir(paths.recoveryDirectory, { recursive: true });
    await writeFile(recoveryUnknown, 'operator-owned recovery note');

    for (let index = 0; index < 100; index += 1) {
      const next = index % 2 === 0 ? second : first;
      const writer = new AdifFileStore(filePath);
      const opened = await writer.open();
      await writer.commitRewrite([Buffer.from(next)], opened.generation, { recordCount: 1 });
      await writer.close();

      await copyFile(filePath, paths.rewriteTempPath);
      await writeFile(filePath, `interrupted-main-${index}`);
      const recovery = new AdifFileStore(filePath);
      await expect(recovery.open()).resolves.toMatchObject({
        status: 'degraded',
        recoveredFrom: 'rewrite.tmp',
        scan: { records: [expect.any(Object)] },
      });
      await recovery.close();

      expect(await readFile(filePath, 'utf8')).toBe(next);
      expect((await readdir(paths.recoveryDirectory)).sort()).toEqual([
        'last-good.adi',
        'manual-recovery.keep',
      ]);
    }

    const stable = new AdifFileStore(filePath);
    await expect(stable.open()).resolves.toMatchObject({ status: 'ready' });
    await stable.close();

    expect(await readFile(topLevelUnknown, 'utf8')).toBe('operator-owned');
    expect(await readFile(recoveryUnknown, 'utf8')).toBe('operator-owned recovery note');
    const topLevel = (await readdir(directory)).sort();
    expect(topLevel).toEqual(['.tx5dr-recovery', 'operator-notes.keep', 'station.adi']);
    expect(topLevel.filter(name => name !== '.tx5dr-recovery' && name !== 'operator-notes.keep'))
      .toEqual(['station.adi']);
    expect((await readdir(paths.recoveryDirectory)).sort()).toEqual([
      'last-good.adi',
      'manual-recovery.keep',
    ]);
  }, 60_000);
});
