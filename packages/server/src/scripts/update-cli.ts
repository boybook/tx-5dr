import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { UpdatePreferencesSchema } from '@tx5dr/contracts';
import { compareUpdateVersions, fetchChannelManifest } from '@tx5dr/core';
import { getUpdatePreferences, setUpdatePreferences } from '../services/UpdatePreferences.js';
import { tx5drPaths } from '../utils/app-paths.js';
import { SERVER_BUILD_INFO } from '../generated/buildInfo.js';

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => { const i = args.indexOf(name); if (i < 0) return undefined; if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing ${name} value`); return args[i + 1]; };
  for (let i = 0; i < args.length; i++) {
    if (['--channel', '--version'].includes(args[i])) { i++; continue; }
    if (!['--yes', '--allow-downgrade', '--force', '--check'].includes(args[i])) throw new Error(`Unknown option: ${args[i]}`);
  }
  const channel = UpdatePreferencesSchema.parse({ channel: option('--channel') ?? (await getUpdatePreferences()).channel }).channel;
  const base = (process.env.TX5DR_DOWNLOAD_BASE_URL || 'https://dl.tx5dr.com').replace(/\/$/, '');
  const version = option('--version');
  if (version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid version');
  const manifest = (await fetchChannelManifest('server', channel, base, version)).manifest;
  if (manifest.product !== 'server' || manifest.channel !== channel || (version && manifest.version !== version)) throw new Error('Manifest does not match requested target');
  const downgrade = compareUpdateVersions(manifest.version, SERVER_BUILD_INFO.version) < 0;
  process.stdout.write(`${SERVER_BUILD_INFO.version} (${SERVER_BUILD_INFO.channel}) -> ${manifest.version} (${channel})\n`);
  if (args.includes('--check')) return;
  if (process.getuid?.() !== 0) throw new Error('Run with sudo');
  if (downgrade && !args.includes('--allow-downgrade')) throw new Error('Older version: review data compatibility, then pass --allow-downgrade to force the switch after backup');
  if (!args.includes('--force') && channel === SERVER_BUILD_INFO.channel && manifest.version === SERVER_BUILD_INFO.version) { process.stdout.write('Already installed. Use --force to reinstall.\n'); return; }
  if (!args.includes('--yes')) {
    if (!process.stdin.isTTY) throw new Error('Interactive confirmation required; use --yes (downgrades also require --allow-downgrade)');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { if ((await rl.question('Stop service, back up data, install and restart? [y/N] ')).toLowerCase() !== 'y') return; } finally { rl.close(); }
  }
  const os = await fs.readFile('/etc/os-release', 'utf8');
  const packageType = /(?:debian|ubuntu)/i.test(os) ? 'deb' : 'rpm';
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const asset = manifest.assets.find(item => item.platform === 'linux' && item.arch === arch && item.package_type === packageType);
  if (!asset) throw new Error('No matching Linux server package');
  await fs.mkdir(await tx5drPaths.getCacheDir(), { recursive: true });
  const cache = await fs.mkdtemp(path.join(await tx5drPaths.getCacheDir(), 'update-'));
  const packagePath = path.join(cache, asset.name);
  try {
    let verified = false;
    let downloadError: unknown;
    const urls = [...new Set([asset.url_cn || asset.url, asset.url_github || asset.url_global].filter((url): url is string => Boolean(url)))];
    for (const url of urls) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(600000) });
        if (!response.ok || !response.body) throw new Error(`Package HTTP ${response.status}`);
        await pipeline(Readable.fromWeb(response.body as never), createWriteStream(packagePath, { mode: 0o600 }));
        const hash = createHash('sha256');
        for await (const chunk of (await import('node:fs')).createReadStream(packagePath)) hash.update(chunk);
        if ((await fs.stat(packagePath)).size !== asset.size || hash.digest('hex') !== asset.sha256.toLowerCase()) throw new Error('Package checksum or size mismatch');
        verified = true; break;
      } catch (error) { downloadError = error; }
    }
    if (!verified) throw downloadError ?? new Error('No verified package source');
    const data = await tx5drPaths.getDataDir(); const config = await tx5drPaths.getConfigDir();
    const backup = path.join(path.dirname(data), 'tx5dr-update-backups', new Date().toISOString().replace(/[:.]/g, '-'));
    await fs.mkdir(backup, { recursive: true, mode: 0o700 });
    execFileSync('systemctl', ['stop', 'tx5dr'], { stdio: 'inherit' });
    const shutdownResult = execFileSync('systemctl', ['show', 'tx5dr', '--property=Result', '--value'], { encoding: 'utf8' }).trim();
    if (shutdownResult !== 'success') throw new Error(`Service shutdown was not clean (${shutdownResult}); installation cancelled`);
    try {
      const roots = [...new Set([data, config, '/etc/tx5dr'])];
      const existing = [];
      for (const root of roots) { try { await fs.access(root); existing.push(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
      execFileSync('tar', ['-cpf', path.join(backup, 'data.tar'), '--', ...existing], { stdio: 'inherit' });
      execFileSync('tar', ['-tf', path.join(backup, 'data.tar')], { stdio: 'ignore' });
      await fs.writeFile(path.join(backup, 'backup.json'), JSON.stringify({ source: SERVER_BUILD_INFO, target: manifest.version, roots: existing }));
      await fs.writeFile(path.join(backup, 'RESTORE.txt'), `Preserve newer data before restoring. Restoring discards post-backup changes.
Reinstall the original program using the immutable release (if available):
sudo tx5dr update --channel ${SERVER_BUILD_INFO.channel} --version ${SERVER_BUILD_INFO.version} --allow-downgrade --force
Then stop the service and restore this snapshot explicitly:
sudo systemctl stop tx5dr
sudo tar -xpf '${path.join(backup, 'data.tar').replaceAll("'", "'\\''")}' -C /
sudo systemctl start tx5dr
Verify service health and the installed version before resuming operation.
`);
      // Keep the config directory owner when invoked through sudo.
      const owner = await fs.stat(config);
      await setUpdatePreferences({ channel });
      await fs.chown(path.join(config, 'update-preferences.json'), owner.uid, owner.gid);
      if (packageType === 'deb') execFileSync('dpkg', ['-i', packagePath], { stdio: 'inherit' });
      else execFileSync('rpm', ['-Uvh', ...(downgrade ? ['--oldpackage'] : []), packagePath], { stdio: 'inherit' });
      const installed = JSON.parse(await fs.readFile('/usr/share/tx5dr/packages/server/dist/generated/buildInfo.json', 'utf8'));
      if (installed.version !== manifest.version || installed.channel !== channel || !installed.commit.startsWith(manifest.commit)) throw new Error('Installed package identity does not match confirmed target');
      execFileSync('systemctl', ['start', 'tx5dr'], { stdio: 'inherit' });
      let healthy = false;
      for (let i = 0; i < 30; i++) {
        try { const response = await fetch(`http://127.0.0.1:${process.env.PORT || '4000'}/api/hello`, { signal: AbortSignal.timeout(1000) }); if (response.ok) { healthy = true; break; } } catch { /* startup */ }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      if (!healthy) throw new Error('Service health check failed');
      process.stdout.write(`Installed ${manifest.version}. Backup: ${backup}\n`);
    } catch (error) {
      process.stderr.write(`Update failed. Backup/recovery: ${backup}. Data has NOT been restored automatically.\n`);
      throw error;
    }
  } finally { await fs.rm(cache, { recursive: true, force: true }); }
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
