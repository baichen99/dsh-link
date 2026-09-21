import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, createDecipheriv, hkdfSync } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { connectHost } from '../src/host-tunnel.js';
import { connectBrowser } from '../src/browser.js';
import { encryptionKey, encrypt, decrypt, peer, targetPath } from '../src/wire.js';
import { normalizeHub } from '../src/account.js';

test('AgentLink envelopes interoperate; tampering, replay and unsafe paths fail closed', async () => {
  const secret = randomBytes(32).toString('base64url');
  const key = await encryptionKey(secret);
  const encrypted = await encrypt(key, { text: '中文与二进制', dsh: 1 });
  const { iv, ct } = JSON.parse(encrypted);
  const bytes = Buffer.from(ct, 'base64url');
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'base64url'), 'agentlink', 'e2e-v1', 32)), Buffer.from(iv, 'base64url'));
  cipher.setAuthTag(bytes.subarray(-16));
  assert.equal(JSON.parse(Buffer.concat([cipher.update(bytes.subarray(0, -16)), cipher.final()])).text, '中文与二进制');
  await assert.rejects(decrypt(await encryptionKey(randomBytes(32).toString('base64url')), encrypted));
  let frame;
  const host = peer(key, value => { frame = value; }, randomBytes(24).toString('base64url'));
  const client = peer(key, () => {});
  await host.send({ type: 'ready' });
  await client.read(frame);
  await assert.rejects(client.read(frame), /sequence/);
  const other = peer(key, () => {}, randomBytes(24).toString('base64url'));
  await assert.rejects(other.read(frame), /session/);
  for (const path of ['//evil.test/api/x', '/api/agentlink/login', '/api/%61gentlink/login', '/api/../agentlink/logout', '/plugins/%2e%2e/secret', '/etc/passwd', '/api\\secret']) assert.throws(() => targetPath(path));
  assert.equal(targetPath('/plugins/??abc&rev=x'), '/plugins/??abc&rev=x');
  assert.throws(() => normalizeHub('http://example.com'));
  assert.equal(normalizeHub('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
});

test('encrypted fetch, large binary bodies, stream consumption/cancel and disconnect', { timeout: 15_000 }, async (t) => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const browsers = new Map();
  let daemon;
  wss.on('connection', (ws, req) => {
    if (req.url.startsWith('/daemon-tunnel')) {
      daemon = ws;
      ws.on('message', raw => {
        const text = raw.toString();
        if (text.startsWith('{')) return;
        const split = text.indexOf(' ');
        browsers.get(text.slice(0, split))?.send(text.slice(split + 1));
      });
    } else {
      const id = crypto.randomUUID();
      browsers.set(id, ws);
      daemon.send(JSON.stringify({ type: 'tunnel_attach', tunnelId: id }));
      ws.on('message', raw => daemon.send(`${id} ${raw.toString()}`));
      ws.on('close', () => { browsers.delete(id); if (daemon.readyState === 1) daemon.send(JSON.stringify({ type: 'tunnel_close', tunnelId: id })); });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const hub = `http://127.0.0.1:${server.address().port}`;
  const enckey = randomBytes(32).toString('base64url');
  let online;
  const connected = new Promise(resolve => { online = resolve; });
  let cancelled;
  const cancellation = new Promise(resolve => { cancelled = resolve; });
  const stop = connectHost({ hub, authToken: 'test-machine', enckey,
    onStatus: state => { if (state === 'connected') online(); }, onRevoked() {}, onRecover() {},
    fetch: async request => request.method === 'POST'
      ? new Response(await request.arrayBuffer(), { headers: { 'content-type': 'application/octet-stream' } })
      : new Response('真实响应 ✓'),
    async *openStream(endpoint, payload, signal) {
      assert.equal(endpoint, 'events'); assert.deepEqual(payload, { follow: true });
      try {
        yield { type: 'ready' };
        yield { text: '流式内容'.repeat(40_000) };
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      } finally { cancelled(); }
    },
  });
  t.after(() => { stop(); for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(); });
  await connected;
  const client = await connectBrowser({ hub, machineId: 'test-machine', enckey, WebSocketClass: WebSocket });
  t.after(() => client.close());
  assert.equal(await (await client.fetch('/api/hello')).text(), '真实响应 ✓');
  const binary = randomBytes(700_000);
  assert.deepEqual(Buffer.from(await (await client.fetch('/api/upload', { method: 'POST', body: binary })).arrayBuffer()), binary);
  const controller = new AbortController();
  const stream = client.openStream('events', { follow: true }, controller.signal);
  assert.deepEqual((await stream.next()).value, { type: 'ready' });
  assert.equal((await stream.next()).value.text.length, 160_000);
  controller.abort();
  await stream.return();
  await cancellation;
  await assert.rejects(client.fetch('/api/agentlink/login'), /local only/);
  client.close();
  await assert.rejects(client.fetch('/api/hello'), /关闭|断开/);
});
