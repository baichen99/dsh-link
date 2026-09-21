import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { Account } from '../src/account.js';

test('pairing exposes no key, persists before connecting, and preserves binding when revocation fails', { timeout: 5000 }, async t => {
  let saved, pairing, uploaded = false, revokeFails = true;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url.endsWith('/enckey')) {
      assert.ok(saved);
      assert.equal(JSON.parse(Buffer.concat(chunks)).enckey, saved.payload.enckey);
      assert.equal(req.headers.authorization, `Bearer ${saved.payload.authToken}`);
      uploaded = true; res.end('{}');
    } else {
      assert.equal(req.method, 'DELETE'); assert.equal(req.url, '/api/machines/self');
      res.writeHead(revokeFails ? 503 : 200).end('{}');
    }
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    if (req.url.startsWith('/daemon?')) { pairing = ws; ws.send(JSON.stringify({ type: 'pair_pending' })); }
    else { assert.ok(uploaded); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const account = new Account({ credentials: {
    readRecord: async () => saved,
    modifyRecord: async (key, change) => { assert.equal(key, 'agentlink/binding'); saved = change(saved); },
    deleteRecord: async () => { saved = undefined; },
  } }, { hubUrl: `http://127.0.0.1:${server.address().port}`, name: 'Test DSH' }, {});
  t.after(() => { account.dispose(); for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(); });
  await account.init();
  const pending = await account.login();
  assert.match(pending.loginUrl, /\/dsh\/authorize#code=[\w-]{32}$/);
  assert.ok(!pending.loginUrl.includes('enckey'));
  const payload = Buffer.from(JSON.stringify({ mid: 'test-machine' })).toString('base64url');
  pairing.send(JSON.stringify({ type: 'claimed', token: `al1.${payload}.test-signature` }));
  await new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (account.state === 'connected') resolve();
      else if (Date.now() - started > 2000) reject(new Error('Connection did not become ready'));
      else setTimeout(check, 10);
    }; check();
  });
  assert.equal(account.status().machineId, 'test-machine');
  assert.equal(JSON.stringify(account.status()).includes(saved.payload.enckey), false);
  await assert.rejects(account.logout(), /503/);
  assert.ok(saved, 'failed revocation retains credentials for retry');
  assert.equal(account.state, 'disconnected');
  revokeFails = false;
  await account.logout();
  assert.equal(saved, undefined);
  assert.equal(account.state, 'signed-out');
});
