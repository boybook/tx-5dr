import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import { awaitServerReadyWithCleanup } from '../serverStartupCleanup.js';

describe('server startup cleanup', () => {
  it('kills and clears the server process when ready waiting fails', async () => {
    const process = { pid: 12345 } as ChildProcess;
    let serverProcess: ChildProcess | null = process;
    const killProcess = vi.fn().mockResolvedValue(undefined);

    await expect(awaitServerReadyWithCleanup({
      waitForServerReady: vi.fn().mockRejectedValue(new Error('server_ready_timeout')),
      getServerProcess: () => serverProcess,
      setServerProcess: (next) => {
        serverProcess = next;
      },
      killProcess,
    })).rejects.toThrow('server_ready_timeout');

    expect(killProcess).toHaveBeenCalledWith(process, 'server');
    expect(serverProcess).toBeNull();
  });

  it('does not kill the server process when ready waiting succeeds', async () => {
    const process = { pid: 12345 } as ChildProcess;
    let serverProcess: ChildProcess | null = process;
    const killProcess = vi.fn().mockResolvedValue(undefined);

    await expect(awaitServerReadyWithCleanup({
      waitForServerReady: vi.fn().mockResolvedValue({ httpPort: 4000 }),
      getServerProcess: () => serverProcess,
      setServerProcess: (next) => {
        serverProcess = next;
      },
      killProcess,
    })).resolves.toEqual({ httpPort: 4000 });

    expect(killProcess).not.toHaveBeenCalled();
    expect(serverProcess).toBe(process);
  });
});
