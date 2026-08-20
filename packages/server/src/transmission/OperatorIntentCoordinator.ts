export type OperatorCommandSource = 'manual' | 'plugin' | 'late-decode' | 'slot-auto';

export interface OperatorCommandToken {
  operatorId: string;
  epoch: number;
  source: OperatorCommandSource;
  priority: number;
}

export type OperatorIntentOutcome<T> =
  | { status: 'completed'; token: OperatorCommandToken; value: T }
  | { status: 'superseded'; token: OperatorCommandToken };

interface IntentJob<T = unknown> {
  token: OperatorCommandToken;
  controller: AbortController;
  run: (token: OperatorCommandToken, signal: AbortSignal) => T | Promise<T>;
  resolve: (outcome: OperatorIntentOutcome<T>) => void;
  reject: (error: unknown) => void;
  completion: Promise<void>;
}

interface OperatorLane {
  nextEpoch: number;
  authoritativeEpoch: number;
  active?: IntentJob;
  pending?: IntentJob;
  takeover?: Promise<void>;
}

const PRIORITY: Record<OperatorCommandSource, number> = {
  'slot-auto': 10,
  'late-decode': 20,
  plugin: 90,
  manual: 100,
};

/** Serializes operator mutations while letting newer, higher-priority intent revoke stale work. */
export class OperatorIntentCoordinator {
  private readonly lanes = new Map<string, OperatorLane>();

  constructor(
    private readonly options: {
      abortGraceMs?: number;
      onAbortTimeout?: (token: OperatorCommandToken) => void;
    } = {},
  ) {}

  submit<T>(
    operatorId: string,
    source: OperatorCommandSource,
    run: (token: OperatorCommandToken, signal: AbortSignal) => T | Promise<T>,
  ): Promise<OperatorIntentOutcome<T>> {
    const lane = this.getLane(operatorId);
    const token: OperatorCommandToken = {
      operatorId,
      epoch: ++lane.nextEpoch,
      source,
      priority: PRIORITY[source],
    };

    return new Promise<OperatorIntentOutcome<T>>((resolve, reject) => {
      const job: IntentJob<T> = {
        token,
        controller: new AbortController(),
        run,
        resolve,
        reject,
        completion: Promise.resolve(),
      };
      this.enqueue(lane, job as IntentJob);
    });
  }

  isCurrent(token: OperatorCommandToken): boolean {
    return this.lanes.get(token.operatorId)?.authoritativeEpoch === token.epoch;
  }

  getCurrentEpoch(operatorId: string): number {
    return this.getLane(operatorId).authoritativeEpoch;
  }

  abortOperator(operatorId: string, reason: string): number {
    const lane = this.getLane(operatorId);
    const epoch = ++lane.nextEpoch;
    lane.authoritativeEpoch = epoch;
    if (lane.pending) {
      lane.pending.resolve({ status: 'superseded', token: lane.pending.token });
      lane.pending = undefined;
    }
    lane.active?.controller.abort(reason);
    return epoch;
  }

  removeOperator(operatorId: string, reason = 'operator removed'): void {
    this.abortOperator(operatorId, reason);
    this.lanes.delete(operatorId);
  }

  clear(reason = 'intent coordinator cleared'): void {
    for (const operatorId of this.lanes.keys()) this.abortOperator(operatorId, reason);
    this.lanes.clear();
  }

  private enqueue(lane: OperatorLane, job: IntentJob): void {
    const active = lane.active;
    if (!active) {
      this.start(lane, job);
      return;
    }

    const supersedesActive = job.token.priority >= active.token.priority;
    if (lane.pending) {
      if (lane.pending.token.priority > job.token.priority) {
        job.resolve({ status: 'superseded', token: job.token });
        return;
      }
      lane.pending.resolve({ status: 'superseded', token: lane.pending.token });
    }
    lane.pending = job;

    if (!supersedesActive) return;
    lane.authoritativeEpoch = job.token.epoch;
    active.controller.abort(`superseded by ${job.token.source} epoch ${job.token.epoch}`);
    this.ensureTakeover(lane, active);
  }

  private start(lane: OperatorLane, job: IntentJob): void {
    lane.active = job;
    lane.authoritativeEpoch = job.token.epoch;
    let execution: Promise<unknown>;
    try {
      execution = Promise.resolve(job.run(job.token, job.controller.signal));
    } catch (error) {
      execution = Promise.reject(error);
    }

    job.completion = execution.then(
      (value) => {
        if (this.isCurrent(job.token) && !job.controller.signal.aborted) {
          job.resolve({ status: 'completed', token: job.token, value });
        } else {
          job.resolve({ status: 'superseded', token: job.token });
        }
      },
      (error) => {
        if (job.controller.signal.aborted || !this.isCurrent(job.token)) {
          job.resolve({ status: 'superseded', token: job.token });
        } else {
          job.reject(error);
        }
      },
    ).finally(() => {
      if (lane.active !== job) return;
      lane.active = undefined;
      const next = lane.pending;
      lane.pending = undefined;
      if (next) this.start(lane, next);
    });
  }

  private ensureTakeover(lane: OperatorLane, active: IntentJob): void {
    if (lane.takeover) return;
    const abortGraceMs = this.options.abortGraceMs ?? 1_000;
    lane.takeover = Promise.race([
      active.completion.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), abortGraceMs)),
    ]).then((timedOut) => {
      if (!timedOut || lane.active !== active) return;
      this.options.onAbortTimeout?.(active.token);
      lane.active = undefined;
      const next = lane.pending;
      lane.pending = undefined;
      if (next) this.start(lane, next);
    }).finally(() => {
      lane.takeover = undefined;
      if (lane.active?.controller.signal.aborted && lane.pending) {
        this.ensureTakeover(lane, lane.active);
      }
    });
  }

  private getLane(operatorId: string): OperatorLane {
    let lane = this.lanes.get(operatorId);
    if (!lane) {
      lane = { nextEpoch: 0, authoritativeEpoch: 0 };
      this.lanes.set(operatorId, lane);
    }
    return lane;
  }
}
