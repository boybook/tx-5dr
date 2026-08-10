let processShuttingDown = false;
let newMutationsBlocked = false;

export class ShutdownDeadlineError extends Error {
  constructor(
    public readonly operation: string,
    public readonly deadlineMs: number,
  ) {
    super(`${operation} exceeded shutdown deadline of ${deadlineMs}ms`);
    this.name = 'ShutdownDeadlineError';
  }
}

export async function awaitWithShutdownDeadline<T>(
  operation: string,
  task: Promise<T>,
  deadlineMs: number,
): Promise<T> {
  const boundedDeadlineMs = Math.max(1, Math.floor(deadlineMs));
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ShutdownDeadlineError(operation, boundedDeadlineMs));
        }, boundedDeadlineMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function markProcessShuttingDown(): void {
  processShuttingDown = true;
  newMutationsBlocked = true;
}

export function isProcessShuttingDown(): boolean {
  return processShuttingDown;
}

export function blockNewMutations(): void {
  newMutationsBlocked = true;
}

export function areNewMutationsBlocked(): boolean {
  return newMutationsBlocked;
}

export function allowNewMutationsForTests(): void {
  processShuttingDown = false;
  newMutationsBlocked = false;
}
