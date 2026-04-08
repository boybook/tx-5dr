import type { PluginDefinition } from '@tx5dr/plugin-api';
import { PluginManifestSchema } from '@tx5dr/contracts';
import type { LoadedPlugin } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PluginLoader');

export function validatePluginDefinition(def: PluginDefinition): void {
  const manifest = PluginManifestSchema.parse({
    name: def.name,
    version: def.version,
    type: def.type,
    description: def.description,
    permissions: def.permissions,
    settings: def.settings,
    quickActions: def.quickActions,
    quickSettings: def.quickSettings,
    panels: def.panels,
    storage: def.storage,
  });

  if (manifest.type === 'strategy' && typeof def.createStrategyRuntime !== 'function') {
    throw new Error('Strategy plugins must provide createStrategyRuntime(ctx)');
  }
  if (manifest.type === 'utility' && def.createStrategyRuntime !== undefined) {
    throw new Error('Utility plugins must not provide createStrategyRuntime(ctx)');
  }

  for (const quickSetting of manifest.quickSettings ?? []) {
    const setting = manifest.settings?.[quickSetting.settingKey];
    if (!setting) {
      throw new Error(`Quick setting "${quickSetting.settingKey}" references missing setting`);
    }
    if (setting.scope !== 'operator') {
      throw new Error(`Quick setting "${quickSetting.settingKey}" must bind to an operator-scope setting`);
    }
    if (setting.type === 'info') {
      throw new Error(`Quick setting "${quickSetting.settingKey}" must not bind to an info setting`);
    }
  }
}

/**
 * 从文件系统扫描并加载用户插件
 * 每个子目录视为一个插件，入口文件为 plugin.js 或 index.js
 */
export class PluginLoader {
  async scanAndLoad(pluginDir: string): Promise<LoadedPlugin[]> {
    let entries: string[];
    try {
      const dirents = await fs.readdir(pluginDir, { withFileTypes: true });
      entries = dirents.filter(d => d.isDirectory()).map(d => d.name);
    } catch {
      logger.debug(`Plugin directory not found or empty: ${pluginDir}`);
      return [];
    }

    const results: LoadedPlugin[] = [];
    for (const name of entries) {
      const dirPath = path.join(pluginDir, name);
      try {
        const loaded = await this.loadPlugin(dirPath);
        results.push(loaded);
        logger.info(`Plugin loaded: ${loaded.definition.name} v${loaded.definition.version}`);
      } catch (err) {
        logger.error(`Failed to load plugin from ${dirPath}`, err);
      }
    }
    return results;
  }

  private async loadPlugin(dirPath: string): Promise<LoadedPlugin> {
    // 查找入口文件：plugin.js 优先，其次 index.js
    let entryPath: string | undefined;
    for (const candidate of ['plugin.js', 'plugin.mjs', 'index.js', 'index.mjs']) {
      try {
        const p = path.join(dirPath, candidate);
        await fs.access(p);
        entryPath = p;
        break;
      } catch {
        // 继续尝试
      }
    }

    if (!entryPath) {
      throw new Error(`No entry file found in plugin directory: ${dirPath}`);
    }

    // 动态加载 ESM 模块；附带 cache-busting 查询参数，确保 reload/rescan 真正拿到最新代码
    const entryUrl = pathToFileURL(path.resolve(entryPath));
    entryUrl.searchParams.set('ts5dr_reload', `${Date.now()}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(entryUrl.href);
    const definition: PluginDefinition = mod.default ?? mod;

    if (!definition || typeof definition !== 'object') {
      throw new Error(`Plugin entry must export a default PluginDefinition object`);
    }

    validatePluginDefinition(definition);

    // 加载 i18n 资源
    const locales = await this.loadLocales(dirPath);

    return {
      definition,
      isBuiltIn: false,
      dirPath,
      locales: Object.keys(locales).length > 0 ? locales : undefined,
    };
  }
  private async loadLocales(dirPath: string): Promise<Record<string, Record<string, string>>> {
    const localesDir = path.join(dirPath, 'locales');
    const result: Record<string, Record<string, string>> = {};
    try {
      const files = await fs.readdir(localesDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const lang = file.replace('.json', '');
        try {
          const raw = await fs.readFile(path.join(localesDir, file), 'utf-8');
          result[lang] = JSON.parse(raw);
        } catch (err) {
          logger.warn(`Failed to load locale file: ${file}`, { error: err });
        }
      }
    } catch {
      // locales 目录不存在，跳过
    }
    return result;
  }
}
