import path from 'node:path';
import { buildWindowsChildPath } from './vcRuntime.js';

export interface ChildRuntimeEnvOptions {
  platform?: NodeJS.Platform;
  resourcesRoot: string;
  triplet: string;
  currentEnv?: NodeJS.ProcessEnv;
  extraEnv?: Record<string, string>;
}

export interface NativeModuleCheckModuleResult {
  name: string;
  ok: boolean;
  error?: string;
}

export interface NativeModuleCheckResult {
  /** All required modules loaded successfully and script exited cleanly */
  success: boolean;
  /** Per-module results collected before the process exited */
  modules: NativeModuleCheckModuleResult[];
  /** Module that was being loaded when the process crashed (null if no crash) */
  crashedModule: string | null;
  /** Process exit code */
  exitCode: number | null;
  /** Signal that killed the process */
  signal: string | null;
  /** True if the check was aborted due to timeout */
  timeout: boolean;
}

export const DEGRADABLE_NATIVE_MODULES = new Set(['node-datachannel']);

function joinPathList(entries: Array<string | undefined>, separator: string): string {
  return entries.filter((entry): entry is string => Boolean(entry)).join(separator);
}

export function buildChildRuntimeEnv({
  platform = process.platform,
  resourcesRoot,
  triplet,
  currentEnv = process.env,
  extraEnv = {},
}: ChildRuntimeEnvOptions): NodeJS.ProcessEnv {
  const nativeDir = path.join(resourcesRoot, 'native');
  const baseEnv = {
    ...currentEnv,
    NODE_ENV: 'production',
    APP_RESOURCES: resourcesRoot,
    NODE_PATH: path.join(resourcesRoot, 'app', 'node_modules'),
  } as NodeJS.ProcessEnv;

  if (platform === 'win32') {
    baseEnv.PATH = buildWindowsChildPath(resourcesRoot, triplet, currentEnv.PATH || '');
  } else if (platform === 'darwin') {
    const wsjtxPrebuildDir = path.join(resourcesRoot, 'app', 'node_modules', 'wsjtx-lib', 'prebuilds', triplet);
    baseEnv.DYLD_LIBRARY_PATH = joinPathList([
      wsjtxPrebuildDir,
      nativeDir,
      currentEnv.DYLD_LIBRARY_PATH,
    ], ':');
  } else {
    baseEnv.LD_LIBRARY_PATH = joinPathList([
      nativeDir,
      currentEnv.LD_LIBRARY_PATH,
    ], ':');
  }

  return {
    ...baseEnv,
    ...extraEnv,
  } as NodeJS.ProcessEnv;
}

export function buildNativeModuleCheckExitResult({
  code,
  signal,
  modules,
  lastChecking,
  timeout = false,
}: {
  code: number | null;
  signal: string | null;
  modules: NativeModuleCheckModuleResult[];
  lastChecking: string | null;
  timeout?: boolean;
}): NativeModuleCheckResult {
  const failedModules = modules.filter((moduleResult) => !moduleResult.ok);
  const crashedModule = code !== 0 && lastChecking ? lastChecking : null;

  return {
    success: code === 0 && failedModules.length === 0,
    modules,
    crashedModule,
    exitCode: code,
    signal,
    timeout,
  };
}

export function isDegradableNativeModuleCheckFailure(result: NativeModuleCheckResult): boolean {
  if (result.success) {
    return false;
  }

  const failedModules = result.modules.filter((moduleResult) => !moduleResult.ok);
  if (result.crashedModule) {
    return DEGRADABLE_NATIVE_MODULES.has(result.crashedModule);
  }

  return failedModules.length > 0 && failedModules.every((moduleResult) => (
    DEGRADABLE_NATIVE_MODULES.has(moduleResult.name)
  ));
}
