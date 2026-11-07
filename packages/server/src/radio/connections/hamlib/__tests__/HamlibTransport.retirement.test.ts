import { describe, expect, it } from 'vitest';
import { trackHamlibHostRetirement, waitForHamlibHostRetirement } from '../HamlibTransport.js';

describe('Hamlib host retirement', () => {
  it('refuses replacements until an unconfirmed retirement is later observed to exit', async () => {
    let exited!: () => void;
    const exit = new Promise<void>(resolve => { exited = resolve; });
    const retirement = Promise.reject(new Error('Hamlib worker did not exit after SIGKILL'));
    trackHamlibHostRetirement(retirement, exit);
    await expect(waitForHamlibHostRetirement()).rejects.toThrow('did not exit');
    exited();
    await exit;
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(waitForHamlibHostRetirement()).resolves.toBeUndefined();
  });
});
