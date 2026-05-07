import { describe, expect, it, vi } from 'vitest';
import { createInitialModel, DeviceUiStateStore } from '../DeviceUiStateStore.js';

describe('DeviceUiStateStore', () => {
  it('emits typed patches and defensive snapshots', () => {
    const store = new DeviceUiStateStore(createInitialModel({ deviceId: 'd', profileId: 'p' }));
    const patchSpy = vi.fn();
    store.on('patch', patchSpy);

    store.patch({ path: 'screen', value: 'monitor' });
    expect(store.getSnapshot().screen).toBe('monitor');
    expect(patchSpy).toHaveBeenCalledWith({ path: 'screen', value: 'monitor' }, 1, expect.objectContaining({ screen: 'monitor' }));

    const snapshot = store.getSnapshot();
    snapshot.screen = 'access';
    expect(store.getSnapshot().screen).toBe('monitor');
  });
});
