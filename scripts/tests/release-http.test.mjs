import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { readReleaseResource } from '../release-http.mjs';

test('restarts interrupted downloads and hashes only a complete response', async () => {
  let requests = 0;
  const body = 'complete immutable artifact';
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.connection, 'close');
    requests++;
    if (requests === 1) { req.socket.destroy(); return; }
    res.end(body);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const result = await readReleaseResource(`http://127.0.0.1:${server.address().port}`, 'sha256', 0);
    assert.equal(requests, 2);
    assert.equal(result.sha256, crypto.createHash('sha256').update(body).digest('hex'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('missing objects are returned once and permanent malformed metadata fails', async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    if (req.url === '/missing') { res.writeHead(404); res.end('missing'); }
    else res.end('invalid json');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await readReleaseResource(`${base}/missing`, 'sha256', 0), { status: 404 });
    await assert.rejects(readReleaseResource(base, 'json', 0), SyntaxError);
    assert.equal(requests, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
