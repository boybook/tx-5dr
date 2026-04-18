import type { Socket } from 'node:net';
import { dispatchCommand, isSessionTerminator, type CommandContext } from './commands/index.js';
import { parseLine } from './protocol/parser.js';
import type { RigctldClientInfo, RigctldLogger } from './types.js';

/**
 * Factory producing a fresh `CommandContext` for every dispatched command. We
 * read `readOnly` through this hook rather than freezing it at session
 * construction, so a runtime toggle on the parent server (for example the
 * user flipping the UI switch) takes effect on the very next command across
 * all in-flight sessions.
 */
export type CommandContextProvider = () => CommandContext;

/**
 * One rigctld session bound to a single TCP socket.
 *
 * Responsibilities:
 *   - Line-buffered ingestion of the client's requests (rigctld is text over TCP;
 *     clients usually pipeline but we handle arbitrary fragmentation).
 *   - Sequential dispatch — commands for a given connection are never
 *     interleaved, matching Hamlib rigctld's behavior.
 *   - Back-pressure-free response write (short strings, no streaming).
 */
export class RigctldSession {
  readonly info: RigctldClientInfo;
  private buffer = '';
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly socket: Socket,
    private readonly getContext: CommandContextProvider,
    private readonly logger: RigctldLogger,
    private readonly events: {
      onCommand: (info: RigctldClientInfo, cmd: string, durationMs: number, ok: boolean) => void;
      onClose: (info: RigctldClientInfo) => void;
    },
    id: number,
  ) {
    this.info = {
      id,
      peer: `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 0}`,
      connectedAt: Date.now(),
    };

    socket.setNoDelay(true);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string | Buffer) => this.onData(String(chunk)));
    socket.on('error', (e) => this.logger.debug('rigctld socket error', { peer: this.info.peer, error: e.message }));
    socket.on('close', () => this.onClose());
  }

  private onData(chunk: string): void {
    // Trace the raw wire bytes so we can tell what clients like rigctl / N1MM
    // actually send (useful when the parsed command isn't what we'd expect).
    this.logger.debug('rigctld raw chunk', {
      peer: this.info.peer,
      bytes: JSON.stringify(chunk),
    });
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      this.enqueueLine(line);
    }
  }

  private enqueueLine(line: string): void {
    this.queue = this.queue.then(() => this.processLine(line)).catch((e) => {
      this.logger.error('rigctld session failure', { peer: this.info.peer, error: (e as Error).message });
    });
  }

  private async processLine(line: string): Promise<void> {
    if (this.closed) return;
    const commands = parseLine(line);
    for (const cmd of commands) {
      const started = Date.now();
      this.logger.debug('rigctld command received', { peer: this.info.peer, cmd: cmd.raw });
      let response: string;
      let success = true;
      try {
        response = await dispatchCommand(cmd, this.getContext());
      } catch (e) {
        success = false;
        this.logger.warn('rigctld dispatch error', {
          peer: this.info.peer,
          cmd: cmd.raw,
          error: (e as Error).message,
        });
        response = 'RPRT -5\n';
      }
      const durationMs = Date.now() - started;
      this.logger.debug('rigctld command handled', {
        peer: this.info.peer,
        cmd: cmd.raw,
        durationMs,
        ok: success,
      });
      this.info.lastCommand = cmd.raw;
      this.info.lastCommandAt = Date.now();
      this.events.onCommand(this.info, cmd.raw, durationMs, success);
      if (!this.writeResponse(response)) return;
      if (isSessionTerminator(cmd)) {
        this.close();
        return;
      }
    }
  }

  private writeResponse(data: string): boolean {
    if (this.closed || this.socket.destroyed) return false;
    try {
      this.logger.debug('rigctld raw response', {
        peer: this.info.peer,
        bytes: JSON.stringify(data),
      });
      this.socket.write(data);
      return true;
    } catch (e) {
      this.logger.debug('rigctld write failed', { peer: this.info.peer, error: (e as Error).message });
      return false;
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.events.onClose(this.info);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.end();
    this.socket.destroySoon?.();
    this.events.onClose(this.info);
  }
}
