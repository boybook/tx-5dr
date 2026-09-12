import { EventEmitter } from 'node:events';
import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import https from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForUrl } from '../httpReadiness.js';

class ResponseStub extends EventEmitter {
  resume = vi.fn(() => this);
  destroy = vi.fn(() => this);
  constructor(public statusCode: number) { super(); }
}

class RequestStub extends EventEmitter {
  end = vi.fn();
  destroy = vi.fn(() => {
    // Node emits an error when a timed-out request destroys its socket.
    this.emit('error', new Error('socket closed'));
    return this;
  });
}

describe('HTTP readiness retry lifetime', () => {
  const attempts: { request: RequestStub; respond: (status: number) => ResponseStub }[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    attempts.length = 0;
    const request = ((...args: unknown[]) => {
      const onResponse = args.find(arg => typeof arg === 'function') as (response: IncomingMessage) => void;
      const current = new RequestStub();
      attempts.push({
        request: current,
        respond(status) {
          const response = new ResponseStub(status);
          onResponse(response as unknown as IncomingMessage);
          return response;
        },
      });
      return current as unknown as ClientRequest;
    }) as typeof http.request;
    vi.spyOn(http, 'request').mockImplementation(request);
    vi.spyOn(https, 'request').mockImplementation(request);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([200, 302, 401, 404])('stops probing after status %i, including late socket events', async status => {
    const result = waitForUrl('http://127.0.0.1:8076/');
    const response = attempts[0].respond(status);
    await expect(result).resolves.toBe(true);
    expect(response.resume).toHaveBeenCalledOnce();
    expect(response.destroy).toHaveBeenCalledOnce();
    expect(attempts[0].request.destroy).toHaveBeenCalledOnce();
    attempts[0].request.emit('timeout');
    attempts[0].request.emit('error', new Error('late socket error'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries only once when a timeout also emits a socket error', async () => {
    const result = waitForUrl('http://127.0.0.1:8076/', 10_000, 300);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(attempts[0].request.destroy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(299);
    expect(attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toHaveLength(2);
    attempts[1].respond(200);
    await expect(result).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces the overall deadline even when a connection never emits an event', async () => {
    const result = waitForUrl('http://127.0.0.1:8076/', 1_200, 300);
    await vi.advanceTimersByTimeAsync(1_200);
    await expect(result).resolves.toBe(false);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].request.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries an unsuccessful response without waiting for its body to finish', async () => {
    const result = waitForUrl('http://127.0.0.1:8076/', 5_000, 100);
    const response = attempts[0].respond(503);
    expect(response.destroy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(attempts).toHaveLength(2);
    attempts[1].respond(200);
    await expect(result).resolves.toBe(true);
  });

  it('preserves HTTPS gateway probing, including path, query and local certificates', async () => {
    const result = waitForUrl('https://127.0.0.1:8443/health?ready=1');
    expect(https.request).toHaveBeenCalledWith(expect.objectContaining({
      hostname: '127.0.0.1', port: 8443, path: '/health?ready=1',
      rejectUnauthorized: false, agent: false,
    }), expect.any(Function));
    attempts[0].respond(200);
    await expect(result).resolves.toBe(true);
  });
});

describe('HTTP readiness with local sockets', () => {
  it('releases an unfinished response and sends no requests after succeeding', async () => {
    let count = 0;
    const server = http.createServer((_request, response) => {
      count++;
      response.writeHead(count === 1 ? 503 : 200);
      response.write('headers are available but the body remains open');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Local HTTP server has no port');
      await expect(waitForUrl(`http://127.0.0.1:${address.port}/`, 1_000, 20)).resolves.toBe(true);
      expect(count).toBe(2);
      await new Promise(resolve => setTimeout(resolve, 2_100));
      expect(count).toBe(2);
      const connections = await new Promise<number>((resolve, reject) => server.getConnections((error, total) => error ? reject(error) : resolve(total)));
      expect(connections).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
