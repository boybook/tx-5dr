import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeviceUiConfig } from '../config.js';

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

export class RendererProcessManager extends EventEmitter {
  #child?: ChildProcessWithoutNullStreams;
  #restarts = 0;
  #stopping = false;

  constructor(private readonly config: DeviceUiConfig) { super(); }

  start(): void {
    const command = this.resolveCommand();
    if (!command) {
      this.emit('mock', { socketPath: this.config.socketPath });
      return;
    }
    this.#child = spawn(command.bin, command.args, { env: { ...process.env, TX5DR_DEVICE_UI_SOCKET: this.config.socketPath } });
    this.#child.stdout.on('data', (chunk) => this.emit('stdout', String(chunk)));
    this.#child.stderr.on('data', (chunk) => this.emit('stderr', String(chunk)));
    this.#child.on('exit', (code, signal) => {
      this.emit('exit', { code, signal });
      if (!this.#stopping) this.scheduleRestart();
    });
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#child?.kill('SIGTERM');
  }

  restart(): void {
    this.#child?.kill('SIGTERM');
    this.scheduleRestart(0);
  }

  private scheduleRestart(delay = BACKOFF_MS[Math.min(this.#restarts, BACKOFF_MS.length - 1)]): void {
    this.#restarts += 1;
    setTimeout(() => this.start(), delay);
  }

  private resolveCommand(): { bin: string; args: string[] } | undefined {
    if (this.config.renderer === 'mock') return undefined;
    const profile = this.config.profile;
    if (this.config.renderer === 'tft-sdl') {
      return { bin: this.resolveNativeBinary('tx5dr-panel-lvgl'), args: ['--backend=sdl', `--profile=${profile.id}`, `--socket=${this.config.socketPath}`, '--hold-ms=86400000'] };
    }
    if (this.config.renderer === 'oled-sdl') {
      return { bin: this.resolveNativeBinary('tx5dr-panel-oled'), args: ['--backend=sdl', `--profile=${profile.id}`, '--scale=6', `--socket=${this.config.socketPath}`] };
    }
    if (this.config.renderer === 'native' || this.config.renderer === 'auto') {
      const bin = profile.renderer === 'tx5dr-panel-oled' ? 'tx5dr-panel-oled' : 'tx5dr-panel-lvgl';
      return { bin: this.resolveNativeBinary(bin), args: [`--profile=${profile.id}`, `--socket=${this.config.socketPath}`] };
    }
    return undefined;
  }

  private resolveNativeBinary(name: string): string {
    const here = dirname(fileURLToPath(import.meta.url));
    const sourceTreeCandidate = join(here, '..', '..', 'native', 'build', name, name);
    if (existsSync(sourceTreeCandidate)) return sourceTreeCandidate;
    const distCandidate = join(here, '..', 'native', 'build', name, name);
    if (existsSync(distCandidate)) return distCandidate;
    return name;
  }
}
