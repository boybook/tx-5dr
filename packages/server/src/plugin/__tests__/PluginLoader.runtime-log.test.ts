import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginLoader, type PluginLoaderRuntimeLogEvent } from '../PluginLoader.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createPluginRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-loader-log-'));
  tempDirs.push(root);
  return root;
}

describe('PluginLoader runtime logs', () => {
  it('emits load attempt and success logs for a valid plugin', async () => {
    const pluginRoot = await createPluginRoot();
    const pluginDir = join(pluginRoot, 'hello-plugin');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'index.mjs'), `
      export default {
        name: 'hello-plugin',
        version: '1.0.0',
        type: 'utility',
      };
    `, 'utf8');

    const runtimeLogs: PluginLoaderRuntimeLogEvent[] = [];
    const loader = new PluginLoader((entry) => runtimeLogs.push(entry));
    const loaded = await loader.scanAndLoad(pluginRoot);

    expect(loaded).toHaveLength(1);
    expect(runtimeLogs.some((entry) =>
      entry.stage === 'scan'
      && entry.level === 'info'
      && entry.message.includes('Scanning plugin directory'))).toBe(true);
    expect(runtimeLogs.some((entry) =>
      entry.stage === 'load'
      && entry.level === 'info'
      && entry.directoryName === 'hello-plugin'
      && entry.message.includes('Attempting to load plugin directory'))).toBe(true);
    expect(runtimeLogs.some((entry) =>
      entry.stage === 'load'
      && entry.level === 'info'
      && entry.pluginName === 'hello-plugin'
      && entry.message.includes('Plugin loaded'))).toBe(true);
  });

  it('emits actionable error log when entry file is missing', async () => {
    const pluginRoot = await createPluginRoot();
    const pluginDir = join(pluginRoot, 'missing-entry');
    await mkdir(pluginDir, { recursive: true });

    const runtimeLogs: PluginLoaderRuntimeLogEvent[] = [];
    const loader = new PluginLoader((entry) => runtimeLogs.push(entry));
    const loaded = await loader.scanAndLoad(pluginRoot);

    expect(loaded).toHaveLength(0);
    const errorLog = runtimeLogs.find((entry) =>
      entry.stage === 'load'
      && entry.level === 'error'
      && entry.directoryName === 'missing-entry');
    expect(errorLog).toBeDefined();
    expect(errorLog?.message).toContain('No entry file found');
    expect((errorLog?.details as { candidates?: string[] } | undefined)?.candidates).toEqual([
      'plugin.js',
      'plugin.mjs',
      'index.js',
      'index.mjs',
    ]);
  });

  it('emits load-stage error when entry import fails', async () => {
    const pluginRoot = await createPluginRoot();
    const pluginDir = join(pluginRoot, 'broken-import');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'index.mjs'), 'export default {', 'utf8');

    const runtimeLogs: PluginLoaderRuntimeLogEvent[] = [];
    const loader = new PluginLoader((entry) => runtimeLogs.push(entry));
    const loaded = await loader.scanAndLoad(pluginRoot);

    expect(loaded).toHaveLength(0);
    const errorLog = runtimeLogs.find((entry) =>
      entry.stage === 'load'
      && entry.level === 'error'
      && entry.directoryName === 'broken-import');
    expect(errorLog).toBeDefined();
    expect(errorLog?.message).toContain('Failed to import plugin entry module');
  });

  it('emits validate-stage error for invalid plugin definition', async () => {
    const pluginRoot = await createPluginRoot();
    const pluginDir = join(pluginRoot, 'invalid-definition');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'index.mjs'), `
      export default {
        name: 'invalid-definition',
        version: '1.0.0',
        type: 'utility',
        quickSettings: [{ settingKey: 'missing-setting' }],
      };
    `, 'utf8');

    const runtimeLogs: PluginLoaderRuntimeLogEvent[] = [];
    const loader = new PluginLoader((entry) => runtimeLogs.push(entry));
    const loaded = await loader.scanAndLoad(pluginRoot);

    expect(loaded).toHaveLength(0);
    const errorLog = runtimeLogs.find((entry) =>
      entry.stage === 'validate'
      && entry.level === 'error'
      && entry.directoryName === 'invalid-definition');
    expect(errorLog).toBeDefined();
    expect(errorLog?.message).toContain('Plugin definition validation failed');
  });

  it('emits validate-stage error when iframe panel references unknown ui page', async () => {
    const pluginRoot = await createPluginRoot();
    const pluginDir = join(pluginRoot, 'invalid-ui-page-ref');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'index.mjs'), `
      export default {
        name: 'invalid-ui-page-ref',
        version: '1.0.0',
        type: 'utility',
        panels: [
          { id: 'dashboard-panel', title: 'Dashboard', component: 'iframe', pageId: 'dashboard' },
        ],
        ui: {
          dir: 'ui',
          pages: [
            { id: 'settings', title: 'Settings', entry: 'settings.html' },
          ],
        },
      };
    `, 'utf8');

    const runtimeLogs: PluginLoaderRuntimeLogEvent[] = [];
    const loader = new PluginLoader((entry) => runtimeLogs.push(entry));
    const loaded = await loader.scanAndLoad(pluginRoot);

    expect(loaded).toHaveLength(0);
    const errorLog = runtimeLogs.find((entry) =>
      entry.stage === 'validate'
      && entry.level === 'error'
      && entry.directoryName === 'invalid-ui-page-ref');
    expect(errorLog).toBeDefined();
    expect(errorLog?.message).toContain('references unknown ui page');
  });

  it('emits validate-stage error when custom ui entry html file is missing', async () => {
    const pluginRoot = await createPluginRoot();
    const pluginDir = join(pluginRoot, 'missing-ui-entry');
    await mkdir(join(pluginDir, 'ui'), { recursive: true });
    await writeFile(join(pluginDir, 'index.mjs'), `
      export default {
        name: 'missing-ui-entry',
        version: '1.0.0',
        type: 'utility',
        panels: [
          { id: 'dashboard-panel', title: 'Dashboard', component: 'iframe', pageId: 'dashboard' },
        ],
        ui: {
          dir: 'ui',
          pages: [
            { id: 'dashboard', title: 'Dashboard', entry: 'dashboard.html' },
          ],
        },
      };
    `, 'utf8');

    const runtimeLogs: PluginLoaderRuntimeLogEvent[] = [];
    const loader = new PluginLoader((entry) => runtimeLogs.push(entry));
    const loaded = await loader.scanAndLoad(pluginRoot);

    expect(loaded).toHaveLength(0);
    const errorLog = runtimeLogs.find((entry) =>
      entry.stage === 'validate'
      && entry.level === 'error'
      && entry.directoryName === 'missing-ui-entry');
    expect(errorLog).toBeDefined();
    expect(errorLog?.message).toContain('UI page entry file not found');
  });

  it('emits locale parse warning but still loads plugin', async () => {
    const pluginRoot = await createPluginRoot();
    const pluginDir = join(pluginRoot, 'bad-locale');
    await mkdir(join(pluginDir, 'locales'), { recursive: true });
    await writeFile(join(pluginDir, 'index.mjs'), `
      export default {
        name: 'bad-locale',
        version: '1.0.0',
        type: 'utility',
      };
    `, 'utf8');
    await writeFile(join(pluginDir, 'locales', 'en.json'), '{ invalid json', 'utf8');

    const runtimeLogs: PluginLoaderRuntimeLogEvent[] = [];
    const loader = new PluginLoader((entry) => runtimeLogs.push(entry));
    const loaded = await loader.scanAndLoad(pluginRoot);

    expect(loaded).toHaveLength(1);
    const warnLog = runtimeLogs.find((entry) =>
      entry.stage === 'validate'
      && entry.level === 'warn'
      && entry.pluginName === 'bad-locale');
    expect(warnLog).toBeDefined();
    expect(warnLog?.message).toContain('Failed to parse plugin locale file');
  });
});
