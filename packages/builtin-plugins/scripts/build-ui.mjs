#!/usr/bin/env node
// Auto-scan and build plugin UIs.
// Scans src/{plugin}/ui/vite.config.ts and runs vite build for each.
// Zero hardcoding - new plugins with UI are discovered automatically.
import { readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, '..', 'src');

const plugins = readdirSync(srcDir, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('_'))
  .filter(d => existsSync(join(srcDir, d.name, 'ui', 'vite.config.ts')));

if (plugins.length === 0) {
  console.log('No plugin UIs to build.');
  process.exit(0);
}

const isWatch = process.argv.includes('--watch');

for (const plugin of plugins) {
  const configPath = join(srcDir, plugin.name, 'ui', 'vite.config.ts');
  console.log(`Building UI: ${plugin.name}`);
  const watchFlag = isWatch ? ' --watch' : '';
  execSync(`npx vite build --config "${configPath}"${watchFlag}`, {
    cwd: join(srcDir, '..'),
    stdio: 'inherit',
  });
}

console.log(`Built ${plugins.length} plugin UI(s).`);
