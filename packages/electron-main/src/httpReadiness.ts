import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import https from 'node:https';

const REQUEST_TIMEOUT_MS = 2_000;

function probeUrl(target: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    const timer = setTimeout(() => finish(false), timeoutMs);

    function finish(ready: boolean) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A readiness check owns its connection only until the response headers.
      // Close it even if the peer never finishes sending the response body.
      response?.destroy();
      request?.destroy();
      resolve(ready);
    }

    try {
      const url = new URL(target);
      const client = url.protocol === 'https:' ? https : http;
      request = client.request({
        hostname: url.hostname,
        port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false,
        ...(url.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
      }, incoming => {
        response = incoming;
        incoming.on('error', () => finish(false));
        incoming.resume();
        finish(Boolean(incoming.statusCode && incoming.statusCode >= 200 && incoming.statusCode < 500));
      });
      request.on('error', () => finish(false));
      request.end();
    } catch {
      finish(false);
    }
  });
}

/** Keep retries sequential, with no requests or retry timers after settlement. */
export async function waitForUrl(target: string, timeoutMs = 15_000, intervalMs = 300): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeUrl(target, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()))) return true;
    const delay = Math.min(intervalMs, deadline - Date.now());
    if (delay <= 0) return false;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  return false;
}
