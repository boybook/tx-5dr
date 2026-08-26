import {
  PLUGIN_COMMAND_CAPABILITY_PERMISSIONS,
  type AnyPluginDefinition,
  type SimulationScenarioChoice,
  type SimulationScenarioDescriptor,
} from '@tx5dr/plugin-api';
import type { PluginPanelDescriptor, PluginRuntimeLogEntry, PluginUIPageDescriptor } from '@tx5dr/contracts';
import { PluginManifestSchema } from '@tx5dr/contracts';
import type { LoadedPlugin } from './types.js';
import type { Dirent } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { createLogger } from '../utils/logger.js';
import { validateArchiveRelativePath } from './path-security.js';

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

export function validatePluginDefinition(def: AnyPluginDefinition): void {
  const manifest = PluginManifestSchema.parse({
    apiVersion: def.apiVersion,
    name: def.name,
    version: def.version,
    type: def.type,
    strategyFeatures: def.strategyFeatures,
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
  const requiresCapabilityApiV2 = manifest.permissions?.some((permission) => (
    PLUGIN_COMMAND_CAPABILITY_PERMISSIONS.includes(
      permission as (typeof PLUGIN_COMMAND_CAPABILITY_PERMISSIONS)[number],
    )
  )) === true;
  if ((manifest.type === 'strategy' || requiresCapabilityApiV2)
      && manifest.apiVersion !== 2) {
    throw new Error('PLUGIN_API_INCOMPATIBLE: strategy and privileged command plugins require apiVersion: 2');
  }
  if (manifest.type === 'utility' && def.createStrategyRuntime !== undefined) {
    throw new Error('Utility plugins must not provide createStrategyRuntime(ctx)');
  }
  if (manifest.permissions?.includes('operator:transmit-control')) {
    if (manifest.instanceScope === 'global') {
      throw new Error('Plugins with permission "operator:transmit-control" must use operator instance scope');
    }
    if (typeof def.isTransmitControlEnabled !== 'function'
        && typeof def.isAutoCallEnabled !== 'function') {
      throw new Error('Plugins with permission "operator:transmit-control" must implement isTransmitControlEnabled(ctx) or isAutoCallEnabled(ctx)');
    }
  }

  validateSimulationScenarios(def);

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

  validatePluginUiPaths(manifest);

  const uiPageIds = new Set((manifest.ui?.pages ?? []).map((page) => page.id));
  const uiPageById = new Map((manifest.ui?.pages ?? []).map((page) => [page.id, page]));
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
    validateSpecialPanel(manifest, panel, uiPageById.get(panel.pageId));
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
    if ((manifest.panels ?? []).some((panel) => panel.slot !== 'radio-control-toolbar')) {
      throw new Error('Global plugin instances must not declare operator-facing panels');
    }

    const hooks = def.hooks;
    const unsupportedGlobalHooks: Array<keyof NonNullable<AnyPluginDefinition['hooks']>> = [
      'onAutoCallCandidate',
      'onConfigureAutoCallExecution',
      'onFilterCandidates',
      'onScoreCandidates',
      'onSlotStart',
      'onSlotActivity',
      'onDecode',
      'onFrequencyChange',
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

function deepFreezeDefinition<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeDefinition(child, seen);
  }
  return Object.freeze(value);
}

/** Creates the immutable, host-owned definition used after validation. */
export function canonicalizePluginDefinition(def: AnyPluginDefinition): AnyPluginDefinition {
  validatePluginDefinition(def);
  const manifest = PluginManifestSchema.parse({
    apiVersion: def.apiVersion,
    name: def.name,
    version: def.version,
    type: def.type,
    strategyFeatures: def.strategyFeatures,
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
  const canonical: AnyPluginDefinition = {
    ...manifest,
    permissions: manifest.permissions
      ? [...new Set(manifest.permissions)]
      : undefined,
    createStrategyRuntime: def.createStrategyRuntime,
    onLoad: def.onLoad,
    onUnload: def.onUnload,
    hooks: def.hooks ? { ...def.hooks } : undefined,
    isTransmitControlEnabled: def.isTransmitControlEnabled,
    isAutoCallEnabled: def.isAutoCallEnabled,
    simulationScenarios: def.simulationScenarios
      ? structuredClone(def.simulationScenarios)
      : undefined,
  };
  return deepFreezeDefinition(canonical);
}

function validateSimulationScenarios(def: AnyPluginDefinition): void {
  const scenarios = def.simulationScenarios ?? [];
  const scenarioIds = new Set<string>();
  for (const scenario of scenarios) {
    if (!scenario.id?.trim() || scenarioIds.has(scenario.id)) {
      throw new Error(`Simulation scenario id must be non-empty and unique: ${scenario.id ?? ''}`);
    }
    scenarioIds.add(scenario.id);
    if (scenario.modes.length === 0 || scenario.modes.some((mode) => mode !== 'FT8' && mode !== 'FT4')) {
      throw new Error(`Simulation scenario "${scenario.id}" must declare FT8 and/or FT4`);
    }
    if (!scenario.states[scenario.initialState]) {
      throw new Error(`Simulation scenario "${scenario.id}" references missing initial state "${scenario.initialState}"`);
    }
    for (const [stateId, state] of Object.entries(scenario.states)) {
      for (const rule of state.rules ?? []) {
        if (!rule.pattern || rule.pattern.length > 512) {
          throw new Error(`Simulation scenario "${scenario.id}" state "${stateId}" has an invalid pattern`);
        }
        try {
          void new RegExp(`^(?:${rule.pattern})$`, 'i');
        } catch (error) {
          throw new Error(`Simulation scenario "${scenario.id}" state "${stateId}" has an invalid pattern: ${(error as Error).message}`);
        }
        validateSimulationChoices(scenario.id, stateId, rule.choices, scenario.states);
      }
      for (const timeout of state.timeouts ?? []) {
        if (!Number.isInteger(timeout.afterReceiveCycles) || timeout.afterReceiveCycles < 1) {
          throw new Error(`Simulation scenario "${scenario.id}" state "${stateId}" has an invalid timeout`);
        }
        validateSimulationChoices(scenario.id, stateId, timeout.choices, scenario.states);
      }
    }
  }
}

function validateSimulationChoices(
  scenarioId: string,
  stateId: string,
  choices: SimulationScenarioChoice[],
  states: SimulationScenarioDescriptor['states'],
): void {
  if (choices.length === 0) {
    throw new Error(`Simulation scenario "${scenarioId}" state "${stateId}" has no choices`);
  }
  for (const choice of choices) {
    const actionCount = Number(Boolean(choice.reply))
      + Number(Boolean(choice.repeatLast))
      + Number(Boolean(choice.silence))
      + Number(Boolean(choice.complete));
    if (actionCount !== 1) {
      throw new Error(`Simulation scenario "${scenarioId}" state "${stateId}" choice must declare exactly one action`);
    }
    if (choice.weight !== undefined && (!Number.isFinite(choice.weight) || choice.weight <= 0)) {
      throw new Error(`Simulation scenario "${scenarioId}" state "${stateId}" has an invalid weight`);
    }
    if (choice.delayCycles !== undefined && (!Number.isInteger(choice.delayCycles) || choice.delayCycles < 1)) {
      throw new Error(`Simulation scenario "${scenarioId}" state "${stateId}" has an invalid delayCycles`);
    }
    if (choice.nextState && !states[choice.nextState]) {
      throw new Error(`Simulation scenario "${scenarioId}" references missing state "${choice.nextState}"`);
    }
  }
}

function validatePluginUiPaths(manifest: ReturnType<typeof PluginManifestSchema.parse>): void {
  if (!manifest.ui) {
    return;
  }

  try {
    validateArchiveRelativePath(manifest.ui.dir ?? 'ui');
  } catch {
    throw new Error(`Unsafe plugin UI directory: ${manifest.ui.dir ?? 'ui'}`);
  }

  for (const page of manifest.ui.pages ?? []) {
    try {
      validateArchiveRelativePath(page.entry);
    } catch {
      throw new Error(`Unsafe plugin UI page entry "${page.id}": ${page.entry}`);
    }
  }
}

function validateSpecialPanel(
  manifest: ReturnType<typeof PluginManifestSchema.parse>,
  panel: PluginPanelDescriptor,
  page: PluginUIPageDescriptor | undefined,
): void {
  if (panel.slot === 'operator-action') {
    if (manifest.instanceScope !== 'operator') {
      throw new Error('operator-action panels are only supported for operator-scoped plugins');
    }
    if (panel.openMode !== 'page') {
      throw new Error(`operator-action panel "${panel.id}" must use openMode "page"`);
    }
    if (page?.resourceBinding !== 'operator') {
      throw new Error(`operator-action panel "${panel.id}" must reference a UI page with resourceBinding "operator"`);
    }
    return;
  }
  if (panel.slot !== 'radio-control-toolbar') {
    return;
  }
  if (manifest.type !== 'utility' || manifest.instanceScope !== 'global') {
    throw new Error('radio-control-toolbar panels are only supported for global utility plugins');
  }
  if (page?.resourceBinding !== 'none') {
    throw new Error(`radio-control-toolbar panel "${panel.id}" must reference a UI page with resourceBinding "none"`);
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
      entries = [];
      for (const dirent of dirents) {
        if (await this.isPluginDirectoryEntry(pluginDir, dirent)) {
          entries.push(dirent.name);
        }
      }
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

  private async isPluginDirectoryEntry(pluginDir: string, dirent: Dirent): Promise<boolean> {
    if (dirent.isDirectory()) {
      return true;
    }
    if (!dirent.isSymbolicLink()) {
      return false;
    }

    try {
      const stat = await fs.stat(path.join(pluginDir, dirent.name));
      return stat.isDirectory();
    } catch (err) {
      logger.warn(`Failed to resolve plugin symlink: ${path.join(pluginDir, dirent.name)}`, err);
      return false;
    }
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
    const exportedDefinition: AnyPluginDefinition = mod.default ?? mod;
    const definitionName = exportedDefinition && typeof exportedDefinition === 'object' && typeof (exportedDefinition as { name?: unknown }).name === 'string'
      ? (exportedDefinition as { name: string }).name
      : undefined;

    if (!exportedDefinition || typeof exportedDefinition !== 'object') {
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

    let definition: AnyPluginDefinition;
    try {
      definition = canonicalizePluginDefinition(exportedDefinition);
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
    definition: AnyPluginDefinition,
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
