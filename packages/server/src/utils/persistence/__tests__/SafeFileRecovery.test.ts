import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadJsonWithRecovery, SafeFileWriter } from '../SafeFileWriter.js';

const dirs: string[] = [];
async function fixture() {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'strict-json-recovery-'));
  dirs.push(dir);
  return path.join(dir, 'config.json');
}
const options = { defaultValue: () => ({ name: 'default' }), validate: (value: unknown) => {
  if (!value || typeof value !== 'object' || !('name' in value) || typeof value.name !== 'string') throw new Error('invalid secret value');
  return value as { name: string };
} };
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true })));
});
describe('strict JSON recovery', () => {
  it('uses backup when main is missing, never replacing it with defaults', async () => {
    const file = await fixture();
    await fs.writeFile(`${file}.bak.1`, '{"name":"original"}');
    expect((await loadJsonWithRecovery(file, options)).value.name).toBe('original');
  });
  it('refuses default creation when only corrupt backups survive', async () => {
    const file = await fixture();
    await fs.writeFile(`${file}.bak.1`, 'invalid secret value');
    await expect(loadJsonWithRecovery(file, options)).rejects.toMatchObject({ name: 'JsonRecoveryError', causes: [expect.stringContaining('INVALID_JSON')] });
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not overwrite the original when its archive cannot be written', async () => {
    const file = await fixture();
    await fs.writeFile(file, 'broken');
    await fs.writeFile(`${file}.bak.1`, '{"name":"valid"}');
    vi.spyOn(SafeFileWriter.prototype, 'writeFile').mockRejectedValue(new Error('archive denied'));
    await expect(loadJsonWithRecovery(file, options)).rejects.toThrow('archive denied');
    expect(await fs.readFile(file, 'utf8')).toBe('broken');
  });
  it('does not treat access denial as an absent file', async () => {
    const file = await fixture();
    vi.spyOn(fs, 'readFile').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    const write = vi.spyOn(SafeFileWriter.prototype, 'writeFile');
    await expect(loadJsonWithRecovery(file, options)).rejects.toMatchObject({ code: 'EACCES' });
    expect(write).not.toHaveBeenCalled();
  });
  it('retries a transient Windows-style rename failure before committing', async () => {
    const file = await fixture();
    const rename = fs.rename.bind(fs);
    const mock = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EPERM' })).mockImplementationOnce(rename);
    await new SafeFileWriter({ retryDelayMs: 0 }).writeFile(file, '{"name":"valid"}');
    expect(mock).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(file, 'utf8')).toBe('{"name":"valid"}');
  });
});
