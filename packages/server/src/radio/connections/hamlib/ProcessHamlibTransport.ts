import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { HamlibTransport, assertHamlibHostAvailable, trackHamlibHostRetirement, waitForHamlibHostRetirement } from './HamlibTransport.js';
import { HAMLIB_OPERATIONS, HamlibWorkerMessageSchema, decodeHamlibResult, deserializeHamlibError, type HamlibOperation } from './hamlib-protocol.js';
import { RadioError, RadioErrorCode } from '../../../utils/errors/RadioError.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('HamlibProcessTransport');
let hostSequence = 0;
let rebuildPending = false;
let rebuildCount = 0;
const CRITICAL_REQUESTS = new Set<HamlibOperation>(['setPTT', 'setFrequency', 'setMode', 'applyOperatingState', 'setPowerState', 'sendCWMessage', 'stopCWMessage', 'setSplitFreqMode']);

export function resolveHamlibWorkerEntry(): { path: string; execArgv: string[] } {
  const source = import.meta.url.endsWith('.ts');
  return { path: fileURLToPath(new URL(source ? './hamlib-worker-entry.ts' : './hamlib-worker-entry.js', import.meta.url)), execArgv: source ? ['--import', 'tsx'] : [] };
}

export interface HamlibProcessOptions {
  entry?: { path: string; execArgv: string[] };
  startupTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  shutdownGraceMs?: number;
}

function waitForExit(exit: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void exit.then(() => { clearTimeout(timer); resolve(true); });
  });
}

