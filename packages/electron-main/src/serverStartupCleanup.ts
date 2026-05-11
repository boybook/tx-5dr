import type { ChildProcess } from 'node:child_process';

export interface AwaitServerReadyWithCleanupOptions<TReady> {
  waitForServerReady: () => Promise<TReady>;
  getServerProcess: () => ChildProcess | null;
  setServerProcess: (process: ChildProcess | null) => void;
  killProcess: (process: ChildProcess, name: string) => Promise<unknown>;
  processName?: string;
}

export async function awaitServerReadyWithCleanup<TReady>(
  options: AwaitServerReadyWithCleanupOptions<TReady>,
): Promise<TReady> {
  try {
    return await options.waitForServerReady();
  } catch (error) {
    const serverProcess = options.getServerProcess();
    if (serverProcess) {
      await options.killProcess(serverProcess, options.processName ?? 'server').catch(() => undefined);
      if (options.getServerProcess() === serverProcess) {
        options.setServerProcess(null);
      }
    }
    throw error;
  }
}
