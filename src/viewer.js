// Runs inside an opaque sandbox. No credential, account cookie or key enters here.
import { targetPath } from './wire.js';
import { installDownloads } from './downloads.js';

globalThis.__DSH_AGENTLINK_VIEWER__ = true;
const requests = new Map();
let port;
const ready = new Promise(resolve => {
  if (window.__AGENTLINK_PORT__) {
    port = window.__AGENTLINK_PORT__;
    delete window.__AGENTLINK_PORT__;
    port.onmessage = ({ data }) => requests.get(data?.id)?.(data);
    resolve();
    return;
  }
  window.addEventListener('message', function receive(event) {
    if (event.source !== parent || event.data?.type !== 'dsh-agentlink-port' || !event.ports[0]) return;
    window.removeEventListener('message', receive);
    port = event.ports[0];
    port.onmessage = ({ data }) => requests.get(data?.id)?.(data);
    resolve();
  });
});

// Opaque frames have no origin storage; retain presentation state only for this view.
for (const name of ['localStorage', 'sessionStorage']) {
  const values = new Map();
  Object.defineProperty(window, name, { value: {
    getItem: key => values.get(String(key)) ?? null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: key => values.delete(String(key)), clear: () => values.clear(),
    key: index => [...values.keys()][index] ?? null, get length() { return values.size; },
  } });
}

async function open(path, init, stream = false) {
  await ready;
  const id = crypto.randomUUID();
  let resolve, reject, controller, pending = false, waiting, ended = false, failure, item;
  const response = new Promise((yes, no) => { resolve = yes; reject = no; });
  void response.catch(() => {});
  const send = type => port.postMessage({ id, type });
  const clean = () => { init.signal?.removeEventListener('abort', abort); requests.delete(id); };
  const abort = () => { send('cancel'); fail(new Error('Request cancelled')); };
  function fail(error) {
    if (ended) return;
    ended = true; failure = error;
    reject(error);
    try { controller?.error(error); } catch {}
    waiting?.(); clean();
  }
  init.signal?.throwIfAborted();
  init.signal?.addEventListener('abort', abort, { once: true });
  requests.set(id, message => {
    if (message.type === 'error') { fail(new Error(message.error)); return; }
    if (message.type === 'headers') {
      const body = new ReadableStream({
        start(value) { controller = value; },
        pull() { if (pending) { pending = false; send('ack'); } },
        cancel: abort,
      }, { highWaterMark: 0 });
      resolve(new Response([204, 205, 304].includes(message.status) || init.method === 'HEAD' ? null : body, { status: message.status, headers: message.headers }));
    } else if (message.type === 'chunk') {
      pending = true; controller.enqueue(message.bytes);
      if (pending && controller.desiredSize >= 0) { pending = false; send('ack'); }
    } else if (message.type === 'item') { item = message.value; pending = true; waiting?.(); }
    else if (message.type === 'end') { ended = true; controller?.close(); waiting?.(); clean(); }
  });
  if (stream) port.postMessage({ id, type: 'request', method: 'STREAM', path, payload: init.payload });
  else {
    const body = init.body == null ? undefined : await new Response(init.body).arrayBuffer();
    port.postMessage({ id, type: 'request', path, init: { method: init.method ?? 'GET', headers: [...new Headers(init.headers)], body } });
  }
  if (!stream) return response;
  return (async function* () {
    try {
      while (true) {
        if (!pending && !ended) await new Promise(resolve => { waiting = resolve; });
        waiting = undefined;
        if (failure) throw failure;
        if (pending) { pending = false; yield item; send('ack'); }
        else if (ended) break;
      }
    } finally { if (!ended) abort(); }
  })();
}

globalThis.fetch = async (input, init = {}) => {
  if (input instanceof Request) init = { method: input.method, headers: input.headers, body: ['GET', 'HEAD'].includes(input.method) ? undefined : await input.arrayBuffer(), signal: input.signal, ...init };
  const url = new URL(input instanceof Request ? input.url : String(input), 'http://dsh.internal');
  return open(targetPath(url.pathname + url.search), init);
};
globalThis.__DSH_FILE_UPLOAD__ = { fetch: globalThis.fetch };
async function loadBundle(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`DSH bundle unavailable (${response.status})`);
  const script = document.createElement('script');
  script.textContent = await response.text();
  document.head.append(script);
  script.remove();
}
globalThis.__DSH_TRANSPORT__ = {
  fetch: globalThis.fetch,
  async *openStream(endpoint, payload, signal) { yield* await open(`/api/${endpoint}`, { payload, signal }, true); },
  loadBundle,
};

// Convert native API image URLs to local blobs; the frame cannot access the network.
const blobs = new Set();
const images = new WeakMap();
new MutationObserver(records => {
  for (const record of records) {
    const nodes = record.type === 'attributes' ? [record.target] : [...record.addedNodes];
    for (const node of nodes) {
      if (!(node instanceof Element)) continue;
      for (const img of [node, ...node.querySelectorAll('img')]) {
        if (!(img instanceof HTMLImageElement)) continue;
        const src = img.getAttribute('src');
        if (!src?.startsWith('/api/') || images.get(img) === src) continue;
        images.set(img, src);
        void fetch(src).then(response => { if (!response.ok) throw new Error('Image unavailable'); return response.blob(); }).then(blob => {
          const url = URL.createObjectURL(blob); blobs.add(url);
          if (images.get(img) === src) img.src = url;
        }).catch(() => { img.alt ||= '图片加载失败'; });
      }
    }
  }
}).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });

installDownloads(window);

async function boot() {
await ready;
try {
  const markup = document.getElementById('dsh-injections').textContent;
  const parsed = new DOMParser().parseFromString(JSON.parse(markup), 'text/html');
  for (const node of parsed.querySelectorAll('script,style')) {
    if (node.tagName === 'SCRIPT' && node.hasAttribute('src')) await loadBundle(node.getAttribute('src'));
    else {
      const copy = document.createElement(node.tagName.toLowerCase());
      copy.textContent = node.textContent;
      document.head.append(copy);
    }
  }
  const root = document.getElementById('root');
  const started = new MutationObserver(() => {
    if (root.childElementCount && !root.querySelector('[data-dsh-boot]')) {
      started.disconnect();
      port.postMessage({ type: 'viewer-ready' });
    }
  });
  started.observe(root, { childList: true, subtree: true });
  await import('__DSH_NATIVE_ENTRY__');
} catch (error) {
  port.postMessage({ type: 'viewer-error' });
  console.error('DSH native boot failed', error);
  document.getElementById('root').textContent = 'DSH 界面加载失败，请返回机器列表重新连接。';
}

}
void boot();