export class ProcessHamlibTransport extends HamlibTransport {
  readonly mode = 'process' as const;
  readonly generation = randomUUID();
  private readonly sequence = ++hostSequence;
  private child: ChildProcess | null = null;
  private startup: Promise<void> | null = null;
  private rejectStartup: ((error: Error) => void) | null = null;
  private exit: Promise<void> = Promise.resolve();
  private retirement: Promise<void> | null = null;
  private stopped = false;
  private ready = false;
  private failure: Error | null = null;
  private nextId = 0;
  private lastSeen = 0;
  private watcher: ReturnType<typeof setInterval> | null = null;
  private readonly activities = new Map<number, { deadline: number; operation: string }>();
  private readonly pending = new Map<number, { operation: HamlibOperation; resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(private readonly options: HamlibProcessOptions = {}) { super(); }

  get diagnostics(): Record<string, unknown> {
    return { executionMode: this.mode, pid: this.child?.pid, generation: this.generation, hostSequence: this.sequence, rebuildCount,
      currentOperation: [...this.activities.values()][0]?.operation ?? null, lastFailure: this.failure?.message ?? null };
  }

  private async start(): Promise<void> {
    await waitForHamlibHostRetirement();
    assertHamlibHostAvailable();
    if (this.stopped || this.failure) throw this.failure ?? new Error('Hamlib transport is closed');
    const entry = this.options.entry ?? resolveHamlibWorkerEntry();
    const child = fork(entry.path, [], { execArgv: entry.execArgv, serialization: 'advanced', silent: true,
      env: { ...process.env, TX5DR_HAMLIB_GENERATION: this.generation } });
    this.child = child;
    let confirmExit!: () => void;
    this.exit = new Promise(resolve => { confirmExit = resolve; });
    child.once('exit', (code, signal) => {
      confirmExit();
      if (!this.stopped) this.fail(new Error(`Hamlib worker exited: code=${code} signal=${signal}`));
    });
    child.once('error', error => { if (!child.pid) confirmExit(); this.fail(error); });
    child.stdout?.on('data', chunk => logger.debug('Hamlib worker stdout', { text: String(chunk).trim() }));
    child.stderr?.on('data', chunk => logger.warn('Hamlib worker stderr', { text: String(chunk).trim() }));
    this.lastSeen = performance.now();
    this.watcher = setInterval(() => this.checkProgress(), 100);
    this.watcher.unref();
    await new Promise<void>((resolve, reject) => {
      this.rejectStartup = reject;
      const timer = setTimeout(() => this.fail(new Error('Hamlib worker startup timed out')), this.options.startupTimeoutMs ?? 10000);
      child.on('message', input => {
        if (this.stopped || this.failure) return;
        const parsed = HamlibWorkerMessageSchema.safeParse(input);
        if (!parsed.success) { this.fail(new Error(`Invalid Hamlib worker message: ${parsed.error.message}`)); return; }
        const message = parsed.data;
        if (message.generation !== this.generation) return;
        this.lastSeen = performance.now();
        if (message.type === 'ready') {
          this.ready = true;
          if (rebuildPending) { rebuildCount++; rebuildPending = false; }
          clearTimeout(timer); this.rejectStartup = null; resolve();
        }
        else if (message.type === 'snapshot') {
          const activeIds = new Set(message.snapshot.activities.map(activity => activity.id));
          for (const id of this.activities.keys()) if (!activeIds.has(id)) this.activities.delete(id);
          for (const activity of message.snapshot.activities) {
            if (!this.activities.has(activity.id)) this.activities.set(activity.id, {
              operation: activity.operation, deadline: performance.now() + Math.max(0, activity.timeoutMs - Math.max(0, Date.now() - activity.startedAt)),
            });
          }
          this.emit('snapshot', message.snapshot);
          if (message.snapshot.fault) this.fail(deserializeHamlibError(message.snapshot.fault));
        } else if (message.type === 'event') this.emit('event', message.payload);
        else if (message.type === 'fault') this.fail(deserializeHamlibError(message.error));
        else {
          const waiter = this.pending.get(message.id);
          if (!waiter) return;
          this.pending.delete(message.id);
          if (message.type === 'error') waiter.reject(deserializeHamlibError(message.error));
          else {
            try {
              if (message.operation !== waiter.operation) throw new Error('Hamlib result operation mismatch');
              waiter.resolve(decodeHamlibResult(message.operation, message.result));
            } catch (error) { waiter.reject(error as Error); this.fail(error as Error); }
          }
        }
      });
      void this.exit.then(() => clearTimeout(timer));
    });
  }

  private checkProgress(): void {
    if (this.stopped || this.failure || !this.ready) return;
    const now = performance.now();
    if (now - this.lastSeen > (this.options.heartbeatTimeoutMs ?? 5000)) {
      this.fail(new Error('Hamlib worker heartbeat timed out'));
      return;
    }
    for (const activity of this.activities.values()) {
      if (now > activity.deadline) { this.fail(new Error(`Hamlib native operation stalled: ${activity.operation}`)); return; }
    }
  }

  private fail(cause: Error): void {
    if (this.failure || this.stopped) return;
    rebuildPending = true;
    this.failure = new RadioError({ code: RadioErrorCode.CONNECTION_LOST, message: cause.message,
      userMessage: 'Hamlib worker stopped responding', userMessageKey: 'radio:error.hamlibHostFailed', cause,
      context: { ...this.diagnostics, hamlibHostFatal: true, stateUncertain: true } });
    this.rejectStartup?.(this.failure);
    this.rejectStartup = null;
    for (const waiter of this.pending.values()) waiter.reject(this.failure);
    this.pending.clear();
    this.retirement = this.terminate();
    trackHamlibHostRetirement(this.retirement);
    void this.retirement.catch(error => {
      logger.error('Hamlib worker exit could not be confirmed; refusing another host', { error: String(error) });
    });
    this.emit('fault', this.failure);
  }

  async call(operation: HamlibOperation, args: unknown[]): Promise<unknown> {
    HAMLIB_OPERATIONS[operation].args.parse(args);
    if (this.failure || this.stopped) throw this.failure ?? new Error('Hamlib transport is closed');
    this.startup ??= this.start();
    await this.startup;
    if (this.failure || this.stopped) throw this.failure ?? new Error('Hamlib transport is closed');
    if (this.pending.size >= (CRITICAL_REQUESTS.has(operation) ? 256 : 248)) throw new Error('Hamlib request limit reached');
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { operation, resolve, reject });
      this.child!.send({ type: 'call', generation: this.generation, id, operation, args }, error => { if (error) this.fail(error); });
    });
  }

  private async terminate(): Promise<void> {
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    if (await waitForExit(this.exit, this.options.shutdownGraceMs ?? 500)) return;
    child.kill('SIGKILL');
    if (!await waitForExit(this.exit, 2000)) throw new Error('Hamlib worker did not exit after SIGKILL');
  }

  async close(): Promise<void> {
    if (this.retirement) { await this.retirement; return; }
    this.stopped = true;
    const error = new Error('Hamlib transport closed');
    this.rejectStartup?.(error);
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.retirement = this.terminate();
    trackHamlibHostRetirement(this.retirement);
    await this.retirement;
    this.removeAllListeners();
  }
}
