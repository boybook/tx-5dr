export interface WorkerIpcChannel {
  readonly connected?: boolean;
  send?: (message: unknown, callback?: (error: Error | null) => void) => boolean;
  disconnect?: () => void;
}

export interface WorkerIpcSenderOptions {
  sendTimeoutMs?: number;
  onFailure?: (error: Error) => void;
}

const DEFAULT_SEND_TIMEOUT_MS = 30_000;

/** Serializes worker messages and waits for the final send acknowledgement before disconnecting. */
export class WorkerIpcSender<Message> {
  private tail: Promise<void> = Promise.resolve();
  private firstFailure?: Error;
  private closing = false;

  private readonly sendTimeoutMs: number;
  private readonly onFailure: (error: Error) => void;

  constructor(
    private readonly channel: WorkerIpcChannel = process,
    options: WorkerIpcSenderOptions = {},
  ) {
    this.sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    this.onFailure = options.onFailure ?? (() => {
      process.exitCode = 1;
    });
  }

  post(message: Message): void {
    if (this.closing) return;
    void this.enqueue(message).catch(error => this.abort(asError(error)));
  }

  async finish(message: Message): Promise<void> {
    if (this.closing) return;
    const finalSend = this.enqueue(message);
    this.closing = true;

    try {
      await finalSend;
    } catch (error) {
      this.reportFailure(asError(error));
    } finally {
      this.disconnect();
    }
  }

  private enqueue(message: Message): Promise<void> {
    const operation = this.tail.then(async () => {
      if (this.firstFailure) throw this.firstFailure;
      await this.sendWithAcknowledgement(message);
    });
    this.tail = operation.catch((error) => {
      this.firstFailure ??= asError(error);
    });
    return operation;
  }

  private sendWithAcknowledgement(message: Message): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.channel.send || this.channel.connected === false) {
        reject(new Error('Worker IPC channel is not connected'));
        return;
      }

      let settled = false;
      const timeout = setTimeout(() => {
        settle(new Error(`Worker IPC send was not acknowledged within ${this.sendTimeoutMs}ms`));
      }, this.sendTimeoutMs);
      const settle = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };

      try {
        this.channel.send(message, settle);
      } catch (error) {
        settle(asError(error));
      }
    });
  }

  private abort(error: Error): void {
    if (this.closing) return;
    this.closing = true;
    this.reportFailure(error);
    this.disconnect();
  }

  private reportFailure(error: Error): void {
    this.firstFailure ??= error;
    this.onFailure(this.firstFailure);
  }

  private disconnect(): void {
    if (this.channel.connected === false) return;
    try {
      this.channel.disconnect?.();
    } catch {
      // The parent may have closed the channel after receiving the final response.
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
