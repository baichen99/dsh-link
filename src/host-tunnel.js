import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';
import { CHUNK_BYTES, MAX_BODY_BYTES, base64, unbase64, encryptionKey, peer, targetPath } from './wire.js';

export function connectHost({ hub, authToken, enckey, fetch: dispatch, openStream, onStatus, onRevoked, onRecover }) {
  const url = new URL('/daemon-tunnel', hub);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', authToken);
  let stopped = false, socket, retry, attempt = 0;
  const tunnels = new Map();
  const key = encryptionKey(enckey);
  const closeTunnel = (id) => {
    const tunnel = tunnels.get(id);
    if (!tunnel) return;
    tunnels.delete(id);
    for (const request of tunnel.requests.values()) request.controller.abort();
    tunnel.requests.clear();
  };
  const start = () => {
    if (stopped) return;
    onStatus('connecting');
    const ws = socket = new WebSocket(url, { maxPayload: 256 * 1024, handshakeTimeout: 15_000 });
    const send = text => new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 2 * 1024 * 1024) return reject(new Error('Tunnel unavailable'));
      ws.send(text, error => error ? reject(error) : resolve());
    });
    ws.on('open', () => {
      attempt = 0;
      void send(JSON.stringify({ type: 'register', daemonVersion: 'dsh-agentlink/0.1.0', runtime: 'dsh' })).catch(() => ws.close());
      onStatus('connected');
    });
    ws.on('error', () => onStatus('reconnecting'));
    let reading = Promise.resolve();
    ws.on('message', raw => {
      reading = reading.then(async () => {
        const text = raw.toString();
        if (text.startsWith('{')) {
          const control = JSON.parse(text);
          if (control.type === 'enckey_upload_request') { await onRecover(); return; }
          if (control.type === 'tunnel_close') { closeTunnel(control.tunnelId); return; }
          if (control.type !== 'tunnel_attach' || typeof control.tunnelId !== 'string' || tunnels.size >= 16) return;
          const id = control.tunnelId;
          if (tunnels.has(id)) throw new Error('Duplicate tunnel');
          const channel = peer(await key, value => send(`${id} ${value}`), randomBytes(24).toString('base64url'));
          const tunnel = { channel, requests: new Map() };
          tunnels.set(id, tunnel);
          await channel.send({ type: 'ready' });
          return;
        }
        const space = text.indexOf(' ');
        const id = text.slice(0, space);
        const tunnel = tunnels.get(id);
        if (!tunnel) return;
        try {
          const message = await tunnel.channel.read(text.slice(space + 1));
          receive(tunnel, message);
        } catch {
          closeTunnel(id);
          await send(JSON.stringify({ type: 'tunnel_close', tunnelId: id, code: 4403, reason: 'invalid DSH frame' }));
        }
      }).catch(() => ws.close(1008, 'invalid control frame'));
    });
    function receive(tunnel, message) {
      const { id, type } = message;
      if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) throw new Error('Invalid request id');
      const current = tunnel.requests.get(id);
      if (type === 'cancel') { current?.controller.abort(); tunnel.requests.delete(id); return; }
      if (type === 'ack') { current?.ack?.(); return; }
      if (type === 'body' && current && !current.started) {
        const bytes = unbase64(message.data);
        current.bytes += bytes.length;
        if (bytes.length > CHUNK_BYTES || current.bytes > MAX_BODY_BYTES) throw new Error('Request body too large');
        current.parts.push(bytes);
        void tunnel.channel.send({ id, type: 'ack' }).catch(() => ws.close());
        return;
      }
      if (type === 'end' && current && !current.started) { current.started = true; void run(tunnel, id, current); return; }
      if (type !== 'request' || current || tunnel.requests.size >= 32) throw new Error('Invalid request');
      if (!['GET', 'HEAD', 'POST', 'STREAM'].includes(message.method)) throw new Error('Invalid method');
      const path = targetPath(message.path);
      if (message.method === 'STREAM' && !path.startsWith('/api/')) throw new Error('Invalid stream');
      if (message.headers !== undefined && (!Array.isArray(message.headers) || message.headers.length > 32)) throw new Error('Invalid headers');
      const controller = new AbortController();
      const request = { controller, message: { ...message, path }, parts: [], bytes: 0, started: false };
      tunnel.requests.set(id, request);
      void tunnel.channel.send({ id, type: 'ack' }).catch(() => ws.close());
    }
    async function run(tunnel, id, request) {
      const { controller, message } = request;
      const sendItem = async value => {
        controller.signal.throwIfAborted();
        let timer, abort;
        const ack = new Promise((resolve, reject) => {
          const clean = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); request.ack = undefined; };
          request.ack = () => { clean(); resolve(); };
          abort = () => { clean(); reject(new Error('Cancelled')); };
          timer = setTimeout(() => { clean(); reject(new Error('Consumer timed out')); }, 30_000);
          controller.signal.addEventListener('abort', abort, { once: true });
        });
        // Register the waiter before sending; consume both failures immediately.
        await Promise.all([tunnel.channel.send({ ...value, id }), ack]);
      };
      try {
        const body = request.bytes ? Buffer.concat(request.parts) : undefined;
        request.parts.length = 0;
        if (message.method === 'STREAM') {
          const payload = body ? JSON.parse(body.toString('utf8')) : {};
          for await (const value of await openStream(message.path.slice(5), payload, controller.signal)) {
            const bytes = Buffer.from(JSON.stringify(value));
            if (bytes.length > MAX_BODY_BYTES) throw new Error('Stream item too large');
            for (let i = 0; i < bytes.length; i += CHUNK_BYTES) await sendItem({ type: 'chunk', data: base64(bytes.subarray(i, i + CHUNK_BYTES)) });
            await sendItem({ type: 'item' });
          }
        } else {
          // Credentials/authority are carrier-owned and never forwarded from a browser.
          const headers = new Headers(message.headers);
          for (const name of [...headers.keys()]) if (!['content-type', 'accept', 'range'].includes(name)) headers.delete(name);
          const response = await dispatch(new Request(`http://dsh.internal${message.path}`, { method: message.method, headers, body, signal: controller.signal }));
          await tunnel.channel.send({ id, type: 'headers', status: response.status, headers: [...response.headers].filter(([name]) => !['set-cookie', 'content-length', 'content-encoding'].includes(name)) });
          if (response.body) {
            const reader = response.body.getReader();
            const cancel = () => { void reader.cancel().catch(() => {}); };
            controller.signal.addEventListener('abort', cancel, { once: true });
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                for (let i = 0; i < value.length; i += CHUNK_BYTES) await sendItem({ type: 'chunk', data: base64(value.subarray(i, i + CHUNK_BYTES)) });
              }
            } finally { controller.signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); }
          }
        }
        await tunnel.channel.send({ id, type: 'end' });
      } catch {
        if (!controller.signal.aborted) await tunnel.channel.send({ id, type: 'error', error: 'DSH request failed' }).catch(() => {});
      } finally {
        controller.abort();
        tunnel.requests.delete(id);
      }
    }
    ws.on('close', (code) => {
      for (const id of tunnels.keys()) closeTunnel(id);
      if (stopped) return;
      if ([4401, 4403].includes(code)) { stopped = true; onStatus('revoked'); void onRevoked(); return; }
      if ([4408, 4409].includes(code)) { stopped = true; onStatus('disconnected'); return; }
      onStatus('reconnecting');
      retry = setTimeout(start, Math.min(30_000, 500 * 2 ** Math.min(attempt++, 6)) * (0.5 + Math.random() / 2));
    });
  };
  start();
  return () => {
    stopped = true;
    clearTimeout(retry);
    for (const id of tunnels.keys()) closeTunnel(id);
    socket?.close();
  };
}
