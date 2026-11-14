/**
 * In-memory Storage used by CW characterization tests.
 *
 * Node 25+ exposes an experimental global `localStorage` that shadows jsdom's
 * implementation and is undefined without `--localstorage-file`, so each test
 * installs this stub with `vi.stubGlobal('localStorage', createStorageStub())`.
 */
export function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => { store.delete(key); },
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
  };
}
