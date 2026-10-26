import crypto from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

// Uploads use synchronous CLI calls. Do not reuse HTTP sockets whose close
// events cannot be processed while those calls block the Node event loop.
export async function readReleaseResource(url, format = 'sha256', retryDelayMs = 1000) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { connection: 'close' }, signal: AbortSignal.timeout(600000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status };
      }
      if (format === 'json') return { status: response.status, value: await response.json() };
      const hash = crypto.createHash('sha256');
      for await (const chunk of response.body) hash.update(chunk);
      return { status: response.status, sha256: hash.digest('hex') };
    } catch (error) {
      const code = error.cause?.code || error.code || '';
      const transient = /^(UND_ERR_|ECONNRESET|ETIMEDOUT|EAI_AGAIN)/.test(code) || error.name === 'TimeoutError';
      if (!transient || attempt === 2) throw error;
      await setTimeout(retryDelayMs * (attempt + 1));
    }
  }
}
