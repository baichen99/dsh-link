import { CHUNK_BYTES, MAX_BODY_BYTES, base64, unbase64, encryptionKey, peer, targetPath } from './wire.js';

export async function connectBrowser({ hub, machineId, enckey, onClose = () => {}, WebSocketClass = WebSocket }) {
  const key = await encryptionKey(enckey);
  const url = new URL('/tunnel', hub);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('machineId', machineId);
  url.searchParams.set('purpose', 'dsh');
  const socket = new WebSocketClass(url);
  const requests = new Map();
  let closed = false, resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timer = setTimeout(() => fail(new Error('DSH 连接超时。')), 15_000);
  const channel = peer(key, text => {
    if (socket.readyState !== 1 || socket.bufferedAmount > 2 * 1024 * 1024) throw new Error('DSH 连接已断开。');
    socket.send(text);
  });
  function fail(error) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    rejectReady(error);
    for (const request of requests.values()) request.fail(error);
    requests.clear();
    socket.close();
    onClose(error);
  }
  let reading = Promise.resolve();
  socket.addEventListener('message', event => {
    reading = reading.then(async () => {
      const message = await channel.read(typeof event.data === 'string' ? event.data : await event.data.text());
      if (message.type === 'ready') { clearTimeout(timer); resolveReady(); return; }
      requests.get(message.id)?.receive(message);
    }).catch(() => fail(new Error('DSH 加密通道校验失败。')));
  });
  socket.addEventListener('close', event => fail(new Error(`DSH 连接已断开（${event.code}：${event.reason || '连接关闭'}），请重新连接。`)));
  socket.addEventListener('error', () => fail(new Error('无法连接 DSH 中继。')));
  const send = message => channel.send(message).catch(error => { fail(error); throw error; });

  async function request(path, method, body, headers, signal) {
    await ready;
    signal?.throwIfAborted();
    if (closed) throw new Error('DSH 连接已断开。');
    if (body.length > MAX_BODY_BYTES) throw new Error('上传不能超过 16 MiB。');
    if (requests.size >= 32) throw new Error('DSH 并发请求过多。');
    path = targetPath(path);
    const id = crypto.randomUUID();
    let resolveHeaders, rejectHeaders, controller, ack, pending, wake, error, ended = false;
    const response = new Promise((resolve, reject) => { resolveHeaders = resolve; rejectHeaders = reject; });
    // Attach a rejection handler while the upload is in progress.
    void response.catch(() => {});
    const chunks = [];
    let itemBytes = 0;
    const clean = () => { signal?.removeEventListener('abort', abort); requests.delete(id); };
    const abort = () => {
      state.fail(signal?.reason ?? new Error('Request cancelled'));
      void send({ id, type: 'cancel' }).catch(() => {});
    };
    const state = {
      fail(cause) {
        if (ended) return;
        ended = true; error = cause;
        rejectHeaders(cause);
        try { controller?.error(cause); } catch {}
        ack?.reject(cause); wake?.(); clean();
      },
      receive(message) {
        if (message.type === 'ack') { ack?.resolve(); ack = undefined; return; }
        if (message.type === 'error') { state.fail(new Error(message.error)); return; }
        if (message.type === 'headers') {
          const stream = new ReadableStream({
            start(value) { controller = value; },
            pull() { if (pending) { pending = false; void send({ id, type: 'ack' }).catch(() => {}); } },
            cancel() { abort(); },
          }, { highWaterMark: 0 });
          const body = message.encoding === 'gzip' ? stream.pipeThrough(new DecompressionStream('gzip')) : stream;
          resolveHeaders(new Response([101, 204, 205, 304].includes(message.status) || method === 'HEAD' ? null : body, { status: message.status, headers: message.headers }));
        } else if (message.type === 'chunk') {
          const bytes = unbase64(message.data);
          if (bytes.length > CHUNK_BYTES) throw new Error('Oversized DSH chunk');
          if (method === 'STREAM') {
            itemBytes += bytes.length;
            if (itemBytes > MAX_BODY_BYTES) throw new Error('Oversized stream item');
            chunks.push(bytes);
            void send({ id, type: 'ack' }).catch(() => {});
          } else {
            if (!controller) throw new Error('Missing response headers');
            pending = true;
            controller.enqueue(bytes);
            // If a reader is waiting, enqueue fulfills it without another pull.
            if (pending && controller.desiredSize >= 0) { pending = false; void send({ id, type: 'ack' }).catch(() => {}); }
          }
        } else if (message.type === 'item') { pending = true; wake?.(); }
        else if (message.type === 'end') { ended = true; controller?.close(); wake?.(); clean(); }
        else throw new Error('Unknown response frame');
      },
    };
    requests.set(id, state);
    signal?.addEventListener('abort', abort, { once: true });
    async function upload(value) {
      let timeout;
      const waiting = new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('DSH 上传超时。')), 30_000);
        ack = { resolve, reject };
      });
      try { await Promise.all([send({ ...value, id }), waiting]); }
      finally { clearTimeout(timeout); }
    }
    try {
      await upload({ type: 'request', path, method, headers, compression: typeof DecompressionStream === 'function' ? 'gzip' : undefined });
      for (let i = 0; i < body.length; i += CHUNK_BYTES) await upload({ type: 'body', data: base64(body.subarray(i, i + CHUNK_BYTES)) });
      await send({ id, type: 'end' });
    } catch (cause) { state.fail(cause); void send({ id, type: 'cancel' }).catch(() => {}); throw cause; }
    if (method !== 'STREAM') return response;
    return (async function* () {
      try {
        while (true) {
          if (!pending && !ended) await new Promise(resolve => { wake = resolve; });
          wake = undefined;
          if (error) throw error;
          if (pending) {
            const bytes = new Uint8Array(itemBytes);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
            chunks.length = 0; itemBytes = 0; pending = false;
            yield JSON.parse(new TextDecoder().decode(bytes));
            await send({ id, type: 'ack' });
          } else if (ended) break;
        }
      } finally { if (!ended) abort(); }
    })();
  }
  await ready;
  return {
    async fetch(input, init = {}) {
      const url = new URL(String(input), 'http://dsh.internal');
      // ponytail: buffered uploads cap at 16 MiB; use streaming uploads when larger files are required.
      const body = init.body == null ? new Uint8Array() : new Uint8Array(await new Response(init.body).arrayBuffer());
      return request(url.pathname + url.search, init.method ?? 'GET', body, [...new Headers(init.headers)], init.signal);
    },
    async *openStream(endpoint, payload, signal) {
      const stream = await request(`/api/${endpoint}`, 'STREAM', new TextEncoder().encode(JSON.stringify(payload)), [], signal);
      yield* stream;
    },
    close() { fail(new Error('DSH 连接已关闭。')); },
  };
}

