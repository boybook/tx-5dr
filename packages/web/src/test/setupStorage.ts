/**
 * Node 25+ ships its own Web Storage globals; without `--localstorage-file`
 * `localStorage` is undefined and shadows jsdom's implementation. Install an
 * in-memory Storage only when the runtime one is unusable, so tests behave the
 * same on every Node version (no effect where jsdom's storage works).
 */
class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  get length(): number { return this.items.size; }
  clear(): void { this.items.clear(); }
  getItem(key: string): string | null { return this.items.has(key) ? this.items.get(key)! : null; }
  key(index: number): string | null { return Array.from(this.items.keys())[index] ?? null; }
  removeItem(key: string): void { this.items.delete(key); }
  setItem(key: string, value: string): void { this.items.set(key, String(value)); }
}

function usable(name: 'localStorage' | 'sessionStorage'): boolean {
  try {
    const storage = (globalThis as Record<string, unknown>)[name] as Storage | undefined;
    return typeof storage?.getItem === 'function';
  } catch {
    return false;
  }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  if (usable(name)) continue;
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: storage });
  if (typeof window !== 'undefined' && window !== (globalThis as unknown)) {
    Object.defineProperty(window, name, { configurable: true, writable: true, value: storage });
  }
}
