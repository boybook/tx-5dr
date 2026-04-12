import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PluginDevWatcher');

const DEBOUNCE_MS = 750;
const SCAN_INTERVAL_MS = 10_000;

/**
 * Watches plugin directories that contain a `.hotreload` marker file and
 * triggers a reload when their contents change.
 *
 * Inspired by the Obsidian hot-reload plugin. Only active in development
 * mode (`NODE_ENV !== 'production'`).
 *
 * How it works:
 * 1. On start, scans `{dataDir}/plugins/` for subdirectories with `.hotreload`
 * 2. Sets up `fs.watch` (recursive) on each such directory
 * 3. File changes are debounced — a reload fires 750ms after the last change
 * 4. Periodically re-scans to pick up newly-linked plugin directories
 */
export class PluginDevWatcher {
  private watchers = new Map<string, fs.FSWatcher>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private pluginsDir: string,
    private onReload: (pluginName: string) => Promise<void>,
  ) {}

  async start(): Promise<void> {
    if (!fs.existsSync(this.pluginsDir)) {
      logger.debug('Plugins directory does not exist, skipping dev watcher', { dir: this.pluginsDir });
      return;
    }

    await this.scan();

    this.scanTimer = setInterval(() => {
      void this.scan();
    }, SCAN_INTERVAL_MS);

    logger.info('Plugin dev watcher started', { dir: this.pluginsDir });
  }

  stop(): void {
    this.stopped = true;

    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    for (const [name, watcher] of this.watchers) {
      watcher.close();
      logger.debug('Stopped watching plugin', { name });
    }
    this.watchers.clear();

    logger.info('Plugin dev watcher stopped');
  }

  private async scan(): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.pluginsDir, { withFileTypes: true });
    } catch {
      return;
    }

    const hotreloadDirs = new Set<string>();

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(this.pluginsDir, entry.name);
      const markerPath = path.join(dirPath, '.hotreload');
      if (fs.existsSync(markerPath)) {
        hotreloadDirs.add(entry.name);
      }
    }

    // Start watching new directories
    for (const name of hotreloadDirs) {
      if (!this.watchers.has(name)) {
        this.watch(name);
      }
    }

    // Stop watching removed directories
    for (const name of this.watchers.keys()) {
      if (!hotreloadDirs.has(name)) {
        const watcher = this.watchers.get(name);
        watcher?.close();
        this.watchers.delete(name);
        const timer = this.debounceTimers.get(name);
        if (timer) {
          clearTimeout(timer);
          this.debounceTimers.delete(name);
        }
        logger.debug('Stopped watching removed plugin', { name });
      }
    }
  }

  private watch(pluginName: string): void {
    const dirPath = path.join(this.pluginsDir, pluginName);
    try {
      const watcher = fs.watch(dirPath, { recursive: true }, (_eventType, filename) => {
        if (this.stopped) return;
        // Ignore .hotreload marker changes and hidden files
        if (filename === '.hotreload' || filename?.startsWith('.')) return;

        // Debounce: reset timer on each change
        const existing = this.debounceTimers.get(pluginName);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(pluginName, setTimeout(() => {
          this.debounceTimers.delete(pluginName);
          logger.info('Plugin file changed, reloading', { pluginName, filename });
          this.onReload(pluginName).catch((err) => {
            logger.warn('Failed to reload plugin after file change', {
              pluginName,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }, DEBOUNCE_MS));
      });

      this.watchers.set(pluginName, watcher);
      logger.info('Watching plugin for changes (.hotreload)', { pluginName });

      watcher.on('error', (err) => {
        logger.warn('Watch error for plugin', {
          pluginName,
          error: err.message,
        });
        this.watchers.delete(pluginName);
      });
    } catch (err) {
      logger.warn('Failed to watch plugin directory', {
        pluginName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
