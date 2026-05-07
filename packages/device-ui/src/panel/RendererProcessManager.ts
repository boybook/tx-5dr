import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeviceUiConfig } from '../config.js';

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const DEFAULT_FB = '/dev/fb1';
const DEFAULT_INPUT = '/dev/input/by-path/platform-fe204000.spi-cs-1-event';
const DEFAULT_CALIBRATION = '/var/lib/tx5dr/device-ui/calibration.json';

export class RendererProcessManager extends EventEmitter {
  #child?: ChildProcessWithoutNullStreams;
  #restarts = 0;
  #stopping = false;
  #restartTimer?: NodeJS.Timeout;
  #restartRequested = false;

  constructor(private readonly config: DeviceUiConfig) { super(); }

  start(): void {
    const command = this.resolveCommand();
    if (!command) {
      this.emit('mock', { socketPath: this.config.socketPath });
      return;
    }
    const env = {
      ...process.env,
      TX5DR_DEVICE_UI_SOCKET: this.config.socketPath,
      TX5DR_DEVICE_UI_FB: this.config.fbPath ?? DEFAULT_FB,
      TX5DR_DEVICE_UI_INPUT: this.config.inputPath ?? DEFAULT_INPUT,
      TX5DR_DEVICE_UI_CALIBRATION: this.config.calibrationPath ?? DEFAULT_CALIBRATION,
    };
    this.#child = spawn(command.bin, command.args, { env });
    this.#child.stdout.on('data', (chunk) => this.emit('stdout', String(chunk)));
    this.#child.stderr.on('data', (chunk) => this.emit('stderr', String(chunk)));
    this.#child.on('exit', (code, signal) => {
      this.emit('exit', { code, signal });
      this.#child = undefined;
      if (this.#stopping) return;
      if (this.#restartRequested) {
        this.#restartRequested = false;
        this.scheduleRestart(0);
        return;
      }
      if (code === 4) {
        this.emit('fatal', { code: 'fbdev-size-mismatch' });
        return;
      }
      this.scheduleRestart();
    });
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#child?.kill('SIGTERM');
  }

  restart(): void {
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
    if (this.#child && !this.#child.killed) {
      this.#restartRequested = true;
      this.#child.kill('SIGTERM');
      return;
    }
    this.scheduleRestart(0);
  }

  private scheduleRestart(delay = BACKOFF_MS[Math.min(this.#restarts, BACKOFF_MS.length - 1)]): void {
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restarts += 1;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      this.start();
    }, delay);
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
      if (profile.renderer === 'tx5dr-panel-oled') {
        return { bin: this.resolveNativeBinary('tx5dr-panel-oled'), args: ['--backend=png', `--profile=${profile.id}`, `--socket=${this.config.socketPath}`] };
      }
      return {
        bin: this.resolveNativeBinary('tx5dr-panel-lvgl'),
        args: [
          '--backend=fbdev',
          `--profile=${profile.id}`,
          `--socket=${this.config.socketPath}`,
          `--fb=${this.config.fbPath ?? DEFAULT_FB}`,
          `--input=${this.config.inputPath ?? DEFAULT_INPUT}`,
          `--calibration=${this.config.calibrationPath ?? DEFAULT_CALIBRATION}`,
        ],
      };
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
