import type { PluginDefinition } from '@tx5dr/plugin-api';
import type { PluginRuntimeLogEntry } from '@tx5dr/contracts';
import { PluginManifestSchema } from '@tx5dr/contracts';
import type { LoadedPlugin } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PluginLoader');
const ENTRY_FILE_CANDIDATES = ['plugin.js', 'plugin.mjs', 'index.js', 'index.mjs'] as const;

export interface PluginLoaderRuntimeLogEvent {
  stage: PluginRuntimeLogEntry['stage'];
  level: PluginRuntimeLogEntry['level'];
  message: string;
  pluginName?: string;
  directoryName?: string;
  details?: unknown;
}

type PluginLoaderRuntimeLogEmitter = (event: PluginLoaderRuntimeLogEvent) => void;

class PluginLoadError extends Error {
  readonly code: 'missing_entry' | 'import_error' | 'invalid_export' | 'validate_error';
  readonly details?: Record<string, unknown>;

  constructor(
    code: 'missing_entry' | 'import_error' | 'invalid_export' | 'validate_error',
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function validatePluginDefinition(def: PluginDefinition): void {
  const manifest = PluginManifestSchema.parse({
    name: def.name,
    version: def.version,
    type: def.type,
    instanceScope: def.instanceScope,
    description: def.description,
    permissions: def.permissions,
    settings: def.settings,
    quickActions: def.quickActions,
    quickSettings: def.quickSettings,
    panels: def.panels,
    storage: def.storage,
    ui: def.ui,
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

  const uiPageIds = new Set((manifest.ui?.pages ?? []).map((page) => page.id));
  for (const panel of manifest.panels ?? []) {
    if (panel.component !== 'iframe') {
      continue;
    }
    if (!panel.pageId) {
      throw new Error(`Iframe panel "${panel.id}" must declare pageId`);
    }
    if (!uiPageIds.has(panel.pageId)) {
      throw new Error(`Iframe panel "${panel.id}" references unknown ui page "${panel.pageId}"`);
    }
  }

  if (manifest.instanceScope === 'global') {
    if (manifest.type === 'strategy') {
      throw new Error('Global plugin instances are only supported for utility plugins');
    }
    for (const [key, setting] of Object.entries(manifest.settings ?? {})) {
      if (setting.scope === 'operator') {
        throw new Error(`Global plugin setting "${key}" must not use operator scope`);
      }
    }
    if ((manifest.quickSettings?.length ?? 0) > 0) {
      throw new Error('Global plugin instances must not declare quick settings');
    }
    if ((manifest.panels?.length ?? 0) > 0) {
      throw new Error('Global plugin instances must not declare operator-facing panels');
    }

    const hooks = def.hooks;
    const unsupportedGlobalHooks: Array<keyof NonNullable<PluginDefinition['hooks']>> = [
      'onAutoCallCandidate',
      'onConfigureAutoCallExecution',
      'onFilterCandidates',
      'onScoreCandidates',
      'onSlotStart',
      'onDecode',
      'onQSOStart',
      'onQSOComplete',
      'onQSOFail',
    ];
    const activeUnsupportedGlobalHook = unsupportedGlobalHooks.find((hookName) => typeof hooks?.[hookName] === 'function');
    if (activeUnsupportedGlobalHook) {
      throw new Error(`Global plugin instances must not implement hook "${activeUnsupportedGlobalHook}"`);
    }
  }
}

/**
 * 从文件系统扫描并加载用户插件
 * 每个子目录视为一个插件，入口文件为 plugin.js 或 index.js
 */
export class PluginLoader {
  constructor(private readonly emitRuntimeLog?: PluginLoaderRuntimeLogEmitter) {}

  async scanAndLoad(pluginDir: string): Promise<LoadedPlugin[]> {
    this.emitRuntimeLog?.({
      stage: 'scan',
      level: 'info',
      message: 'Scanning plugin directory',
      details: { pluginDir },
    });

    let entries: string[];
    try {
      const dirents = await fs.readdir(pluginDir, { withFileTypes: true });
      entries = dirents.filter(d => d.isDirectory()).map(d => d.name);
    } catch (err) {
      this.emitRuntimeLog?.({
        stage: 'scan',
        level: 'warn',
        message: 'Plugin directory is not accessible or does not exist',
        details: {
          pluginDir,
          error: this.getErrorMessage(err),
        },
      });
      logger.debug(`Plugin directory not found or empty: ${pluginDir}`);
      return [];
    }

    if (entries.length === 0) {
      this.emitRuntimeLog?.({
        stage: 'scan',
        level: 'info',
        message: 'No plugin directories found',
        details: { pluginDir },
      });
      return [];
    }

    const results: LoadedPlugin[] = [];
    for (const name of entries) {
      const dirPath = path.join(pluginDir, name);
      this.emitRuntimeLog?.({
        stage: 'load',
        level: 'info',
        message: 'Attempting to load plugin directory',
        directoryName: name,
        details: { dirPath },
      });
      try {
        const loaded = await this.loadPlugin(dirPath, name);
        results.push(loaded);
        logger.info(`Plugin loaded: ${loaded.definition.name} v${loaded.definition.version}`);
        this.emitRuntimeLog?.({
          stage: 'load',
          level: 'info',
          message: `Plugin loaded: ${loaded.definition.name} v${loaded.definition.version}`,
          pluginName: loaded.definition.name,
          directoryName: name,
          details: { dirPath },
        });
      } catch (err) {
        this.emitRuntimeLog?.(this.toFailureRuntimeLog(err, name, dirPath));
        logger.error(`Failed to load plugin from ${dirPath}`, err);
      }
    }
    return results;
  }

  private async loadPlugin(dirPath: string, directoryName: string): Promise<LoadedPlugin> {
    // 查找入口文件：plugin.js 优先，其次 index.js
    let entryPath: string | undefined;
    for (const candidate of ENTRY_FILE_CANDIDATES) {
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
      throw new PluginLoadError(
        'missing_entry',
        `No entry file found. Expected one of: ${ENTRY_FILE_CANDIDATES.join(', ')}`,
        {
          dirPath,
          directoryName,
          candidates: ENTRY_FILE_CANDIDATES,
        },
      );
    }

    // 动态加载 ESM 模块；附带 cache-busting 查询参数，确保 reload/rescan 真正拿到最新代码
    const entryUrl = pathToFileURL(path.resolve(entryPath));
    entryUrl.searchParams.set('ts5dr_reload', `${Date.now()}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mod: any;
    try {
      mod = await import(entryUrl.href);
    } catch (err) {
      throw new PluginLoadError(
        'import_error',
        'Failed to import plugin entry module (syntax/runtime import error)',
        {
          dirPath,
          directoryName,
          entryPath,
          error: this.getErrorMessage(err),
        },
      );
    }
    const definition: PluginDefinition = mod.default ?? mod;
    const definitionName = definition && typeof definition === 'object' && typeof (definition as { name?: unknown }).name === 'string'
      ? (definition as { name: string }).name
      : undefined;

    if (!definition || typeof definition !== 'object') {
      throw new PluginLoadError(
        'invalid_export',
        'Plugin entry must export a default PluginDefinition object',
        {
          dirPath,
          directoryName,
          entryPath,
        },
      );
    }

    try {
      validatePluginDefinition(definition);
    } catch (err) {
      throw new PluginLoadError(
        'validate_error',
        `Plugin definition validation failed: ${this.getErrorMessage(err)}`,
        {
          dirPath,
          directoryName,
          entryPath,
          pluginName: definitionName,
          error: this.getErrorMessage(err),
        },
      );
    }

    try {
      await this.validatePluginUiAssets(definition, dirPath);
    } catch (err) {
      throw new PluginLoadError(
        'validate_error',
        `Plugin UI assets validation failed: ${this.getErrorMessage(err)}`,
        {
          dirPath,
          directoryName,
          entryPath,
          pluginName: definitionName,
          error: this.getErrorMessage(err),
        },
      );
    }

    // 加载 i18n 资源
    const locales = await this.loadLocales(dirPath, directoryName, definition.name);

    return {
      definition,
      isBuiltIn: false,
      dirPath,
      locales: Object.keys(locales).length > 0 ? locales : undefined,
    };
  }
  private async loadLocales(
    dirPath: string,
    directoryName: string,
    pluginName: string,
  ): Promise<Record<string, Record<string, string>>> {
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
          this.emitRuntimeLog?.({
            stage: 'validate',
            level: 'warn',
            message: 'Failed to parse plugin locale file',
            pluginName,
            directoryName,
            details: {
              dirPath,
              file,
              error: this.getErrorMessage(err),
            },
          });
          logger.warn(`Failed to load locale file: ${file}`, { error: err });
        }
      }
    } catch {
      // locales 目录不存在，跳过
    }
    return result;
  }

  private async validatePluginUiAssets(
    definition: PluginDefinition,
    dirPath: string,
  ): Promise<void> {
    const pages = definition.ui?.pages ?? [];
    if (pages.length === 0) {
      return;
    }

    const uiDir = definition.ui?.dir ?? 'ui';
    for (const page of pages) {
      const entryPath = path.resolve(dirPath, uiDir, page.entry);
      try {
        await fs.access(entryPath);
      } catch {
        throw new Error(`UI page entry file not found for page "${page.id}": ${path.join(uiDir, page.entry)}`);
      }
    }
  }

  private toFailureRuntimeLog(
    err: unknown,
    directoryName: string,
    dirPath: string,
  ): PluginLoaderRuntimeLogEvent {
    if (err instanceof PluginLoadError) {
      const stage = err.code === 'validate_error' ? 'validate' : 'load';
      const pluginName = typeof err.details?.pluginName === 'string'
        ? err.details.pluginName
        : undefined;
      return {
        stage,
        level: 'error',
        message: err.message,
        pluginName,
        directoryName,
        details: {
          dirPath,
          ...(err.details ?? {}),
        },
      };
    }

    return {
      stage: 'load',
      level: 'error',
      message: 'Plugin loading failed with an unexpected error',
      directoryName,
      details: {
        dirPath,
        error: this.getErrorMessage(err),
      },
    };
  }

  private getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