// Only this parent-side adapter handles keys. The opaque iframe receives a
// MessagePort exposing the already-authenticated DSH carrier, never account APIs.
export async function mountViewer(iframe, options) {
  options.onProgress?.('正在连接 DSH…');
  const transport = await connectBrowser(options);
  let finishBoot;
  const booted = new Promise((resolve, reject) => { finishBoot = { resolve, reject }; });
  void booted.catch(() => {});
  const bootTimer = setTimeout(() => {
    finishBoot.reject(new Error('DSH 启动超时，请确认本机 DSH 可正常打开，再重新连接。'));
    dispose();
  }, 60_000);
  const controller = new AbortController();
  const active = new Map();
  const ports = new MessageChannel();
  let stopped = false;
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(bootTimer);
    finishBoot.reject(new Error('DSH 连接已取消。'));
    controller.abort();
    for (const request of active.values()) request.controller.abort();
    active.clear();
    ports.port1.close(); ports.port2.close();
    transport.close();
    iframe.removeAttribute('src');
  };
  options.signal?.addEventListener('abort', dispose, { once: true });
  ports.port1.onmessage = async ({ data }) => {
    const { id, type } = data ?? {};
    if (type === 'viewer-ready') { clearTimeout(bootTimer); finishBoot.resolve(); return; }
    if (type === 'viewer-error') { finishBoot.reject(new Error('DSH 原生插件启动失败，请检查本机 DSH 后重新连接。')); return; }
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) return;
    if (type === 'cancel') { active.get(id)?.controller.abort(); return; }
    if (type === 'ack') { active.get(id)?.ack?.(); return; }
    if (type !== 'request' || active.has(id) || active.size >= 32) return;
    const state = { controller: new AbortController() };
    active.set(id, state);
    const post = value => ports.port1.postMessage({ ...value, id });
    const deliver = async value => {
      let timer, abort;
      await new Promise((resolve, reject) => {
        const clean = () => { clearTimeout(timer); state.controller.signal.removeEventListener('abort', abort); state.ack = undefined; };
        state.ack = () => { clean(); resolve(); };
        abort = () => { clean(); reject(new Error('Cancelled')); };
        state.controller.signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(abort, 30_000);
        post(value);
      });
    };
    try {
      const path = targetPath(data.path);
      if (data.method === 'STREAM') {
        if (!path.startsWith('/api/')) throw new Error('Invalid stream');
        for await (const value of transport.openStream(path.slice(5), data.payload, state.controller.signal)) await deliver({ type: 'item', value });
      } else {
        const response = await transport.fetch(path, { ...data.init, signal: state.controller.signal });
        post({ type: 'headers', status: response.status, headers: [...response.headers] });
        if (response.body) for await (const bytes of response.body) await deliver({ type: 'chunk', bytes });
      }
      post({ type: 'end' });
    } catch { post({ type: 'error', error: 'DSH 请求失败，请检查连接。' }); }
    finally { active.delete(id); state.controller.abort(); }
  };
  try {
    options.signal?.throwIfAborted();
    options.onProgress?.('正在下载 DSH 界面…');
    const response = await transport.fetch('/agentlink/bootstrap', { signal: controller.signal });
    if (!response.ok) throw new Error('无法加载 DSH 界面。');
    let html;
    try { html = await response.text(); }
    catch { throw new Error('DSH 启动页传输中断，请重新连接。'); }
    if (stopped || options.signal?.aborted) { dispose(); return dispose; }
    iframe.setAttribute('sandbox', 'allow-scripts allow-downloads');
    iframe.referrerPolicy = 'no-referrer';
    const load = () => { if (!stopped) iframe.contentWindow.postMessage({ type: 'dsh-agentlink-start', html }, '*', [ports.port2]); };
    iframe.addEventListener('load', load, { once: true });
    options.onProgress?.('正在启动 DSH 插件…');
    iframe.src = new URL('/api/dsh/frame', options.hub).toString();
    if (response.headers.get('x-dsh-viewer-ready') === '1') await booted;
    else clearTimeout(bootTimer); // Older plugins have no ready notification.
    return () => { iframe.removeEventListener('load', load); options.signal?.removeEventListener('abort', dispose); dispose(); };
  } catch (error) { dispose(); throw error; }
}
