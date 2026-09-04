import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';

const hostRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const externalRoot = path.resolve(process.env.TX5DR_PLUGINS_ROOT ?? path.join(hostRoot, '..', 'tx-5dr-plugins'));
const targetRoot = path.resolve(process.env.TX5DR_DEV_PLUGINS_DIR ?? path.join(hostRoot, '.dev', 'plugins'));

async function listMarketplacePlugins() {
  const entries = await fs.readdir(externalRoot, { withFileTypes: true });
  const plugins = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const packagePath = path.join(externalRoot, entry.name, 'package.json');
    try {
      const pkg = JSON.parse(await fs.readFile(packagePath, 'utf8'));
      if (pkg.tx5drPlugin?.pluginName === entry.name) plugins.push(entry.name);
    } catch {
      // Private shared packages and incomplete directories are ignored.
    }
  }
  return plugins.sort();
}

async function linkPlugin(name) {
  const source = path.join(externalRoot, name, 'dist');
  const target = path.join(targetRoot, name);
  const entry = ['plugin.js', 'plugin.mjs', 'index.js', 'index.mjs']
    .find((candidate) => {
      return existsSync(path.join(source, candidate));
    });
  if (!entry) return false;
  const existing = await fs.lstat(target).catch(() => null);
  if (existing && !existing.isSymbolicLink()) {
    throw new Error(`Refusing to replace non-symlink development plugin directory: ${target}`);
  }
  if (existing) await fs.unlink(target);
  await fs.symlink(source, target, 'junction');
  return true;
}

const plugins = await listMarketplacePlugins();
if (plugins.length === 0) throw new Error(`No Marketplace plugin packages found under ${externalRoot}`);
await fs.mkdir(targetRoot, { recursive: true });
const linked = [];
for (const name of plugins) if (await linkPlugin(name)) linked.push(name);
if (linked.length === 0) throw new Error(`No built Marketplace plugin artifacts found under ${externalRoot}`);
console.log(`Linked ${linked.length} Marketplace plugin(s) from ${externalRoot} into ${targetRoot}.`);
console.log(`Run the Host with TX5DR_PLUGINS_DIR=${targetRoot} and rescan plugins to load them.`);
